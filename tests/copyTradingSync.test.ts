import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { closeDatabase, dbLoadConfig } from '../src/database.js';
import { Storage } from '../src/storage.js';
import { runWithTenant } from '../src/tenantContext.js';
import {
  migrateCopyTradingPreferences,
  anyTenantWantsCopyTrading,
  syncCopyTraderState,
  getCopyTradingEnabledForTenant,
  COPY_TRADING_ENABLED_KEY,
} from '../src/copyTradingSync.js';

const tempDir = mkdtempSync(join(tmpdir(), 'copy-trading-sync-test-'));
let testSubDir: string;
let testNum = 0;

const enableWallet = async (address: string) => {
  await Storage.addWallet(address);
  await Storage.updateWalletTradeConfig(address, {
    tradeSizingMode: 'fixed',
    fixedTradeSize: 5,
  });
  await Storage.toggleWalletActive(address, true);
};

describe('copyTradingSync', () => {
  beforeEach(() => {
    testNum += 1;
    testSubDir = join(tempDir, `test-${testNum}`);
    (config as any).dataDir = testSubDir;
    (config as any).storageBackend = 'sqlite';
    delete process.env.COPY_TRADING_FORCE_DISABLED;
  });

  afterEach(() => {
    closeDatabase();
    if (existsSync(testSubDir)) {
      rmSync(testSubDir, { recursive: true, force: true });
    }
    delete process.env.COPY_TRADING_FORCE_DISABLED;
  });

  it('migration enables copying for tenants with active wallets when preference is missing', async () => {
    await runWithTenant('tenant-a', async () => {
      await enableWallet('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    const before = dbLoadConfig('tenant-a');
    assert.equal(before[COPY_TRADING_ENABLED_KEY], undefined);

    await migrateCopyTradingPreferences();

    assert.equal(getCopyTradingEnabledForTenant('tenant-a'), true);
  });

  it('anyTenantWantsCopyTrading stays true when another tenant still has copying enabled', async () => {
    await runWithTenant('tenant-a', async () => {
      await enableWallet('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      await Storage.setCopyTradingEnabled(true);
    });

    await runWithTenant('tenant-b', async () => {
      await enableWallet('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      await Storage.setCopyTradingEnabled(true);
      await Storage.setCopyTradingEnabled(false);
    });

    assert.equal(await anyTenantWantsCopyTrading(), true);
  });

  it('syncCopyTraderState starts the monitor when any tenant wants copying', async () => {
    await runWithTenant('tenant-a', async () => {
      await enableWallet('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      await Storage.setCopyTradingEnabled(true);
    });

    let started = false;
    await syncCopyTraderState({
      start: async () => {
        started = true;
      },
      stop: () => {},
    });

    assert.equal(started, true);
  });

  it('syncCopyTraderState stops the monitor when no tenant wants copying', async () => {
    await runWithTenant('tenant-a', async () => {
      await enableWallet('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      await Storage.setCopyTradingEnabled(false);
    });

    let stopped = false;
    await syncCopyTraderState({
      start: async () => {},
      stop: () => {
        stopped = true;
      },
    });

    assert.equal(stopped, true);
  });

  it('syncCopyTraderState stops when COPY_TRADING_FORCE_DISABLED is set', async () => {
    await runWithTenant('tenant-a', async () => {
      await enableWallet('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      await Storage.setCopyTradingEnabled(true);
    });

    process.env.COPY_TRADING_FORCE_DISABLED = 'true';

    let started = false;
    let stopped = false;
    await syncCopyTraderState({
      start: async () => {
        started = true;
      },
      stop: () => {
        stopped = true;
      },
    });

    assert.equal(started, false);
    assert.equal(stopped, true);
  });

  it('Storage copy trading preference roundtrip', async () => {
    await runWithTenant('tenant-a', async () => {
      assert.equal(await Storage.getCopyTradingEnabled(), false);
      await Storage.setCopyTradingEnabled(true);
      assert.equal(await Storage.getCopyTradingEnabled(), true);
    });
  });
});
