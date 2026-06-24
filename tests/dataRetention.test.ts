import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getDiskBreakdown } from '../src/diskGuard.js';

describe('diskGuard breakdown', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disk-breakdown-'));
    process.env.DATA_DIR = tempDir;
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports sizes for known data files', async () => {
    await fs.writeFile(path.join(tempDir, 'copytrade.db'), 'x'.repeat(100));
    await fs.writeFile(path.join(tempDir, 'discovery_v3.duckdb'), 'y'.repeat(200));

    const breakdown = getDiskBreakdown(tempDir);
    const duck = breakdown.find((entry) => entry.path === 'discovery_v3.duckdb');
    const sqlite = breakdown.find((entry) => entry.path === 'copytrade.db');

    assert.equal(duck?.bytes, 200);
    assert.equal(sqlite?.bytes, 100);
  });
});

describe('dataRetention discovery disabled', () => {
  let tempDir = '';
  let originalDiscoveryEnabled: string | undefined;
  let originalDiscoveryV3: string | undefined;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-retention-'));
    originalDiscoveryEnabled = process.env.DISCOVERY_ENABLED;
    originalDiscoveryV3 = process.env.DISCOVERY_V3;
    originalDataDir = process.env.DATA_DIR;
    process.env.DISCOVERY_ENABLED = 'false';
    process.env.DISCOVERY_V3 = 'false';
    process.env.DATA_DIR = tempDir;
  });

  afterEach(async () => {
    try {
      const { closeDatabase } = await import('../src/database.js');
      closeDatabase();
    } catch {
      // ignore
    }
    if (originalDiscoveryEnabled === undefined) delete process.env.DISCOVERY_ENABLED;
    else process.env.DISCOVERY_ENABLED = originalDiscoveryEnabled;
    if (originalDiscoveryV3 === undefined) delete process.env.DISCOVERY_V3;
    else process.env.DISCOVERY_V3 = originalDiscoveryV3;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('purges discovery sqlite rows when discovery is disabled', async () => {
    const configMod = await import('../src/config.js');
    (configMod.config as { dataDir: string }).dataDir = tempDir;

    const { initDatabase, closeDatabase, getDatabase } = await import('../src/database.js');
    const { countDiscoverySqliteRows, purgeAllDiscoveryDataIncludingV3 } = await import(
      '../src/dataRetention.js'
    );
    await initDatabase();
    getDatabase()
      .prepare(
        `INSERT INTO discovery_trades (
          tx_hash, maker, taker, asset_id, side, size, price, source, detected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('0xtx', '0xabc', '0xtaker', 'asset1', 'yes', 1, 0.5, 'test', Date.now());
    assert.ok(countDiscoverySqliteRows() > 0);
    const removed = purgeAllDiscoveryDataIncludingV3();
    assert.ok(removed > 0);
    assert.equal(countDiscoverySqliteRows(), 0);
    closeDatabase();
  });
});
