import type Database from 'better-sqlite3';

export const V3_SQLITE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS discovery_wallet_scores_v3 (
    proxy_wallet        TEXT PRIMARY KEY,
    tier                TEXT NOT NULL,
    tier_rank           INTEGER NOT NULL,
    score               REAL NOT NULL,
    volume_total        REAL NOT NULL,
    trade_count         INTEGER NOT NULL,
    distinct_markets    INTEGER NOT NULL,
    closed_positions    INTEGER NOT NULL,
    realized_pnl        REAL NOT NULL,
    hit_rate            REAL,
    last_active_ts      INTEGER NOT NULL,
    reasons_json        TEXT NOT NULL,
    updated_at          INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scores_v3_tier_rank ON discovery_wallet_scores_v3 (tier, tier_rank)`,
  `CREATE TABLE IF NOT EXISTS pipeline_cursor (
    pipeline       TEXT PRIMARY KEY,
    last_block     INTEGER NOT NULL,
    last_ts_unix   INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  )`,
];

export function runV3SqliteMigrations(db: Database.Database): void {
  for (const stmt of V3_SQLITE_DDL) {
    db.exec(stmt);
  }
}
