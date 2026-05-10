import type Database from 'better-sqlite3';

export const V3_SQLITE_DDL: string[] = [
  // Composite PK (proxy_wallet, tier) — scoreTiers emits one row per wallet
  // per tier (alpha/whale/specialist), and the API (/wallet/:address,
  // /:tier) reads multiple rows per wallet. A wallet-only PK was a bug
  // (caught by rev5, 2026-04-23). Runtime migration below handles
  // pre-existing databases.
  `CREATE TABLE IF NOT EXISTS discovery_wallet_scores_v3 (
    proxy_wallet        TEXT NOT NULL,
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
    updated_at          INTEGER NOT NULL,
    PRIMARY KEY (proxy_wallet, tier)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scores_v3_tier_rank ON discovery_wallet_scores_v3 (tier, tier_rank)`,
  `CREATE TABLE IF NOT EXISTS pipeline_cursor (
    pipeline       TEXT PRIMARY KEY,
    last_block     INTEGER NOT NULL,
    last_ts_unix   INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  )`,
];

/**
 * Additive columns on the existing scores table.
 * These ALTER TABLEs are idempotent — SQLite will error if the column
 * already exists, so we catch and ignore.
 */
const ADDITIVE_COLUMN_MIGRATIONS: string[] = [
  `ALTER TABLE discovery_wallet_scores_v3 ADD COLUMN ditto_state TEXT DEFAULT NULL`,
];

export function runV3SqliteMigrations(db: Database.Database): void {
  // Pre-existing DBs (created before rev5, 2026-04-23) have
  // `discovery_wallet_scores_v3` with PRIMARY KEY (proxy_wallet) — a bug.
  // Detect and rebuild before CREATE TABLE IF NOT EXISTS no-ops. Drop is
  // safe: the table is a cache, rebuilt from DuckDB snapshots every run
  // of 05_score_and_publish.ts (and hourly by refreshWorker.ts).
  const existing = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='discovery_wallet_scores_v3'"
    )
    .get() as { sql?: string } | undefined;
  if (existing?.sql && /proxy_wallet\s+TEXT\s+PRIMARY\s+KEY/i.test(existing.sql)) {
    db.exec('DROP TABLE discovery_wallet_scores_v3');
  }
  for (const stmt of V3_SQLITE_DDL) {
    db.exec(stmt);
  }

  // Additive migration: add Ditto State column if it doesn't exist yet.
  for (const alter of ADDITIVE_COLUMN_MIGRATIONS) {
    try {
      db.exec(alter);
    } catch (err) {
      if (!/duplicate column/i.test((err as Error).message)) throw err;
    }
  }
}
