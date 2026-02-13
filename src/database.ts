import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { TrackedWallet, ExecutedPosition } from './types.js';

const DB_FILENAME = 'bot.sqlite';
const DB_PATH = path.join(config.dataDir, DB_FILENAME);

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeSchema(db);
    migrateLegacyJson(db);
  }

  return db;
}

function initializeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tracked_wallets (
      address TEXT PRIMARY KEY,
      added_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT,
      label TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS bot_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS executed_positions (
      market_id TEXT NOT NULL,
      side TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      PRIMARY KEY (market_id, side)
    );
  `);
}

function migrateLegacyJson(database: Database.Database): void {
  migrateTrackedWallets(database);
  migrateBotConfig(database);
  migrateExecutedPositions(database);
}

function migrateTrackedWallets(database: Database.Database): void {
  const legacyPath = path.join(config.dataDir, 'tracked_wallets.json');
  if (!fs.existsSync(legacyPath)) {
    return;
  }

  const row = database.prepare('SELECT COUNT(1) as count FROM tracked_wallets').get() as { count: number };
  if (row.count > 0) {
    return;
  }

  try {
    const raw = fs.readFileSync(legacyPath, 'utf-8');
    const wallets: TrackedWallet[] = JSON.parse(raw);
    if (!Array.isArray(wallets) || wallets.length === 0) {
      archiveLegacyFile(legacyPath);
      return;
    }

    const insert = database.prepare(`
      INSERT OR REPLACE INTO tracked_wallets (address, added_at, active, last_seen, label, settings_json)
      VALUES (@address, @added_at, @active, @last_seen, @label, @settings_json)
    `);

    const tx = database.transaction((items: TrackedWallet[]) => {
      for (const wallet of items) {
        const { address, addedAt, active, lastSeen, label, ...settings } = wallet;
        const cleanedSettings: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(settings)) {
          if (value !== undefined) {
            cleanedSettings[key] = value;
          }
        }

        insert.run({
          address: address.toLowerCase(),
          added_at: (addedAt ?? new Date()).toISOString(),
          active: active ? 1 : 0,
          last_seen: lastSeen ? new Date(lastSeen).toISOString() : null,
          label: label ?? null,
          settings_json: JSON.stringify(cleanedSettings)
        });
      }
    });

    tx(wallets);
    archiveLegacyFile(legacyPath);
  } catch (error) {
    console.error('Failed to migrate tracked_wallets.json:', error);
  }
}

function migrateBotConfig(database: Database.Database): void {
  const legacyPath = path.join(config.dataDir, 'bot_config.json');
  if (!fs.existsSync(legacyPath)) {
    return;
  }

  const existing = database.prepare('SELECT 1 FROM bot_config WHERE id = 1').get();
  if (existing) {
    return;
  }

  try {
    const raw = fs.readFileSync(legacyPath, 'utf-8');
    const data = JSON.parse(raw);
    database.prepare('INSERT INTO bot_config (id, data) VALUES (1, ?)').run(JSON.stringify(data));
    archiveLegacyFile(legacyPath);
  } catch (error) {
    console.error('Failed to migrate bot_config.json:', error);
  }
}

function migrateExecutedPositions(database: Database.Database): void {
  const legacyPath = path.join(config.dataDir, 'executed_positions.json');
  if (!fs.existsSync(legacyPath)) {
    return;
  }

  const row = database.prepare('SELECT COUNT(1) AS count FROM executed_positions').get() as { count: number };
  if (row.count > 0) {
    return;
  }

  try {
    const raw = fs.readFileSync(legacyPath, 'utf-8');
    const positions: ExecutedPosition[] = JSON.parse(raw);
    if (!Array.isArray(positions) || positions.length === 0) {
      archiveLegacyFile(legacyPath);
      return;
    }

    const insert = database.prepare(`
      INSERT OR IGNORE INTO executed_positions (market_id, side, timestamp, wallet_address)
      VALUES (@market_id, @side, @timestamp, @wallet_address)
    `);

    const tx = database.transaction((items: ExecutedPosition[]) => {
      for (const position of items) {
        insert.run({
          market_id: position.marketId,
          side: position.side,
          timestamp: position.timestamp,
          wallet_address: position.walletAddress.toLowerCase()
        });
      }
    });

    tx(positions);
    archiveLegacyFile(legacyPath);
  } catch (error) {
    console.error('Failed to migrate executed_positions.json:', error);
  }
}

function archiveLegacyFile(filePath: string): void {
  const target = filePath.replace(/\.json$/, '.legacy.json');
  try {
    fs.renameSync(filePath, target);
  } catch (error) {
    console.error(`Failed to archive legacy file ${filePath}:`, error);
  }
}
