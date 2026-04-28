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
      address          VARCHAR,
      market_id        VARCHAR,
      condition_id     VARCHAR,
      event_id         VARCHAR,
      timestamp        BIGINT,
      block_number     BIGINT,
      transaction_hash VARCHAR,
      log_index        INTEGER,
      role             VARCHAR,
      direction        VARCHAR,
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
    SELECT address, market_id, condition_id, event_id, timestamp, block_number,
           transaction_hash, log_index, role, direction, price, usd_amount, token_amount
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
      SELECT address, market_id, condition_id, event_id, timestamp, block_number,
             transaction_hash, log_index, role, direction, price, usd_amount, token_amount
      FROM ${sourceParquetRef}
      WHERE timestamp > 0
        AND usd_amount > 0
        AND token_amount <> 0
        AND transaction_hash IS NOT NULL
        AND address IS NOT NULL
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
        address                                           AS proxy_wallet,
        market_id                                         AS market_id,
        condition_id                                      AS condition_id,
        event_id                                          AS event_id,
        CAST(timestamp AS UBIGINT)                        AS ts_unix,
        CAST(block_number AS UBIGINT)                     AS block_number,
        transaction_hash                                  AS tx_hash,
        CAST(log_index AS UINTEGER)                       AS log_index,
        LOWER(role)                                       AS role,
        UPPER(direction)                                  AS side,
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
      address                                           AS proxy_wallet,
      market_id                                         AS market_id,
      condition_id                                      AS condition_id,
      event_id                                          AS event_id,
      CAST(timestamp AS UBIGINT)                        AS ts_unix,
      CAST(block_number AS UBIGINT)                     AS block_number,
      transaction_hash                                  AS tx_hash,
      CAST(log_index AS UINTEGER)                       AS log_index,
      LOWER(role)                                       AS role,
      UPPER(direction)                                  AS side,
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
      arg_min(address, timestamp)                       AS proxy_wallet,
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
      arg_min(address, timestamp)                       AS proxy_wallet,
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
      address                                           AS proxy_wallet,
      market_id,
      condition_id,
      event_id,
      CAST(timestamp AS UBIGINT)                        AS ts_unix,
      CAST(block_number AS UBIGINT)                     AS block_number,
      transaction_hash                                  AS tx_hash,
      CAST(log_index AS UINTEGER)                       AS log_index,
      LOWER(role)                                       AS role,
      UPPER(direction)                                  AS side,
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
      address                                           AS proxy_wallet,
      market_id,
      condition_id,
      event_id,
      CAST(timestamp AS UBIGINT)                        AS ts_unix,
      CAST(block_number AS UBIGINT)                     AS block_number,
      transaction_hash                                  AS tx_hash,
      CAST(log_index AS UINTEGER)                       AS log_index,
      LOWER(role)                                       AS role,
      UPPER(direction)                                  AS side,
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
      address                                           AS proxy_wallet,
      market_id,
      condition_id,
      event_id,
      CAST(timestamp AS UBIGINT)                        AS ts_unix,
      CAST(block_number AS UBIGINT)                     AS block_number,
      transaction_hash                                  AS tx_hash,
      CAST(log_index AS UINTEGER)                       AS log_index,
      LOWER(role)                                       AS role,
      UPPER(direction)                                  AS side,
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
 *   - PnL contributions are computed per (wallet, market) across all activity
 *
 * Windowed implementation: only emit (wallet, day) pairs where the wallet had
 * >= 1 trade on that day. This keeps the row count proportional to activity,
 * not wallet_count * day_count.
 *
 * ─── PnL FORMULA (2026-04-28 rewrite) ───────────────────────────────────────
 *
 * OLD (BROKEN): SUM(usd_notional × (price_yes − 0.5))
 *   - This was an approximation of "edge vs. coin flip", NOT real PnL.
 *   - It only produced values for resolved markets (joined on end_date).
 *   - It misses all swing-trade PnL in open markets.
 *
 * NEW (CORRECT): Cash-flow PnL
 *   realized_pnl = Σ(SELL proceeds) − Σ(BUY costs) + Σ(resolution payout)
 *
 * Implementation:
 *   1. cash_flow per trade row:
 *      - SELL: +usd_notional  (received USDC)
 *      - BUY:  -usd_notional  (spent USDC)
 *   2. token_balance per (wallet, market) = SUM(signed_size)
 *      - Positive = net long YES tokens
 *      - Negative = net short YES tokens
 *   3. resolution payout for CLOSED markets:
 *      - Parse outcome_prices JSON: first element is YES resolution price
 *        ("1.0" if YES wins, "0.0" if NO wins).
 *      - Payout = token_balance × resolution_price_yes
 *      - (For swing traders who exit before resolution, token_balance ≈ 0
 *        so this term contributes nothing — cash_flow alone captures their PnL)
 *   4. unrealized_pnl for OPEN markets:
 *      - = token_balance × last_trade_price_yes_for_that_market
 *      - "last trade price" = most recent price_yes from any wallet's trade
 *        in that market (the market's last observed trade price).
 *      - APPROXIMATION: stale if market hasn't traded recently.
 *
 * V1 vs V2 fees:
 *   - V1: fees were deducted in shares. signed_size is already net of fee.
 *     usd_notional is gross USDC. No extra adjustment needed.
 *   - V2 (ts_unix >= 1745827200, Apr 28 2026 07:00 UTC): fees are USDC at
 *     match time. The exchange contract deducts fees BEFORE emitting
 *     makerAmountFilled/takerAmountFilled, so usd_notional already reflects
 *     the net USDC exchanged. No extra adjustment needed.
 *   RESULT: The same formula works for both V1 and V2 rows.
 *
 * Works correctly for:
 *   - Buy-and-hold: cash_flow negative (spent USDC buying), + resolution payout
 *   - Swing trader: cash_flow is the net gain/loss, resolution payout ≈ 0
 *   - Market maker: same as swing (many buys and sells, net cash flow = edge)
 *   - Arb (YES + NO): each token tracked independently per market_id
 *   - Mixed (some closed, some open): closed get resolution, open get unrealized
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function buildSnapshotEmitSql(): string {
  // 2026-04-28 rewrite — correct cash-flow PnL:
  //
  // Shape:
  //   1) daily_activity: GROUP BY (wallet, day) for trade stats. Pure
  //      equality aggregation, spillable, no inequality join.
  //   2) wallet_market_pnl: per (wallet, market) cash-flow PnL + token balance.
  //      Joined to markets_v3 to add resolution price and end_date.
  //      This computes BOTH realized (for closed markets) and provides
  //      the token_balance needed for unrealized (for open markets).
  //   3) wallet_last_price: the most recent trade price per market_id across
  //      all wallets — used as the unrealized mark price.
  //   4) wallet_daily_pnl: roll up wallet_market_pnl into per (wallet, day)
  //      buckets using the market's end_date (for closed) or the wallet's
  //      last trade day on that market (for unrealized).
  //   5) merged + cumulative window: same as before.
  //
  // Memory note: wallet_market_pnl GROUP BY is O(unique wallet×market pairs)
  // which is ~10s of millions, not 912M rows. DuckDB hash-aggregates this
  // cleanly within the 6GB memory limit.
  return `
    INSERT INTO discovery_feature_snapshots_v3
    WITH
    -- Step 1: per-(wallet, market) aggregates: cash flow, token balance
    wallet_market_agg AS (
      SELECT
        proxy_wallet,
        market_id,
        SUM(CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END) AS cash_flow,
        SUM(signed_size)                                                        AS token_balance,
        MIN(ts_unix)                                                            AS first_trade_ts,
        MAX(ts_unix)                                                            AS last_trade_ts
      FROM discovery_activity_v3
      GROUP BY proxy_wallet, market_id
    ),
    -- Step 2: last observed price per market (any wallet's most recent trade)
    market_last_price AS (
      SELECT
        market_id,
        arg_max(price_yes, ts_unix) AS last_price_yes
      FROM discovery_activity_v3
      GROUP BY market_id
    ),
    -- Step 3: join market metadata and compute per-(wallet, market) PnL
    wallet_market_pnl AS (
      SELECT
        w.proxy_wallet,
        w.market_id,
        w.cash_flow,
        w.token_balance,
        w.first_trade_ts,
        w.last_trade_ts,
        m.end_date,
        -- closed = market has resolved (end_date set AND closed=1 OR outcome_prices resolved)
        CASE
          WHEN m.market_id IS NOT NULL AND m.end_date IS NOT NULL AND m.closed = 1
          THEN 1 ELSE 0
        END AS is_closed,
        -- resolution payout: YES wins → price[0]=1.0, NO wins → price[0]=0.0
        -- outcome_prices is a JSON array like ["1.0", "0.0"]
        CASE
          WHEN m.market_id IS NOT NULL AND m.end_date IS NOT NULL AND m.closed = 1
               AND m.outcome_prices IS NOT NULL
               AND TRY_CAST(json_extract_string(m.outcome_prices, '$[0]') AS DOUBLE) IS NOT NULL
          THEN w.token_balance * TRY_CAST(json_extract_string(m.outcome_prices, '$[0]') AS DOUBLE)
          ELSE 0.0
        END AS resolution_payout,
        -- unrealized: open markets, use last observed market price as mark
        CASE
          WHEN (m.market_id IS NULL OR m.end_date IS NULL OR m.closed = 0)
               AND lp.last_price_yes IS NOT NULL
          THEN w.token_balance * lp.last_price_yes
          ELSE 0.0
        END AS unrealized_mark
      FROM wallet_market_agg w
      LEFT JOIN markets_v3 m ON m.market_id = w.market_id
      LEFT JOIN market_last_price lp ON lp.market_id = w.market_id
    ),
    -- Step 4: per-(wallet, snapshot_day) PnL roll-up
    -- For closed markets: attribute realized PnL to the market's end_date
    -- For open markets: attribute unrealized to the wallet's last trade on that market
    daily_pnl AS (
      SELECT
        proxy_wallet,
        -- closed markets → attribute to end_date; open → last trade day
        CASE
          WHEN is_closed = 1 THEN CAST(end_date AS DATE)
          ELSE CAST(TO_TIMESTAMP(last_trade_ts) AS DATE)
        END AS snapshot_day,
        SUM(cash_flow + resolution_payout) AS realized_pnl_day,
        SUM(CASE WHEN is_closed = 0 THEN unrealized_mark ELSE 0.0 END) AS unrealized_pnl_day,
        APPROX_COUNT_DISTINCT(CASE WHEN is_closed = 1 THEN market_id ELSE NULL END) AS closed_positions_day
      FROM wallet_market_pnl
      GROUP BY proxy_wallet,
        CASE
          WHEN is_closed = 1 THEN CAST(end_date AS DATE)
          ELSE CAST(TO_TIMESTAMP(last_trade_ts) AS DATE)
        END
    ),
    -- Step 5: per-(wallet, day) activity stats
    daily_activity AS (
      SELECT
        proxy_wallet,
        CAST(TO_TIMESTAMP(ts_unix) AS DATE)   AS snapshot_day,
        COUNT(*)                              AS trade_count_day,
        SUM(usd_notional)                     AS volume_day,
        APPROX_COUNT_DISTINCT(market_id)      AS distinct_markets_day,
        MIN(ts_unix)                          AS first_active_ts_day,
        MAX(ts_unix)                          AS last_active_ts_day
      FROM discovery_activity_v3
      GROUP BY proxy_wallet, CAST(TO_TIMESTAMP(ts_unix) AS DATE)
    ),
    merged AS (
      SELECT
        COALESCE(da.proxy_wallet, dp.proxy_wallet)       AS proxy_wallet,
        COALESCE(da.snapshot_day, dp.snapshot_day)       AS snapshot_day,
        COALESCE(da.trade_count_day, 0)                  AS trade_count_day,
        COALESCE(da.volume_day, 0.0)                     AS volume_day,
        COALESCE(da.distinct_markets_day, 0)             AS distinct_markets_day,
        da.first_active_ts_day                           AS first_active_ts_day,
        da.last_active_ts_day                            AS last_active_ts_day,
        COALESCE(dp.closed_positions_day, 0)             AS closed_positions_day,
        COALESCE(dp.realized_pnl_day, 0.0)               AS realized_pnl_day,
        COALESCE(dp.unrealized_pnl_day, 0.0)             AS unrealized_pnl_day
      FROM daily_activity da
      FULL OUTER JOIN daily_pnl dp
        ON dp.proxy_wallet = da.proxy_wallet
       AND dp.snapshot_day = da.snapshot_day
    )
    SELECT
      proxy_wallet,
      snapshot_day,
      trade_count,
      volume_total,
      distinct_markets,
      closed_positions,
      realized_pnl,
      unrealized_pnl,
      first_active_ts,
      last_active_ts,
      CAST(FLOOR((last_active_ts - first_active_ts) / 86400.0) AS INTEGER) AS observation_span_days
    FROM (
      SELECT
        proxy_wallet,
        snapshot_day,
        SUM(trade_count_day)      OVER w AS trade_count,
        SUM(volume_day)           OVER w AS volume_total,
        SUM(distinct_markets_day) OVER w AS distinct_markets,
        SUM(closed_positions_day) OVER w AS closed_positions,
        SUM(realized_pnl_day)     OVER w AS realized_pnl,
        -- Unrealized is NOT cumulative (open positions change daily);
        -- we take the most recent day's unrealized mark
        LAST_VALUE(unrealized_pnl_day) OVER w AS unrealized_pnl,
        MIN(first_active_ts_day)  OVER w AS first_active_ts,
        MAX(last_active_ts_day)   OVER w AS last_active_ts
      FROM merged
      WINDOW w AS (PARTITION BY proxy_wallet ORDER BY snapshot_day
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    )
    WHERE trade_count > 0
  `;
}
