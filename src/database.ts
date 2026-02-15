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
      wallet_address  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_executed_positions_market
      ON executed_positions (market_id, side);
  `);

  // Set schema version if not set
  const row = database.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  if (!row) {
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  }
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
    side: r.side as 'YES' | 'NO',
    timestamp: r.timestamp,
    walletAddress: r.wallet_address,
  }));
}

export function dbSaveExecutedPositions(positions: ExecutedPosition[]): void {
  const database = getDatabase();
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM executed_positions').run();
    const insert = database.prepare(
      'INSERT INTO executed_positions (market_id, side, timestamp, wallet_address) VALUES (?, ?, ?, ?)'
    );
    for (const p of positions) {
      insert.run(p.marketId, p.side, p.timestamp, p.walletAddress);
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
