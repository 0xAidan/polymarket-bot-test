export const V3_DUCKDB_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS discovery_activity_v3 (
    proxy_wallet      VARCHAR       NOT NULL,
    market_id         VARCHAR       NOT NULL,
    condition_id      VARCHAR       NOT NULL,
    event_id          VARCHAR,
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_v3_dedup ON discovery_activity_v3 (tx_hash, log_index)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_v3_wallet_ts ON discovery_activity_v3 (proxy_wallet, ts_unix)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_v3_market_ts ON discovery_activity_v3 (market_id, ts_unix)`,
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

export async function runV3DuckDBMigrations(
  exec: (sql: string) => Promise<void>
): Promise<void> {
  for (const stmt of V3_DUCKDB_DDL) {
    await exec(stmt);
  }
}
