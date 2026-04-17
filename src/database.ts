import Database from 'better-sqlite3';
import path from 'path';
import { promises as fs } from 'fs';
import { config } from './config.js';

let db: Database.Database | null = null;
let currentDbPath: string | null = null;

function dbPath() { return path.join(config.dataDir, 'copytrade.db'); }
const SCHEMA_VERSION = 1;

/**
 * Initialize the SQLite database, creating tables if needed.
 * Safe to call multiple times -- subsequent calls return the existing connection.
 */
export async function initDatabase(): Promise<Database.Database> {
  const targetPath = dbPath();
  // Re-use existing connection only if it points to the same file
  if (db && currentDbPath === targetPath) return db;
  // Close stale connection if dataDir changed
  if (db) { db.close(); db = null; }

  await fs.mkdir(config.dataDir, { recursive: true });

  db = new Database(targetPath);
  currentDbPath = targetPath;

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  createSchema(db);

  safeAddColumn(db, 'discovery_wallets', 'whale_score', 'REAL DEFAULT 0');
  safeAddColumn(db, 'discovery_wallets', 'heat_indicator', "TEXT DEFAULT 'NEW'");
  safeAddColumn(db, 'discovery_wallets', 'total_pnl', 'REAL DEFAULT 0');
  safeAddColumn(db, 'discovery_wallets', 'roi_pct', 'REAL DEFAULT 0');
  safeAddColumn(db, 'discovery_wallets', 'win_rate', 'REAL DEFAULT 0');
  safeAddColumn(db, 'discovery_wallets', 'active_positions', 'INTEGER DEFAULT 0');
  safeAddColumn(db, 'discovery_wallets', 'last_signal_type', 'TEXT');
  safeAddColumn(db, 'discovery_wallets', 'last_signal_at', 'INTEGER');
  safeAddColumn(db, 'discovery_wallets', 'prior_active_at', 'INTEGER');
  safeAddColumn(db, 'discovery_wallets', 'high_information_volume_7d', 'REAL DEFAULT 0');
  safeAddColumn(db, 'discovery_wallets', 'focus_category', 'TEXT');
  safeAddColumn(db, 'discovery_trades', 'event_key', 'TEXT');
  safeAddColumn(db, 'discovery_trades', 'notional_usd', 'REAL');
  safeAddColumn(db, 'executed_positions', 'status', "TEXT DEFAULT 'executed'");
  safeAddColumn(db, 'executed_positions', 'order_id', 'TEXT');
  safeAddColumn(db, 'executed_positions', 'token_id', 'TEXT');
  safeAddColumn(db, 'executed_positions', 'position_key', 'TEXT');
  safeAddColumn(db, 'executed_positions', 'baseline_position_size', 'REAL');
  safeAddColumn(db, 'executed_positions', 'missing_order_checks', 'INTEGER DEFAULT 0');
  safeAddColumn(db, 'executed_positions', 'trade_side_action', 'TEXT');
  safeAddColumn(db, 'discovery_positions', 'asset_id', 'TEXT');
  safeAddColumn(db, 'discovery_positions', 'outcome', 'TEXT');
  safeAddColumn(db, 'discovery_positions', 'price_updated_at', 'INTEGER');
  safeAddColumn(db, 'discovery_market_cache', 'outcomes', 'TEXT');
  safeAddColumn(db, 'discovery_wallet_scores', 'previous_final_score', 'REAL');
  safeAddColumn(db, 'discovery_wallet_scores', 'previous_updated_at', 'INTEGER');
  safeAddColumn(db, 'discovery_wallet_scores', 'previous_passed_profitability_gate', 'INTEGER');
  safeAddColumn(db, 'discovery_wallet_scores', 'previous_passed_focus_gate', 'INTEGER');
  safeAddColumn(db, 'discovery_wallet_scores', 'previous_passed_copyability_gate', 'INTEGER');
  safeAddColumn(db, 'discovery_wallet_scores', 'trust_score', 'REAL DEFAULT 0');
  safeAddColumn(db, 'discovery_wallet_scores', 'strategy_class', "TEXT DEFAULT 'unknown'");
  safeAddColumn(db, 'discovery_wallet_scores', 'confidence_bucket', "TEXT DEFAULT 'low'");
  safeAddColumn(db, 'discovery_wallet_scores', 'surface_bucket', "TEXT DEFAULT 'watch_only'");
  safeAddColumn(db, 'discovery_wallet_scores', 'score_version', 'INTEGER DEFAULT 1');
  safeAddColumn(db, 'discovery_run_log', 'estimated_cost_usd', 'REAL DEFAULT 0');
  safeAddColumn(db, 'discovery_run_log', 'category_purity_pct', 'REAL DEFAULT 0');
  safeAddColumn(db, 'discovery_run_log', 'copyability_pass_pct', 'REAL DEFAULT 0');
  safeAddColumn(db, 'discovery_run_log', 'wallets_with_two_reasons_pct', 'REAL DEFAULT 0');
  safeAddColumn(db, 'discovery_run_log', 'free_mode_no_alchemy', 'INTEGER DEFAULT 1');
  safeCreateIndex(
    db,
    'idx_discovery_trades_event_key',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_trades_event_key ON discovery_trades (event_key) WHERE event_key IS NOT NULL'
  );
  safeCreateIndex(
    db,
    'idx_discovery_wallet_scores_v2_surface',
    'CREATE INDEX IF NOT EXISTS idx_discovery_wallet_scores_v2_surface ON discovery_wallet_scores_v2 (surface_bucket, discovery_score DESC, updated_at DESC)'
  );
  safeCreateIndex(
    db,
    'idx_discovery_eval_snapshots_v2_created',
    'CREATE INDEX IF NOT EXISTS idx_discovery_eval_snapshots_v2_created ON discovery_eval_snapshots_v2 (created_at DESC)'
  );
  safeCreateIndex(
    db,
    'idx_discovery_cost_snapshots_v2_created',
    'CREATE INDEX IF NOT EXISTS idx_discovery_cost_snapshots_v2_created ON discovery_cost_snapshots_v2 (created_at DESC)'
  );

  migrateDiscoveryPositionsSchema(db);
  safeCreateIndex(
    db,
    'idx_disc_positions_asset',
    'CREATE INDEX IF NOT EXISTS idx_disc_positions_asset ON discovery_positions (asset_id)'
  );

  return db;
}

/**
 * Get the current database instance. Throws if not initialized.
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection cleanly.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    currentDbPath = null;
  }
}

/**
 * Create the schema tables if they don't exist.
 */
function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracked_wallets (
      address           TEXT PRIMARY KEY,
      added_at          TEXT NOT NULL,
      active            INTEGER NOT NULL DEFAULT 0,
      last_seen         TEXT,
      label             TEXT,

      -- Trade sizing
      trade_sizing_mode TEXT,
      fixed_trade_size  REAL,
      threshold_enabled INTEGER,
      threshold_percent REAL,

      -- Trade side filter
      trade_side_filter TEXT,

      -- Advanced filters
      no_repeat_enabled       INTEGER,
      no_repeat_period_hours  REAL,
      price_limits_min        REAL,
      price_limits_max        REAL,
      rate_limit_enabled      INTEGER,
      rate_limit_per_hour     INTEGER,
      rate_limit_per_day      INTEGER,
      value_filter_enabled    INTEGER,
      value_filter_min        REAL,
      value_filter_max        REAL,
      slippage_percent        REAL
    );

    CREATE TABLE IF NOT EXISTS bot_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS executed_positions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id       TEXT NOT NULL,
      side            TEXT NOT NULL,
      timestamp       INTEGER NOT NULL,
      wallet_address  TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'executed',
      order_id        TEXT,
      token_id        TEXT,
      position_key    TEXT,
      baseline_position_size REAL,
      missing_order_checks INTEGER NOT NULL DEFAULT 0,
      trade_side_action TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_executed_positions_market
      ON executed_positions (market_id, side);

    -- =======================================================================
    -- DISCOVERY ENGINE TABLES
    -- =======================================================================

    CREATE TABLE IF NOT EXISTS discovery_trades (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_hash     TEXT UNIQUE NOT NULL,
      event_key   TEXT,
      maker       TEXT NOT NULL,
      taker       TEXT NOT NULL,
      asset_id    TEXT NOT NULL,
      condition_id TEXT,
      market_slug TEXT,
      market_title TEXT,
      side        TEXT,
      size        REAL,
      price       REAL,
      notional_usd REAL,
      fee         REAL,
      source      TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      block_number INTEGER,
      created_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_discovery_trades_maker
      ON discovery_trades (maker);
    CREATE INDEX IF NOT EXISTS idx_discovery_trades_taker
      ON discovery_trades (taker);
    CREATE INDEX IF NOT EXISTS idx_discovery_trades_detected
      ON discovery_trades (detected_at);

    CREATE TABLE IF NOT EXISTS discovery_wallets (
      address          TEXT PRIMARY KEY,
      pseudonym        TEXT,
      first_seen       INTEGER NOT NULL,
      last_active      INTEGER NOT NULL,
      prior_active_at  INTEGER,
      trade_count_7d   INTEGER DEFAULT 0,
      volume_7d        REAL DEFAULT 0,
      volume_prev_7d   REAL DEFAULT 0,
      high_information_volume_7d REAL DEFAULT 0,
      focus_category   TEXT,
      largest_trade    REAL DEFAULT 0,
      unique_markets_7d INTEGER DEFAULT 0,
      avg_trade_size   REAL DEFAULT 0,
      is_tracked       INTEGER DEFAULT 0,
      updated_at       INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS discovery_market_cache (
      condition_id TEXT PRIMARY KEY,
      slug         TEXT,
      title        TEXT,
      volume_24h   REAL,
      token_ids    TEXT,
      outcomes     TEXT,
      updated_at   INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS discovery_market_pool (
      condition_id      TEXT PRIMARY KEY,
      event_id          TEXT,
      market_id         TEXT,
      event_slug        TEXT,
      slug              TEXT,
      title             TEXT,
      focus_category    TEXT NOT NULL,
      tag_slugs         TEXT NOT NULL,
      token_ids         TEXT NOT NULL,
      outcomes          TEXT,
      liquidity         REAL,
      volume_24h        REAL,
      open_interest     REAL,
      accepting_orders  INTEGER DEFAULT 0,
      competitive       INTEGER DEFAULT 0,
      start_date        TEXT,
      end_date          TEXT,
      updated_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discovery_market_pool_category
      ON discovery_market_pool (focus_category, volume_24h DESC);

    CREATE TABLE IF NOT EXISTS discovery_token_map (
      token_id       TEXT PRIMARY KEY,
      condition_id   TEXT NOT NULL,
      outcome        TEXT,
      updated_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discovery_token_map_condition
      ON discovery_token_map (condition_id);

    CREATE TABLE IF NOT EXISTS discovery_wallet_candidates (
      address         TEXT NOT NULL,
      source_type     TEXT NOT NULL,
      source_label    TEXT NOT NULL,
      condition_id    TEXT NOT NULL DEFAULT '',
      market_title    TEXT,
      source_rank     INTEGER,
      source_metric   REAL,
      source_metadata TEXT,
      first_seen_at   INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (address, source_type, condition_id, source_label)
    );

    CREATE INDEX IF NOT EXISTS idx_discovery_wallet_candidates_updated
      ON discovery_wallet_candidates (updated_at DESC, source_metric DESC);

    CREATE TABLE IF NOT EXISTS discovery_wallet_validation (
      address               TEXT PRIMARY KEY,
      profile_name          TEXT,
      pseudonym             TEXT,
      x_username            TEXT,
      verified_badge        INTEGER DEFAULT 0,
      traded_markets        INTEGER,
      open_positions_count  INTEGER NOT NULL DEFAULT 0,
      closed_positions_count INTEGER NOT NULL DEFAULT 0,
      realized_pnl          REAL NOT NULL DEFAULT 0,
      realized_win_rate     REAL NOT NULL DEFAULT 0,
      maker_rebate_count    INTEGER NOT NULL DEFAULT 0,
      trade_activity_count  INTEGER NOT NULL DEFAULT 0,
      buy_activity_count    INTEGER NOT NULL DEFAULT 0,
      sell_activity_count   INTEGER NOT NULL DEFAULT 0,
      markets_touched       INTEGER NOT NULL DEFAULT 0,
      raw_profile           TEXT,
      raw_positions         TEXT,
      raw_closed_positions  TEXT,
      raw_activity          TEXT,
      last_validated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discovery_wallet_scores (
      address                   TEXT PRIMARY KEY,
      profitability_score       REAL NOT NULL DEFAULT 0,
      focus_score               REAL NOT NULL DEFAULT 0,
      copyability_score         REAL NOT NULL DEFAULT 0,
      early_score               REAL NOT NULL DEFAULT 0,
      consistency_score         REAL NOT NULL DEFAULT 0,
      conviction_score          REAL NOT NULL DEFAULT 0,
      noise_penalty             REAL NOT NULL DEFAULT 0,
      passed_profitability_gate INTEGER NOT NULL DEFAULT 0,
      passed_focus_gate         INTEGER NOT NULL DEFAULT 0,
      passed_copyability_gate   INTEGER NOT NULL DEFAULT 0,
      final_score               REAL NOT NULL DEFAULT 0,
      previous_final_score      REAL,
      previous_updated_at       INTEGER,
      previous_passed_profitability_gate INTEGER,
      previous_passed_focus_gate INTEGER,
      previous_passed_copyability_gate INTEGER,
      trust_score               REAL NOT NULL DEFAULT 0,
      strategy_class            TEXT NOT NULL DEFAULT 'unknown',
      confidence_bucket         TEXT NOT NULL DEFAULT 'low',
      surface_bucket            TEXT NOT NULL DEFAULT 'watch_only',
      score_version             INTEGER NOT NULL DEFAULT 1,
      updated_at                INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discovery_wallet_scores_final
      ON discovery_wallet_scores (final_score DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS discovery_wallet_scores_v2 (
      address               TEXT PRIMARY KEY,
      score_version         INTEGER NOT NULL,
      strategy_class        TEXT NOT NULL,
      discovery_score       REAL NOT NULL,
      trust_score           REAL NOT NULL,
      copyability_score     REAL NOT NULL,
      confidence_bucket     TEXT NOT NULL,
      surface_bucket        TEXT NOT NULL,
      primary_reason        TEXT NOT NULL,
      supporting_reasons_json TEXT NOT NULL,
      caution_flags_json    TEXT NOT NULL,
      updated_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discovery_wallet_reasons (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      address      TEXT NOT NULL,
      reason_type  TEXT NOT NULL,
      reason_code  TEXT NOT NULL,
      message      TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discovery_wallet_reasons_address
      ON discovery_wallet_reasons (address, created_at DESC);

    CREATE TABLE IF NOT EXISTS discovery_wallet_reasons_v2 (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      address           TEXT NOT NULL,
      primary_reason    TEXT NOT NULL,
      supporting_reasons_json TEXT NOT NULL,
      caution_flags_json TEXT NOT NULL,
      created_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discovery_run_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      phase               TEXT NOT NULL,
      gamma_request_count INTEGER NOT NULL DEFAULT 0,
      data_request_count  INTEGER NOT NULL DEFAULT 0,
      clob_request_count  INTEGER NOT NULL DEFAULT 0,
      candidate_count     INTEGER NOT NULL DEFAULT 0,
      qualified_count     INTEGER NOT NULL DEFAULT 0,
      rejected_count      INTEGER NOT NULL DEFAULT 0,
      duration_ms         INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd  REAL NOT NULL DEFAULT 0,
      category_purity_pct REAL NOT NULL DEFAULT 0,
      copyability_pass_pct REAL NOT NULL DEFAULT 0,
      wallets_with_two_reasons_pct REAL NOT NULL DEFAULT 0,
      free_mode_no_alchemy INTEGER NOT NULL DEFAULT 1,
      notes               TEXT,
      created_at          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discovery_eval_snapshots_v2 (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      window_start             INTEGER NOT NULL,
      window_end               INTEGER NOT NULL,
      sample_size              INTEGER NOT NULL,
      top_k                    INTEGER NOT NULL,
      precision_at_k           REAL NOT NULL,
      mean_average_precision   REAL NOT NULL,
      ndcg                     REAL NOT NULL,
      baseline_precision_at_k  REAL NOT NULL,
      created_at               INTEGER NOT NULL,
      notes                    TEXT
    );

    CREATE TABLE IF NOT EXISTS discovery_cost_snapshots_v2 (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      provider           TEXT NOT NULL,
      endpoint           TEXT NOT NULL,
      request_count      INTEGER NOT NULL,
      estimated_cost_usd REAL NOT NULL,
      coverage_count     INTEGER NOT NULL,
      runtime_ms         INTEGER NOT NULL,
      created_at         INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discovery_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- POSITIONS: per-wallet per-market per-outcome position accumulation
    CREATE TABLE IF NOT EXISTS discovery_positions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      address       TEXT NOT NULL,
      condition_id  TEXT NOT NULL,
      asset_id      TEXT NOT NULL,
      outcome       TEXT,
      market_slug   TEXT,
      market_title  TEXT,
      side          TEXT,
      shares        REAL DEFAULT 0,
      avg_entry     REAL DEFAULT 0,
      total_cost    REAL DEFAULT 0,
      total_trades  INTEGER DEFAULT 0,
      first_entry   INTEGER,
      last_entry    INTEGER,
      current_price REAL,
      price_updated_at INTEGER,
      unrealized_pnl REAL DEFAULT 0,
      roi_pct       REAL DEFAULT 0,
      updated_at    INTEGER DEFAULT (unixepoch()),
      UNIQUE(address, condition_id, asset_id)
    );

    CREATE INDEX IF NOT EXISTS idx_disc_positions_addr
      ON discovery_positions (address);
    CREATE INDEX IF NOT EXISTS idx_disc_positions_cond
      ON discovery_positions (condition_id);
    -- SIGNALS: fired by signal engine
    CREATE TABLE IF NOT EXISTS discovery_signals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type   TEXT NOT NULL,
      severity      TEXT NOT NULL,
      address       TEXT NOT NULL,
      condition_id  TEXT,
      market_title  TEXT,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL,
      metadata      TEXT,
      detected_at   INTEGER NOT NULL,
      dismissed     INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_disc_signals_type
      ON discovery_signals (signal_type);
    CREATE INDEX IF NOT EXISTS idx_disc_signals_addr
      ON discovery_signals (address);
    CREATE INDEX IF NOT EXISTS idx_disc_signals_detected
      ON discovery_signals (detected_at);
  `);

  // Set schema version if not set
  const row = database.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  if (!row) {
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }
}

function safeAddColumn(database: Database.Database, table: string, column: string, definition: string): void {
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err: any) {
    if (!err.message.includes('duplicate column')) throw err;
  }
}

function safeCreateIndex(database: Database.Database, indexName: string, sql: string): void {
  try {
    database.exec(sql);
  } catch (err: any) {
    console.warn(`[Database] Failed to create index ${indexName}: ${err.message}`);
  }
}

function migrateDiscoveryPositionsSchema(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info('discovery_positions')`)
    .all() as Array<{ name: string }>;
  const hasAssetColumn = columns.some((c) => c.name === 'asset_id');
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
}

// ============================================================================
// TRACKED WALLETS
// ============================================================================

import {
  TrackedWallet,
  TradeSideFilter,
  ExecutedPosition,
} from './types.js';

/** Convert a DB row to a TrackedWallet object */
function rowToWallet(row: any): TrackedWallet {
  return {
    address: row.address,
    addedAt: new Date(row.added_at),
    active: row.active === 1,
    lastSeen: row.last_seen ? new Date(row.last_seen) : undefined,
    label: row.label ?? undefined,

    tradeSizingMode: row.trade_sizing_mode ?? undefined,
    fixedTradeSize: row.fixed_trade_size ?? undefined,
    thresholdEnabled: row.threshold_enabled != null ? row.threshold_enabled === 1 : undefined,
    thresholdPercent: row.threshold_percent ?? undefined,

    tradeSideFilter: (row.trade_side_filter as TradeSideFilter) ?? undefined,

    noRepeatEnabled: row.no_repeat_enabled != null ? row.no_repeat_enabled === 1 : undefined,
    noRepeatPeriodHours: row.no_repeat_period_hours ?? undefined,
    priceLimitsMin: row.price_limits_min ?? undefined,
    priceLimitsMax: row.price_limits_max ?? undefined,
    rateLimitEnabled: row.rate_limit_enabled != null ? row.rate_limit_enabled === 1 : undefined,
    rateLimitPerHour: row.rate_limit_per_hour ?? undefined,
    rateLimitPerDay: row.rate_limit_per_day ?? undefined,
    valueFilterEnabled: row.value_filter_enabled != null ? row.value_filter_enabled === 1 : undefined,
    valueFilterMin: row.value_filter_min ?? undefined,
    valueFilterMax: row.value_filter_max ?? undefined,
    slippagePercent: row.slippage_percent ?? undefined,
  };
}

export function dbLoadTrackedWallets(): TrackedWallet[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM tracked_wallets').all();
  return rows.map(rowToWallet);
}

export function dbSaveTrackedWallets(wallets: TrackedWallet[]): void {
  const database = getDatabase();
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM tracked_wallets').run();
    const insert = database.prepare(`
      INSERT INTO tracked_wallets (
        address, added_at, active, last_seen, label,
        trade_sizing_mode, fixed_trade_size, threshold_enabled, threshold_percent,
        trade_side_filter,
        no_repeat_enabled, no_repeat_period_hours,
        price_limits_min, price_limits_max,
        rate_limit_enabled, rate_limit_per_hour, rate_limit_per_day,
        value_filter_enabled, value_filter_min, value_filter_max,
        slippage_percent
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?,
        ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?
      )
    `);
    for (const w of wallets) {
      insert.run(
        w.address,
        w.addedAt.toISOString(),
        w.active ? 1 : 0,
        w.lastSeen ? w.lastSeen.toISOString() : null,
        w.label ?? null,

        w.tradeSizingMode ?? null,
        w.fixedTradeSize ?? null,
        w.thresholdEnabled != null ? (w.thresholdEnabled ? 1 : 0) : null,
        w.thresholdPercent ?? null,

        w.tradeSideFilter ?? null,

        w.noRepeatEnabled != null ? (w.noRepeatEnabled ? 1 : 0) : null,
        w.noRepeatPeriodHours ?? null,
        w.priceLimitsMin ?? null,
        w.priceLimitsMax ?? null,
        w.rateLimitEnabled != null ? (w.rateLimitEnabled ? 1 : 0) : null,
        w.rateLimitPerHour ?? null,
        w.rateLimitPerDay ?? null,
        w.valueFilterEnabled != null ? (w.valueFilterEnabled ? 1 : 0) : null,
        w.valueFilterMin ?? null,
        w.valueFilterMax ?? null,
        w.slippagePercent ?? null,
      );
    }
  });
  tx();
}

// ============================================================================
// BOT CONFIG (key-value store)
// ============================================================================

export function dbLoadConfig(): Record<string, any> {
  const database = getDatabase();
  const rows = database.prepare('SELECT key, value FROM bot_config').all() as { key: string; value: string }[];
  const result: Record<string, any> = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return result;
}

export function dbSaveConfig(configData: Record<string, any>): void {
  const database = getDatabase();
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM bot_config').run();
    const insert = database.prepare('INSERT INTO bot_config (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(configData)) {
      insert.run(key, JSON.stringify(value));
    }
  });
  tx();
}

// ============================================================================
// EXECUTED POSITIONS
// ============================================================================

export function dbLoadExecutedPositions(): ExecutedPosition[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM executed_positions').all() as any[];
  return rows.map(r => ({
    marketId: r.market_id,
    side: String(r.side || ''),
    timestamp: r.timestamp,
    walletAddress: r.wallet_address,
    status: (r.status as 'executed' | 'pending' | undefined) ?? 'executed',
    orderId: r.order_id ?? undefined,
    tokenId: r.token_id ?? undefined,
    positionKey: r.position_key ?? undefined,
    baselinePositionSize: r.baseline_position_size ?? undefined,
    missingOrderChecks: r.missing_order_checks ?? undefined,
    tradeSideAction: r.trade_side_action ?? undefined,
  }));
}

export function dbSaveExecutedPositions(positions: ExecutedPosition[]): void {
  const database = getDatabase();
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM executed_positions').run();
    const insert = database.prepare(
      'INSERT INTO executed_positions (market_id, side, timestamp, wallet_address, status, order_id, token_id, position_key, baseline_position_size, missing_order_checks, trade_side_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const p of positions) {
      insert.run(
        p.marketId,
        p.side,
        p.timestamp,
        p.walletAddress,
        p.status ?? 'executed',
        p.orderId ?? null,
        p.tokenId ?? null,
        p.positionKey ?? null,
        p.baselinePositionSize ?? null,
        p.missingOrderChecks ?? 0,
        p.tradeSideAction ?? null
      );
    }
  });
  tx();
}

// ============================================================================
// MIGRATION: Import JSON files into SQLite
// ============================================================================

export async function migrateJsonToSqlite(dataDir: string): Promise<{ wallets: number; config: number; positions: number }> {
  const fsSync = await import('fs');
  const pathMod = await import('path');
  const counts = { wallets: 0, config: 0, positions: 0 };

  const walletsFile = pathMod.default.join(dataDir, 'tracked_wallets.json');
  if (fsSync.default.existsSync(walletsFile)) {
    const raw = fsSync.default.readFileSync(walletsFile, 'utf-8');
    const wallets: TrackedWallet[] = JSON.parse(raw).map((w: any) => ({
      ...w,
      addedAt: new Date(w.addedAt),
      lastSeen: w.lastSeen ? new Date(w.lastSeen) : undefined,
    }));
    dbSaveTrackedWallets(wallets);
    counts.wallets = wallets.length;
  }

  const configFile = pathMod.default.join(dataDir, 'bot_config.json');
  if (fsSync.default.existsSync(configFile)) {
    const raw = fsSync.default.readFileSync(configFile, 'utf-8');
    const configData = JSON.parse(raw);
    dbSaveConfig(configData);
    counts.config = Object.keys(configData).length;
  }

  const positionsFile = pathMod.default.join(dataDir, 'executed_positions.json');
  if (fsSync.default.existsSync(positionsFile)) {
    const raw = fsSync.default.readFileSync(positionsFile, 'utf-8');
    const positions: ExecutedPosition[] = JSON.parse(raw);
    dbSaveExecutedPositions(positions);
    counts.positions = positions.length;
  }

  return counts;
}
