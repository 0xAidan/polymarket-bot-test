/**
 * Activity table DDL. The live online-ingest path (goldskyListener) relies
 * on the UNIQUE(tx_hash, log_index) index to absorb duplicate events at
 * the backfill→live boundary (per-row INSERT with "swallow duplicate key"
 * semantics — see `insertNormalizedRows`). The `V3_DUCKDB_DDL` therefore
 * keeps the indexes so live-prod DuckDB setups stay correct.
 *
 * Indexes are small and fine to build on an empty / small live DuckDB.
 *
 * 2026-04-23 fix — "backfill-skips-indexes":
 *   Backfill on ~800M rows must NOT create these ART indexes because
 *   DuckDB 1.4.x CREATE INDEX requires the entire index to fit in memory
 *   (duckdb.org/docs/current/sql/indexes.html — "ART indexes must
 *   currently be able to fit in memory during index creation"). The
 *   Hetzner 8GB box cannot satisfy that. See duckdb/duckdb issues #15420
 *   and #16229 (unresolved on 1.4.x). Non-unique ART would OOM too —
 *   same code path.
 *
 *   Every backfill script now uses `runV3DuckDBMigrationsBackfillNoIndex`
 *   and never calls `buildActivityIndexSqlList()`. Dedup correctness for
 *   backfill is enforced by 02c's bucket-local GROUP BY (valid because
 *   02a bucketizes on hash(tx_hash), colocating every duplicate key
 *   inside a single bucket) and verified defensively by 02d.
 *
 *   Downstream (04 snapshots, 05 score, 06 validate) does not need
 *   ART indexes on activity: 04 does full-table scans + hash joins,
 *   05/06 read only `discovery_feature_snapshots_v3` (which has a
 *   native PRIMARY KEY).
 */
export const V3_ACTIVITY_TABLE_DDL =
  `CREATE TABLE IF NOT EXISTS discovery_activity_v3 (
    proxy_wallet      VARCHAR       NOT NULL,
    market_id         VARCHAR       NOT NULL,
    condition_id      VARCHAR       NOT NULL,
    event_id           VARCHAR,
    ts_unix           UBIGINT       NOT NULL,
    block_number      UBIGINT       NOT NULL,
    tx_hash           VARCHAR       NOT NULL,
    log_index         UINTEGER      NOT NULL,
    role              VARCHAR       NOT NULL,
    side              VARCHAR       NOT NULL,
    price_yes         DOUBLE        NOT NULL,
    usd_notional      DOUBLE        NOT NULL,
    signed_size       DOUBLE        NOT NULL,
    abs_size          DOUBLE        NOT NULL
  )`;

export const V3_ACTIVITY_INDEX_DDL: string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_v3_dedup ON discovery_activity_v3 (tx_hash, log_index)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_v3_wallet_ts ON discovery_activity_v3 (proxy_wallet, ts_unix)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_v3_market_ts ON discovery_activity_v3 (market_id, ts_unix)`,
];

export const V3_DUCKDB_DDL: string[] = [
  V3_ACTIVITY_TABLE_DDL,
  ...V3_ACTIVITY_INDEX_DDL,
  `CREATE TABLE IF NOT EXISTS markets_v3 (
    market_id         VARCHAR PRIMARY KEY,
    condition_id      VARCHAR,
    event_id          VARCHAR,
    question          VARCHAR,
    slug              VARCHAR,
    token1            VARCHAR,
    token2            VARCHAR,
    answer1           VARCHAR,
    answer2           VARCHAR,
    closed            UTINYINT,
    neg_risk          UTINYINT,
    outcome_prices    VARCHAR,
    volume_total      DOUBLE,
    created_at        TIMESTAMP,
    end_date          TIMESTAMP,
    updated_at        TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS discovery_feature_snapshots_v3 (
    proxy_wallet          VARCHAR   NOT NULL,
    snapshot_day          DATE      NOT NULL,
    trade_count           BIGINT    NOT NULL,
    volume_total          DOUBLE    NOT NULL,
    distinct_markets      BIGINT    NOT NULL,
    closed_positions      BIGINT    NOT NULL,
    realized_pnl          DOUBLE    NOT NULL,
    unrealized_pnl        DOUBLE    NOT NULL,
    first_active_ts       UBIGINT   NOT NULL,
    last_active_ts        UBIGINT   NOT NULL,
    observation_span_days INTEGER   NOT NULL,
    PRIMARY KEY (proxy_wallet, snapshot_day)
  )`,
];

/**
 * Full migrations (activity table + indexes + other tables). Use this for
 * live prod DuckDB setups (goldskyListener). DO NOT use on a backfilled
 * activity table — building the UNIQUE index on 800M rows OOMs.
 */
export async function runV3DuckDBMigrations(
  exec: (sql: string) => Promise<void>
): Promise<void> {
  for (const stmt of V3_DUCKDB_DDL) {
    await exec(stmt);
  }
}

/**
 * Backfill migrations — identical to `runV3DuckDBMigrations` except the
 * three activity-table ART indexes are skipped. ALL backfill scripts
 * (02, 02b, 02c, 03, 04, 05) must use this function; they never call
 * `buildActivityIndexSqlList()` on a large table.
 */
export async function runV3DuckDBMigrationsBackfillNoIndex(
  exec: (sql: string) => Promise<void>
): Promise<void> {
  for (const stmt of V3_DUCKDB_DDL) {
    if (V3_ACTIVITY_INDEX_DDL.includes(stmt)) continue;
    await exec(stmt);
  }
}

/**
 * Exposed for completeness; backfill scripts must NOT invoke this on a
 * populated `discovery_activity_v3` on a memory-constrained host.
 */
export function buildActivityIndexSqlList(): string[] {
  return [...V3_ACTIVITY_INDEX_DDL];
}
