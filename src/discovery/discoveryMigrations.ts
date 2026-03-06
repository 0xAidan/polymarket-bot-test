import Database from 'better-sqlite3';

const safeAddColumn = (database: Database.Database, table: string, column: string, definition: string): void => {
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err: any) {
    if (!err.message.includes('duplicate column')) throw err;
  }
};

const safeCreateIndex = (database: Database.Database, indexName: string, sql: string): void => {
  try {
    database.exec(sql);
  } catch (err: any) {
    console.warn(`[DiscoveryDatabase] Failed to create index ${indexName}: ${err.message}`);
  }
};

const migrateDiscoveryPositionsSchema = (database: Database.Database): void => {
  const columns = database
    .prepare(`PRAGMA table_info('discovery_positions')`)
    .all() as Array<{ name: string }>;
  const hasAssetColumn = columns.some((column) => column.name === 'asset_id');
  const tableRow = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'discovery_positions'`)
    .get() as { sql?: string } | undefined;
  const hasThreeKeyUniqueness = String(tableRow?.sql || '').includes('UNIQUE(address, condition_id, asset_id)');

  if (hasAssetColumn && hasThreeKeyUniqueness) return;

  database.exec(`
    ALTER TABLE discovery_positions RENAME TO discovery_positions_legacy;

    CREATE TABLE discovery_positions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      address         TEXT NOT NULL,
      condition_id    TEXT NOT NULL,
      asset_id        TEXT NOT NULL,
      outcome         TEXT,
      market_slug     TEXT,
      market_title    TEXT,
      side            TEXT,
      shares          REAL DEFAULT 0,
      avg_entry       REAL DEFAULT 0,
      total_cost      REAL DEFAULT 0,
      total_trades    INTEGER DEFAULT 0,
      first_entry     INTEGER,
      last_entry      INTEGER,
      current_price   REAL,
      price_updated_at INTEGER,
      unrealized_pnl  REAL DEFAULT 0,
      roi_pct         REAL DEFAULT 0,
      updated_at      INTEGER DEFAULT (unixepoch()),
      UNIQUE(address, condition_id, asset_id)
    );

    CREATE INDEX IF NOT EXISTS idx_disc_positions_addr
      ON discovery_positions (address);
    CREATE INDEX IF NOT EXISTS idx_disc_positions_cond
      ON discovery_positions (condition_id);
    CREATE INDEX IF NOT EXISTS idx_disc_positions_asset
      ON discovery_positions (asset_id);

    INSERT INTO discovery_positions (
      id, address, condition_id, asset_id, outcome, market_slug, market_title, side,
      shares, avg_entry, total_cost, total_trades, first_entry, last_entry,
      current_price, price_updated_at, unrealized_pnl, roi_pct, updated_at
    )
    SELECT
      id,
      address,
      condition_id,
      COALESCE(NULLIF(asset_id, ''), condition_id || ':legacy'),
      outcome,
      market_slug,
      market_title,
      side,
      shares,
      avg_entry,
      total_cost,
      total_trades,
      first_entry,
      last_entry,
      current_price,
      price_updated_at,
      unrealized_pnl,
      roi_pct,
      updated_at
    FROM discovery_positions_legacy;

    DROP TABLE discovery_positions_legacy;
  `);
};

export const runDiscoveryMigrations = (database: Database.Database): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS discovery_trades (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash      TEXT UNIQUE NOT NULL,
      event_key    TEXT,
      maker        TEXT NOT NULL,
      taker        TEXT NOT NULL,
      asset_id     TEXT NOT NULL,
      condition_id TEXT,
      market_slug  TEXT,
      market_title TEXT,
      side         TEXT,
      size         REAL,
      price        REAL,
      notional_usd REAL,
      fee          REAL,
      source       TEXT NOT NULL,
      detected_at  INTEGER NOT NULL,
      block_number INTEGER,
      created_at   INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_discovery_trades_maker
      ON discovery_trades (maker);
    CREATE INDEX IF NOT EXISTS idx_discovery_trades_taker
      ON discovery_trades (taker);
    CREATE INDEX IF NOT EXISTS idx_discovery_trades_detected
      ON discovery_trades (detected_at);

    CREATE TABLE IF NOT EXISTS discovery_wallets (
      address                   TEXT PRIMARY KEY,
      pseudonym                 TEXT,
      first_seen                INTEGER NOT NULL,
      last_active               INTEGER NOT NULL,
      prior_active_at           INTEGER,
      trade_count_7d            INTEGER DEFAULT 0,
      volume_7d                 REAL DEFAULT 0,
      volume_prev_7d            REAL DEFAULT 0,
      high_information_volume_7d REAL DEFAULT 0,
      focus_category            TEXT,
      largest_trade             REAL DEFAULT 0,
      unique_markets_7d         INTEGER DEFAULT 0,
      avg_trade_size            REAL DEFAULT 0,
      is_tracked                INTEGER DEFAULT 0,
      whale_score               REAL DEFAULT 0,
      heat_indicator            TEXT DEFAULT 'NEW',
      total_pnl                 REAL DEFAULT 0,
      roi_pct                   REAL DEFAULT 0,
      win_rate                  REAL DEFAULT 0,
      active_positions          INTEGER DEFAULT 0,
      last_signal_type          TEXT,
      last_signal_at            INTEGER,
      updated_at                INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS discovery_market_cache (
      condition_id TEXT PRIMARY KEY,
      slug         TEXT,
      title        TEXT,
      volume_24h   REAL,
      token_ids    TEXT,
      outcomes     TEXT,
      priority_tier TEXT,
      priority_score REAL,
      novelty_score REAL,
      activity_score REAL,
      inclusion_reason TEXT,
      updated_at   INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS discovery_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discovery_positions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      address          TEXT NOT NULL,
      condition_id     TEXT NOT NULL,
      asset_id         TEXT NOT NULL,
      outcome          TEXT,
      market_slug      TEXT,
      market_title     TEXT,
      side             TEXT,
      shares           REAL DEFAULT 0,
      avg_entry        REAL DEFAULT 0,
      total_cost       REAL DEFAULT 0,
      total_trades     INTEGER DEFAULT 0,
      first_entry      INTEGER,
      last_entry       INTEGER,
      current_price    REAL,
      price_updated_at INTEGER,
      unrealized_pnl   REAL DEFAULT 0,
      roi_pct          REAL DEFAULT 0,
      updated_at       INTEGER DEFAULT (unixepoch()),
      UNIQUE(address, condition_id, asset_id)
    );

    CREATE INDEX IF NOT EXISTS idx_disc_positions_addr
      ON discovery_positions (address);
    CREATE INDEX IF NOT EXISTS idx_disc_positions_cond
      ON discovery_positions (condition_id);

    CREATE TABLE IF NOT EXISTS discovery_signals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type  TEXT NOT NULL,
      severity     TEXT NOT NULL,
      address      TEXT NOT NULL,
      condition_id TEXT,
      market_title TEXT,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL,
      metadata     TEXT,
      detected_at  INTEGER NOT NULL,
      dismissed    INTEGER DEFAULT 0,
      created_at   INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_disc_signals_type
      ON discovery_signals (signal_type);
    CREATE INDEX IF NOT EXISTS idx_disc_signals_addr
      ON discovery_signals (address);
    CREATE INDEX IF NOT EXISTS idx_disc_signals_detected
      ON discovery_signals (detected_at);

    CREATE TABLE IF NOT EXISTS discovery_source_checkpoints (
      source_name TEXT PRIMARY KEY,
      cursor      TEXT,
      metadata    TEXT,
      updated_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS discovery_wallet_state (
      address        TEXT PRIMARY KEY,
      trade_count    INTEGER DEFAULT 0,
      total_volume   REAL DEFAULT 0,
      last_trade_at  INTEGER,
      updated_at     INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS discovery_market_state (
      condition_id   TEXT PRIMARY KEY,
      trade_count    INTEGER DEFAULT 0,
      total_volume   REAL DEFAULT 0,
      last_trade_at  INTEGER,
      updated_at     INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS discovery_wallet_market_state (
      address        TEXT NOT NULL,
      condition_id   TEXT NOT NULL,
      trade_count    INTEGER DEFAULT 0,
      total_volume   REAL DEFAULT 0,
      last_trade_at  INTEGER,
      updated_at     INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (address, condition_id)
    );
  `);

  safeAddColumn(database, 'discovery_market_cache', 'outcomes', 'TEXT');
  safeAddColumn(database, 'discovery_market_cache', 'priority_tier', 'TEXT');
  safeAddColumn(database, 'discovery_market_cache', 'priority_score', 'REAL');
  safeAddColumn(database, 'discovery_market_cache', 'novelty_score', 'REAL');
  safeAddColumn(database, 'discovery_market_cache', 'activity_score', 'REAL');
  safeAddColumn(database, 'discovery_market_cache', 'inclusion_reason', 'TEXT');
  safeCreateIndex(
    database,
    'idx_discovery_trades_event_key',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_trades_event_key ON discovery_trades (event_key) WHERE event_key IS NOT NULL'
  );
  migrateDiscoveryPositionsSchema(database);
  safeCreateIndex(
    database,
    'idx_disc_positions_asset',
    'CREATE INDEX IF NOT EXISTS idx_disc_positions_asset ON discovery_positions (asset_id)'
  );
};
