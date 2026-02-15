import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Dynamically patch config.dataDir before importing database module
const tempDir = mkdtempSync(join(tmpdir(), 'db-test-'));

// We need to patch the config before importing database, so we import dynamically
let initDatabase: typeof import('../src/database.js').initDatabase;
let closeDatabase: typeof import('../src/database.js').closeDatabase;
let getDatabase: typeof import('../src/database.js').getDatabase;
let dbLoadTrackedWallets: typeof import('../src/database.js').dbLoadTrackedWallets;
let dbSaveTrackedWallets: typeof import('../src/database.js').dbSaveTrackedWallets;
let dbLoadConfig: typeof import('../src/database.js').dbLoadConfig;
let dbSaveConfig: typeof import('../src/database.js').dbSaveConfig;
let dbLoadExecutedPositions: typeof import('../src/database.js').dbLoadExecutedPositions;
let dbSaveExecutedPositions: typeof import('../src/database.js').dbSaveExecutedPositions;
let migrateJsonToSqlite: typeof import('../src/database.js').migrateJsonToSqlite;

import type { TrackedWallet, ExecutedPosition } from '../src/types.js';

describe('Database module', () => {
  beforeEach(async () => {
    // Patch config before every test
    const configMod = await import('../src/config.js');
    (configMod.config as any).dataDir = tempDir;

    // Force re-import to pick up the patched config
    // Close any existing connection first
    try {
      const dbMod = await import('../src/database.js');
      dbMod.closeDatabase();
    } catch { /* noop */ }

    const dbMod = await import('../src/database.js');
    initDatabase = dbMod.initDatabase;
    closeDatabase = dbMod.closeDatabase;
    getDatabase = dbMod.getDatabase;
    dbLoadTrackedWallets = dbMod.dbLoadTrackedWallets;
    dbSaveTrackedWallets = dbMod.dbSaveTrackedWallets;
    dbLoadConfig = dbMod.dbLoadConfig;
    dbSaveConfig = dbMod.dbSaveConfig;
    dbLoadExecutedPositions = dbMod.dbLoadExecutedPositions;
    dbSaveExecutedPositions = dbMod.dbSaveExecutedPositions;
    migrateJsonToSqlite = dbMod.migrateJsonToSqlite;

    await initDatabase();
  });

  afterEach(() => {
    closeDatabase();
    // Clean up db file between tests
    const dbPath = join(tempDir, 'copytrade.db');
    if (existsSync(dbPath)) rmSync(dbPath);
    const walPath = dbPath + '-wal';
    if (existsSync(walPath)) rmSync(walPath);
    const shmPath = dbPath + '-shm';
    if (existsSync(shmPath)) rmSync(shmPath);
  });

  it('creates the database file on init', async () => {
    const dbPath = join(tempDir, 'copytrade.db');
    assert.ok(existsSync(dbPath), 'DB file should exist after init');
  });

  it('getDatabase throws if not initialized', () => {
    closeDatabase();
    assert.throws(() => getDatabase(), /not initialized/);
  });

  // ── Tracked Wallets ──

  it('CRUD tracked wallets: save and load roundtrip', () => {
    const wallets: TrackedWallet[] = [
      {
        address: '0xabc',
        addedAt: new Date('2025-01-01T00:00:00Z'),
        active: true,
        label: 'Test Whale',
        tradeSizingMode: 'fixed',
        fixedTradeSize: 50,
        thresholdEnabled: true,
        thresholdPercent: 5,
        tradeSideFilter: 'buy_only',
        noRepeatEnabled: false,
        noRepeatPeriodHours: 24,
        priceLimitsMin: 0.05,
        priceLimitsMax: 0.95,
        rateLimitEnabled: true,
        rateLimitPerHour: 5,
        rateLimitPerDay: 20,
        valueFilterEnabled: false,
        slippagePercent: 3,
      },
      {
        address: '0xdef',
        addedAt: new Date('2025-06-15T12:30:00Z'),
        active: false,
      },
    ];

    dbSaveTrackedWallets(wallets);
    const loaded = dbLoadTrackedWallets();

    assert.equal(loaded.length, 2);

    // First wallet
    assert.equal(loaded[0].address, '0xabc');
    assert.equal(loaded[0].active, true);
    assert.equal(loaded[0].label, 'Test Whale');
    assert.equal(loaded[0].tradeSizingMode, 'fixed');
    assert.equal(loaded[0].fixedTradeSize, 50);
    assert.equal(loaded[0].thresholdEnabled, true);
    assert.equal(loaded[0].thresholdPercent, 5);
    assert.equal(loaded[0].tradeSideFilter, 'buy_only');
    assert.equal(loaded[0].noRepeatEnabled, false);
    assert.equal(loaded[0].rateLimitEnabled, true);
    assert.equal(loaded[0].rateLimitPerHour, 5);
    assert.equal(loaded[0].rateLimitPerDay, 20);
    assert.equal(loaded[0].slippagePercent, 3);

    // Second wallet (minimal)
    assert.equal(loaded[1].address, '0xdef');
    assert.equal(loaded[1].active, false);
    assert.equal(loaded[1].label, undefined);
    assert.equal(loaded[1].tradeSizingMode, undefined);
  });

  it('empty wallets table returns empty array', () => {
    const loaded = dbLoadTrackedWallets();
    assert.deepEqual(loaded, []);
  });

  // ── Bot Config ──

  it('CRUD bot config: save and load roundtrip', () => {
    const configData = {
      tradeSize: '10',
      monitoringIntervalMs: 5000,
      noRepeatTradesEnabled: true,
      noRepeatTradesBlockPeriodHours: 48,
      priceLimitsMin: 0.02,
      priceLimitsMax: 0.98,
    };

    dbSaveConfig(configData);
    const loaded = dbLoadConfig();

    assert.equal(loaded.tradeSize, '10');
    assert.equal(loaded.monitoringIntervalMs, 5000);
    assert.equal(loaded.noRepeatTradesEnabled, true);
    assert.equal(loaded.priceLimitsMin, 0.02);
  });

  it('empty config returns empty object', () => {
    const loaded = dbLoadConfig();
    assert.deepEqual(loaded, {});
  });

  // ── Executed Positions ──

  it('CRUD executed positions: save and load roundtrip', () => {
    const positions: ExecutedPosition[] = [
      { marketId: 'mkt1', side: 'YES', timestamp: 1700000000, walletAddress: '0xabc' },
      { marketId: 'mkt2', side: 'NO', timestamp: 1700001000, walletAddress: '0xdef' },
    ];

    dbSaveExecutedPositions(positions);
    const loaded = dbLoadExecutedPositions();

    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].marketId, 'mkt1');
    assert.equal(loaded[0].side, 'YES');
    assert.equal(loaded[0].timestamp, 1700000000);
    assert.equal(loaded[0].walletAddress, '0xabc');
    assert.equal(loaded[1].marketId, 'mkt2');
    assert.equal(loaded[1].side, 'NO');
  });

  it('empty positions returns empty array', () => {
    const loaded = dbLoadExecutedPositions();
    assert.deepEqual(loaded, []);
  });

  // ── Migration ──

  it('migrateJsonToSqlite imports JSON files into SQLite', async () => {
    const { writeFileSync, mkdirSync } = await import('fs');

    const migDir = join(tempDir, 'migrate-test');
    mkdirSync(migDir, { recursive: true });

    // Write test JSON files
    writeFileSync(join(migDir, 'tracked_wallets.json'), JSON.stringify([
      { address: '0x111', addedAt: '2025-01-01T00:00:00Z', active: true }
    ]));
    writeFileSync(join(migDir, 'bot_config.json'), JSON.stringify({
      tradeSize: '5',
      monitoringIntervalMs: 10000
    }));
    writeFileSync(join(migDir, 'executed_positions.json'), JSON.stringify([
      { marketId: 'mkt-a', side: 'YES', timestamp: 1700000000, walletAddress: '0x111' }
    ]));

    const counts = await migrateJsonToSqlite(migDir);

    assert.equal(counts.wallets, 1);
    assert.equal(counts.config, 2);
    assert.equal(counts.positions, 1);

    // Verify data is actually in SQLite
    const wallets = dbLoadTrackedWallets();
    assert.equal(wallets.length, 1);
    assert.equal(wallets[0].address, '0x111');
    assert.equal(wallets[0].active, true);

    const cfg = dbLoadConfig();
    assert.equal(cfg.tradeSize, '5');

    const pos = dbLoadExecutedPositions();
    assert.equal(pos.length, 1);
    assert.equal(pos[0].marketId, 'mkt-a');
  });

  it('migrateJsonToSqlite handles missing files gracefully', async () => {
    const emptyDir = join(tempDir, 'empty-migrate');
    const { mkdirSync } = await import('fs');
    mkdirSync(emptyDir, { recursive: true });

    const counts = await migrateJsonToSqlite(emptyDir);
    assert.equal(counts.wallets, 0);
    assert.equal(counts.config, 0);
    assert.equal(counts.positions, 0);
  });
});
