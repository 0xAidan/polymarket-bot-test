/**
 * SQL templates for the v3 backfill pipeline. Kept in src/ (not scripts/)
 * so they can be unit-tested with synthetic parquet fixtures.
 */

/**
 * Two-phase streaming ingest — the only path that works on 48GB parquet
 * with bounded memory.
 *
 * Phase A: parquet → staging_events_v3 (no window, no join, no casts).
 * Phase B: staging_events_v3 → discovery_activity_v3 via DISTINCT ON
 *          (streaming sort, spills cleanly to temp_dir).
 *
 * Avoids three things that pin memory and OOM DuckDB:
 *   1. ROW_NUMBER() OVER (PARTITION BY ...) across the full table
 *   2. WHERE NOT EXISTS correlated subquery (index lookup state)
 *   3. Multi-CTE pipelines (optimizer materializes intermediates)
 */
export function buildStagingCreateSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS staging_events_v3 (
      user             VARCHAR,
      market_id        VARCHAR,
      condition_id     VARCHAR,
      event_id         VARCHAR,
      timestamp        BIGINT,
      block_number     BIGINT,
      transaction_hash VARCHAR,
      log_index        INTEGER,
      role             VARCHAR,
      price            DOUBLE,
      usd_amount       DOUBLE,
      token_amount     DOUBLE
    )
  `;
}

export function buildStagingDropSql(): string {
  return `DROP TABLE IF EXISTS staging_events_v3`;
}

/**
 * Phase A: streaming INSERT from parquet into staging_events_v3.
 * No window function, no join, no cast — DuckDB can pipeline this.
 */
export function buildStagingIngestSql(sourceRef: string, limit?: number): string {
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  return `
    INSERT INTO staging_events_v3
    SELECT user, market_id, condition_id, event_id, timestamp, block_number,
           transaction_hash, log_index, role, price, usd_amount, token_amount
    FROM ${sourceRef}
    WHERE timestamp > 0
      AND usd_amount > 0
      AND token_amount <> 0
      AND transaction_hash IS NOT NULL
    ${limitClause}
  `;
}

/**
 * Phase B1: external merge sort staging_events_v3 → sorted parquet.
 *
 * DuckDB's COPY ... ORDER BY uses an external merge sort with bounded
 * memory and spill to temp_directory. This is the ONLY operation that
 * reliably sorts larger-than-memory data in DuckDB.
 *
 * ⚠️  At 900M+ rows this sort needs ~100 GB of spill space and will hit
 *    disk-cap OOMs on a 93 GB volume. Use buildStagingSortBucketToParquetSql
 *    instead for the real backfill; kept for tests and small runs.
 */
export function buildStagingSortToParquetSql(sortedParquetPath: string): string {
  const escaped = sortedParquetPath.replace(/'/g, "''");
  return `
    COPY (
      SELECT * FROM staging_events_v3
      ORDER BY transaction_hash, log_index, timestamp
    ) TO '${escaped}' (FORMAT PARQUET, COMPRESSION SNAPPY)
  `;
}

/**
 * Phase B1 (bucketed): external merge sort ONE hash bucket of
 * staging_events_v3 → one sorted parquet file.
 *
 * Why bucket: a single sort of 900M rows requires ~100 GB of spill, which
 * does not fit on the production volume alongside users.parquet + the staging
 * DB. Splitting on abs(hash(transaction_hash)) % totalBuckets lets each
 * bucket's sort state fit in a few GB.
 *
 * Correctness: all rows sharing the same transaction_hash land in the same
 * bucket (hash is deterministic), so per-bucket dedup on
 * (transaction_hash, log_index) is equivalent to global dedup.
 */
export function buildStagingSortBucketToParquetSql(
  bucketIdx: number,
  totalBuckets: number,
  sortedParquetPath: string
): string {
  if (!Number.isInteger(totalBuckets) || totalBuckets < 1) {
    throw new Error(`totalBuckets must be a positive integer, got ${totalBuckets}`);
  }
  if (!Number.isInteger(bucketIdx) || bucketIdx < 0 || bucketIdx >= totalBuckets) {
    throw new Error(`bucketIdx must be an integer in [0, ${totalBuckets}), got ${bucketIdx}`);
  }
  const escaped = sortedParquetPath.replace(/'/g, "''");
  return `
    COPY (
      SELECT * FROM staging_events_v3
      WHERE (abs(hash(transaction_hash)) % ${totalBuckets}) = ${bucketIdx}
      ORDER BY transaction_hash, log_index, timestamp
    ) TO '${escaped}' (FORMAT PARQUET, COMPRESSION SNAPPY)
  `;
}

/**
 * Phase B1 (parquet-direct, no staging table): sort ONE hash bucket read
 * STRAIGHT FROM users.parquet → one sorted parquet file.
 *
 * Why this exists: keeping the 49 GB staging_events_v3 table on the same 93
 * GB volume as users.parquet (48 GB) leaves only ~1 GB free for bucket
 * output and spill, which is not enough. Reading directly from parquet
 * skips the staging table entirely; DuckDB pushes the bucket filter into
 * the parquet scan, so each bucket only reads ~1/N of the file.
 *
 * Applies the same cleanup filters as buildStagingIngestSql to keep output
 * schema identical.
 */
export function buildSortBucketFromParquetToParquetSql(
  bucketIdx: number,
  totalBuckets: number,
  sourceParquetRef: string,
  sortedParquetPath: string,
  limit?: number
): string {
  if (!Number.isInteger(totalBuckets) || totalBuckets < 1) {
    throw new Error(`totalBuckets must be a positive integer, got ${totalBuckets}`);
  }
  if (!Number.isInteger(bucketIdx) || bucketIdx < 0 || bucketIdx >= totalBuckets) {
    throw new Error(`bucketIdx must be an integer in [0, ${totalBuckets}), got ${bucketIdx}`);
  }
  const escaped = sortedParquetPath.replace(/'/g, "''");
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  return `
    COPY (
      SELECT "user", market_id, condition_id, event_id, timestamp, block_number,
             transaction_hash, log_index, role, price, usd_amount, token_amount
      FROM ${sourceParquetRef}
      WHERE timestamp > 0
        AND usd_amount > 0
        AND token_amount <> 0
        AND transaction_hash IS NOT NULL
        AND (abs(hash(transaction_hash)) % ${totalBuckets}) = ${bucketIdx}
      ORDER BY transaction_hash, log_index, timestamp
      ${limitClause}
    ) TO '${escaped}' (FORMAT PARQUET, COMPRESSION SNAPPY)
  `;
}

/**
 * Phase B2: streaming INSERT from sorted parquet into discovery_activity_v3.
 *
 * Input parquet is pre-sorted by (transaction_hash, log_index, timestamp).
 * For dedup we use QUALIFY with ROW_NUMBER() partitioned by (tx, log_index).
 * Because the parquet is already sorted, DuckDB recognizes sorted input in
 * the window partition and uses a single-pass streaming window operator —
 * no full hash table build, no out-of-order LAG() bug from an empty OVER ()
 * clause (which produced duplicate primary keys in production).
 */
export function buildSortedParquetToActivitySql(sortedParquetPath: string): string {
  const escaped = sortedParquetPath.replace(/'/g, "''");
  return `
    INSERT INTO discovery_activity_v3
    SELECT
      proxy_wallet,
      market_id,
      condition_id,
      event_id,
      ts_unix,
      block_number,
      tx_hash,
      log_index,
      role,
      side,
      price_yes,
      usd_notional,
      signed_size,
      abs_size
    FROM (
      SELECT
        "user"                                            AS proxy_wallet,
        market_id,
        condition_id,
        event_id,
        CAST(timestamp AS UBIGINT)                        AS ts_unix,
        CAST(block_number AS UBIGINT)                     AS block_number,
        transaction_hash                                  AS tx_hash,
        CAST(log_index AS UINTEGER)                       AS log_index,
        LOWER(role)                                       AS role,
        CASE WHEN token_amount > 0 THEN 'BUY' ELSE 'SELL' END AS side,
        CAST(price AS DOUBLE)                             AS price_yes,
        CAST(usd_amount AS DOUBLE)                        AS usd_notional,
        CAST(token_amount AS DOUBLE)                      AS signed_size,
        ABS(CAST(token_amount AS DOUBLE))                 AS abs_size,
        ROW_NUMBER() OVER (
          PARTITION BY transaction_hash, log_index
          ORDER BY timestamp
        ) AS rn
      FROM read_parquet('${escaped}')
    ) q
    WHERE rn = 1
  `;
}

/**
 * @deprecated Phase B original GROUP BY path. Kept for tests only — fails at
 * scale when group count approaches row count (unique keys). Use
 * buildStagingSortToParquetSql + buildSortedParquetToActivitySql instead.
 */
export function buildStagingToActivitySql(): string {
  return `
    INSERT INTO discovery_activity_v3
    SELECT
      arg_min("user", timestamp)                        AS proxy_wallet,
      arg_min(market_id, timestamp)                     AS market_id,
      arg_min(condition_id, timestamp)                  AS condition_id,
      arg_min(event_id, timestamp)                      AS event_id,
      CAST(arg_min(timestamp, timestamp) AS UBIGINT)    AS ts_unix,
      CAST(arg_min(block_number, timestamp) AS UBIGINT) AS block_number,
      transaction_hash                                  AS tx_hash,
      CAST(log_index AS UINTEGER)                       AS log_index,
      LOWER(arg_min(role, timestamp))                   AS role,
      CASE WHEN arg_min(token_amount, timestamp) > 0 THEN 'BUY' ELSE 'SELL' END AS side,
      CAST(arg_min(price, timestamp) AS DOUBLE)         AS price_yes,
      CAST(arg_min(usd_amount, timestamp) AS DOUBLE)    AS usd_notional,
      CAST(arg_min(token_amount, timestamp) AS DOUBLE)  AS signed_size,
      ABS(CAST(arg_min(token_amount, timestamp) AS DOUBLE)) AS abs_size
    FROM staging_events_v3
    GROUP BY transaction_hash, log_index
  `;
}

/**
 * Build the INSERT that maps users.parquet → discovery_activity_v3.
 * Respects the schema quirks from the real dataset:
 *   - token_amount is signed (+buy / -sell)
 *   - token_amount == 0 means a non-fill event; skip
 *   - price is already YES-normalized
 *   - role values are lowercase ('maker' / 'taker')
 */
export function buildEventIngestSql(sourceRef: string, limit?: number): string {
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  return `
    INSERT OR IGNORE INTO discovery_activity_v3
    SELECT
      user                                              AS proxy_wallet,
      market_id,
      condition_id,
      event_id,
      CAST(timestamp AS UBIGINT)                        AS ts_unix,
      CAST(block_number AS UBIGINT)                     AS block_number,
      transaction_hash                                  AS tx_hash,
      CAST(log_index AS UINTEGER)                       AS log_index,
      LOWER(role)                                       AS role,
      CASE WHEN token_amount > 0 THEN 'BUY' ELSE 'SELL' END AS side,
      CAST(price AS DOUBLE)                             AS price_yes,
      CAST(usd_amount AS DOUBLE)                        AS usd_notional,
      CAST(token_amount AS DOUBLE)                      AS signed_size,
      ABS(CAST(token_amount AS DOUBLE))                 AS abs_size
    FROM ${sourceRef}
    WHERE timestamp > 0
      AND usd_amount > 0
      AND token_amount <> 0
      AND transaction_hash IS NOT NULL
    ${limitClause}
  `;
}

/**
 * DuckDB does not implement INSERT OR IGNORE for explicit unique indexes,
 * so we fall back to an anti-join against existing rows. Used when the
 * UNIQUE index on (tx_hash, log_index) would otherwise throw on re-ingest.
 */
export function buildEventIngestSqlAntiJoin(sourceRef: string, limit?: number): string {
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  return `
    INSERT INTO discovery_activity_v3
    WITH filtered AS (
      SELECT * FROM ${sourceRef}
      WHERE timestamp > 0
        AND usd_amount > 0
        AND token_amount <> 0
        AND transaction_hash IS NOT NULL
      ${limitClause}
    ),
    deduped AS (
      -- Dedupe within the source (users.parquet has a few repeated rows).
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY transaction_hash, log_index
          ORDER BY timestamp
        ) AS rn
        FROM filtered
      ) q
      WHERE rn = 1
    )
    SELECT
      user                                              AS proxy_wallet,
      market_id,
      condition_id,
      event_id,
      CAST(timestamp AS UBIGINT)                        AS ts_unix,
      CAST(block_number AS UBIGINT)                     AS block_number,
      transaction_hash                                  AS tx_hash,
      CAST(log_index AS UINTEGER)                       AS log_index,
      LOWER(role)                                       AS role,
      CASE WHEN token_amount > 0 THEN 'BUY' ELSE 'SELL' END AS side,
      CAST(price AS DOUBLE)                             AS price_yes,
      CAST(usd_amount AS DOUBLE)                        AS usd_notional,
      CAST(token_amount AS DOUBLE)                      AS signed_size,
      ABS(CAST(token_amount AS DOUBLE))                 AS abs_size
    FROM deduped src
    WHERE NOT EXISTS (
      SELECT 1 FROM discovery_activity_v3 a
      WHERE a.tx_hash = src.transaction_hash
        AND a.log_index = CAST(src.log_index AS UINTEGER)
    )
  `;
}

/**
 * Chunked variant of buildEventIngestSqlAntiJoin.
 *
 * The non-chunked version runs ROW_NUMBER() OVER (PARTITION BY tx_hash, log_index)
 * across the entire parquet, which materializes the whole sort state in temp
 * (44 GiB for users.parquet). This variant restricts the parquet scan to one
 * hash bucket at a time via hash(transaction_hash) % totalBuckets = bucketIdx,
 * so each chunk's window function only sees 1/N of the data.
 *
 * Call once per bucket in [0, totalBuckets). The anti-join against
 * discovery_activity_v3 still runs per chunk (so re-runs are safe), but each
 * chunk's temp footprint is ~(44 GiB / totalBuckets).
 */
export function buildEventIngestSqlAntiJoinChunked(
  sourceRef: string,
  bucketIdx: number,
  totalBuckets: number,
  limit?: number
): string {
  if (!Number.isInteger(totalBuckets) || totalBuckets < 1) {
    throw new Error(`totalBuckets must be a positive integer, got ${totalBuckets}`);
  }
  if (!Number.isInteger(bucketIdx) || bucketIdx < 0 || bucketIdx >= totalBuckets) {
    throw new Error(`bucketIdx must be an integer in [0, ${totalBuckets}), got ${bucketIdx}`);
  }
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  return `
    INSERT INTO discovery_activity_v3
    WITH filtered AS (
      SELECT * FROM ${sourceRef}
      WHERE timestamp > 0
        AND usd_amount > 0
        AND token_amount <> 0
        AND transaction_hash IS NOT NULL
        AND (abs(hash(transaction_hash)) % ${totalBuckets}) = ${bucketIdx}
      ${limitClause}
    ),
    deduped AS (
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY transaction_hash, log_index
          ORDER BY timestamp
        ) AS rn
        FROM filtered
      ) q
      WHERE rn = 1
    )
    SELECT
      user                                              AS proxy_wallet,
      market_id,
      condition_id,
      event_id,
      CAST(timestamp AS UBIGINT)                        AS ts_unix,
      CAST(block_number AS UBIGINT)                     AS block_number,
      transaction_hash                                  AS tx_hash,
      CAST(log_index AS UINTEGER)                       AS log_index,
      LOWER(role)                                       AS role,
      CASE WHEN token_amount > 0 THEN 'BUY' ELSE 'SELL' END AS side,
      CAST(price AS DOUBLE)                             AS price_yes,
      CAST(usd_amount AS DOUBLE)                        AS usd_notional,
      CAST(token_amount AS DOUBLE)                      AS signed_size,
      ABS(CAST(token_amount AS DOUBLE))                 AS abs_size
    FROM deduped src
    WHERE NOT EXISTS (
      SELECT 1 FROM discovery_activity_v3 a
      WHERE a.tx_hash = src.transaction_hash
        AND a.log_index = CAST(src.log_index AS UINTEGER)
    )
  `;
}

export interface MarketsIngestOptions {
  sourceRef: string;
  limit?: number;
}

/**
 * Parse Polymarket's Python-style outcome_prices string (e.g. "['0.53', '0.47']")
 * into a JSON array, then ingest into markets_v3.
 */
export function buildMarketsIngestSql({ sourceRef, limit }: MarketsIngestOptions): string {
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  return `
    INSERT INTO markets_v3
    SELECT
      market_id,
      condition_id,
      event_id,
      question,
      slug,
      token1,
      token2,
      answer1,
      answer2,
      CAST(closed AS UTINYINT)                                  AS closed,
      CAST(COALESCE(neg_risk, 0) AS UTINYINT)                   AS neg_risk,
      REPLACE(REPLACE(REPLACE(outcome_prices, '''None''', 'null'), 'None', 'null'), '''', '"') AS outcome_prices,
      CAST(volume_total AS DOUBLE)                              AS volume_total,
      TRY_CAST(created_at AS TIMESTAMP)                         AS created_at,
      TRY_CAST(end_date AS TIMESTAMP)                           AS end_date,
      TRY_CAST(updated_at AS TIMESTAMP)                         AS updated_at
    FROM ${sourceRef}
    WHERE market_id IS NOT NULL
    ${limitClause}
  `;
}

/**
 * Emit point-in-time feature snapshots.
 *
 * Rules (Invariant 4):
 *   - Only count events with ts_unix <= end_of_snapshot_day
 *   - PnL contributions require market.end_date <= snapshot_day
 *
 * Windowed implementation: only emit (wallet, day) pairs where the wallet had
 * >= 1 trade on that day. This keeps the row count proportional to activity,
 * not wallet_count * day_count.
 */
export function buildSnapshotEmitSql(): string {
  return `
    INSERT INTO discovery_feature_snapshots_v3
    WITH wallet_days AS (
      SELECT DISTINCT
        proxy_wallet,
        CAST(TO_TIMESTAMP(ts_unix) AS DATE) AS snapshot_day
      FROM discovery_activity_v3
    ),
    base AS (
      SELECT
        wd.proxy_wallet,
        wd.snapshot_day,
        CAST(EXTRACT(epoch FROM (wd.snapshot_day + INTERVAL 1 DAY)) AS UBIGINT) AS day_end_ts
      FROM wallet_days wd
    ),
    rolled AS (
      SELECT
        b.proxy_wallet,
        b.snapshot_day,
        COUNT(*)                              AS trade_count,
        SUM(a.usd_notional)                   AS volume_total,
        COUNT(DISTINCT a.market_id)           AS distinct_markets,
        MIN(a.ts_unix)                        AS first_active_ts,
        MAX(a.ts_unix)                        AS last_active_ts
      FROM base b
      JOIN discovery_activity_v3 a
        ON a.proxy_wallet = b.proxy_wallet
       AND a.ts_unix < b.day_end_ts
      GROUP BY b.proxy_wallet, b.snapshot_day
    ),
    closed AS (
      SELECT
        b.proxy_wallet,
        b.snapshot_day,
        COUNT(DISTINCT a.market_id)           AS closed_positions,
        SUM(
          CASE
            WHEN m.end_date IS NOT NULL
             AND CAST(m.end_date AS DATE) <= b.snapshot_day
            THEN a.usd_notional * (a.price_yes - 0.5)
            ELSE 0
          END
        )                                     AS realized_pnl
      FROM base b
      JOIN discovery_activity_v3 a
        ON a.proxy_wallet = b.proxy_wallet
       AND a.ts_unix < b.day_end_ts
      LEFT JOIN markets_v3 m ON m.market_id = a.market_id
      WHERE m.end_date IS NOT NULL
        AND CAST(m.end_date AS DATE) <= b.snapshot_day
      GROUP BY b.proxy_wallet, b.snapshot_day
    )
    SELECT
      r.proxy_wallet,
      r.snapshot_day,
      r.trade_count,
      r.volume_total,
      r.distinct_markets,
      COALESCE(c.closed_positions, 0)         AS closed_positions,
      COALESCE(c.realized_pnl, 0.0)           AS realized_pnl,
      0.0                                     AS unrealized_pnl,
      r.first_active_ts,
      r.last_active_ts,
      CAST(FLOOR((r.last_active_ts - r.first_active_ts) / 86400.0) AS INTEGER)
                                              AS observation_span_days
    FROM rolled r
    LEFT JOIN closed c
      ON c.proxy_wallet = r.proxy_wallet
     AND c.snapshot_day = r.snapshot_day
    ORDER BY r.proxy_wallet, r.snapshot_day
  `;
}
