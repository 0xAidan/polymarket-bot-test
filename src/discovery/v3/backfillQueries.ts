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
 * Phase B2 (BUCKET-LOCAL DEDUP load): INSERT the already-deduplicated rows
 * from a sorted bucket parquet into discovery_activity_v3. Dedup happens
 * inside this SELECT, reading only from the parquet; the target table has
 * NO indexes during backfill so there is no constraint maintenance and no
 * giant global CTAS.
 *
 * Correctness: the upstream 02a sort bucketizes by `abs(hash(tx_hash)) % N`,
 * so all copies of a given (tx_hash, log_index) key are guaranteed to live
 * in exactly ONE bucket. Per-bucket dedup is therefore mathematically
 * equivalent to global dedup. This is the same invariant that justified
 * per-bucket LAG dedup in the legacy `02b` path (see
 * `buildSortedParquetToActivitySql` + `CODEBASE_GUIDE.md#backfill`).
 *
 * Spill is bounded to ONE bucket's sort state (~1.1 GB parquet → ~14M rows
 * → a few GB of GROUP BY state on this hardware) instead of the 956M-row
 * global CTAS that exceeds the 75 GB temp budget.
 *
 * Previous single-bucket helper `buildSortedParquetToActivityRawSql` did no
 * dedup and required a separate global CTAS step in 02d; that CTAS blew the
 * temp-disk budget at production scale. This function replaces it.
 */
export function buildSortedParquetToActivityDedupedSql(sortedParquetPath: string): string {
  const escaped = sortedParquetPath.replace(/'/g, "''");
  return `
    INSERT INTO discovery_activity_v3
    WITH raw AS (
      SELECT
        "user"                                            AS proxy_wallet,
        market_id                                         AS market_id,
        condition_id                                      AS condition_id,
        event_id                                          AS event_id,
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
      FROM read_parquet('${escaped}')
    )
    SELECT
      arg_min(proxy_wallet, ts_unix) AS proxy_wallet,
      arg_min(market_id,    ts_unix) AS market_id,
      arg_min(condition_id, ts_unix) AS condition_id,
      arg_min(event_id,     ts_unix) AS event_id,
      MIN(ts_unix)                   AS ts_unix,
      arg_min(block_number, ts_unix) AS block_number,
      tx_hash,
      log_index,
      arg_min(role,         ts_unix) AS role,
      arg_min(side,         ts_unix) AS side,
      arg_min(price_yes,    ts_unix) AS price_yes,
      arg_min(usd_notional, ts_unix) AS usd_notional,
      arg_min(signed_size,  ts_unix) AS signed_size,
      arg_min(abs_size,     ts_unix) AS abs_size
    FROM raw
    GROUP BY tx_hash, log_index
  `;
}

/**
 * @deprecated Replaced by buildSortedParquetToActivityDedupedSql which dedupes
 * bucket-locally during load. Kept only for reference; do not use.
 *
 * Phase B2 (RAW bucket load): INSERT rows from a sorted bucket parquet into
 * discovery_activity_v3 WITHOUT dedup. Assumes the target table has NO
 * UNIQUE INDEX during the backfill load phase — indexes are rebuilt after
 * `buildActivityDedupCtasSql` in a separate step.
 *
 * This is the "no-index-during-load" path (final v3 fix, 2026-04-22). Prior
 * attempts tried to dedup during the bucket INSERT with either ROW_NUMBER
 * or GROUP BY + arg_min, but both paths hit DuckDB's over-eager unique-index
 * constraint-check bug when the aggregate/window operator streams into a
 * table with an active UNIQUE INDEX (see duckdb#11102, #16520). The error
 * fires on keys that only appear ONCE in the input — impossible by the SQL
 * semantics, but reproducible against DuckDB 1.4.x. Moving the dedup out
 * of the INSERT path sidesteps it entirely.
 *
 * Per-row transforms here are pure projection — no aggregation, no GROUP BY,
 * no index maintenance, so this runs at raw parquet scan speed.
 */
export function buildSortedParquetToActivityRawSql(sortedParquetPath: string): string {
  const escaped = sortedParquetPath.replace(/'/g, "''");
  return `
    INSERT INTO discovery_activity_v3
    SELECT
      "user"                                            AS proxy_wallet,
      market_id                                         AS market_id,
      condition_id                                      AS condition_id,
      event_id                                          AS event_id,
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
    FROM read_parquet('${escaped}')
  `;
}

/**
 * Phase B3 (DEDUP CTAS): build a deduplicated copy of discovery_activity_v3
 * into a new table. The winner per (tx_hash, log_index) is the row with the
 * smallest ts_unix — matches the prior arg_min(col, timestamp) semantics.
 *
 * Runs into a brand-new table with NO indexes, so DuckDB's upsert / unique
 * index code paths are never touched. Pure GROUP BY → CTAS, which DuckDB
 * handles cleanly at scale (proven locally at 14.5M rows with 2GB memory +
 * tight temp dir).
 */
export function buildActivityDedupCtasSql(): string {
  return `
    CREATE TABLE discovery_activity_v3_dedup AS
    SELECT
      arg_min(proxy_wallet, ts_unix) AS proxy_wallet,
      arg_min(market_id,    ts_unix) AS market_id,
      arg_min(condition_id, ts_unix) AS condition_id,
      arg_min(event_id,     ts_unix) AS event_id,
      MIN(ts_unix)                   AS ts_unix,
      arg_min(block_number, ts_unix) AS block_number,
      tx_hash,
      log_index,
      arg_min(role,         ts_unix) AS role,
      arg_min(side,         ts_unix) AS side,
      arg_min(price_yes,    ts_unix) AS price_yes,
      arg_min(usd_notional, ts_unix) AS usd_notional,
      arg_min(signed_size,  ts_unix) AS signed_size,
      arg_min(abs_size,     ts_unix) AS abs_size
    FROM discovery_activity_v3
    GROUP BY tx_hash, log_index
  `;
}

/**
 * Phase B4: atomically swap the dedup CTAS result over the raw table.
 */
export const ACTIVITY_DEDUP_SWAP_SQL: string[] = [
  `DROP TABLE discovery_activity_v3`,
  `ALTER TABLE discovery_activity_v3_dedup RENAME TO discovery_activity_v3`,
];

/**
 * @deprecated Replaced by buildSortedParquetToActivityRawSql +
 * buildActivityDedupCtasSql. Kept temporarily for reference and for the
 * v3-backfill-mapping test. Do NOT use for new backfill runs: fails with
 * spurious "Duplicate key" errors when target table has UNIQUE INDEX.
 */
export function buildSortedParquetToActivitySql(sortedParquetPath: string): string {
  const escaped = sortedParquetPath.replace(/'/g, "''");
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
    FROM read_parquet('${escaped}')
    GROUP BY transaction_hash, log_index
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
 *
 * Source-parquet schema note (SII-WANGZJ/Polymarket_data/markets.parquet,
 * verified 2026-04-23):
 *   - Primary key column is `id` (not `market_id`) — we alias it here so
 *     the activity table's `market_id` (ingested from users.parquet) joins
 *     cleanly against `markets_v3.market_id`.
 *   - Volume column is `volume` (not `volume_total`).
 *   - No native `market_id`/`volume_total` columns exist in this source.
 */
export function buildMarketsIngestSql({ sourceRef, limit }: MarketsIngestOptions): string {
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  return `
    INSERT INTO markets_v3
    SELECT
      id                                                        AS market_id,
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
      CAST(volume AS DOUBLE)                                    AS volume_total,
      TRY_CAST(created_at AS TIMESTAMP)                         AS created_at,
      TRY_CAST(end_date AS TIMESTAMP)                           AS end_date,
      TRY_CAST(updated_at AS TIMESTAMP)                         AS updated_at
    FROM ${sourceRef}
    WHERE id IS NOT NULL
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
    /* ORDER BY intentionally omitted — at 912M activity rows an
       INSERT…SELECT…ORDER BY forces DuckDB to fully materialize and sort
       the output, which spilled >55 GiB of temp on the 8GB Hetzner box.
       The PRIMARY KEY on discovery_feature_snapshots_v3 (proxy_wallet,
       snapshot_day) makes downstream reads order-agnostic, and 05/06
       apply their own ORDER BY when needed. */
  `;
}
