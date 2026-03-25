import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { runWithTenant, getTenantIdOrDefault } from '../src/tenantContext.js';
import { BalanceTracker } from '../src/balanceTracker.js';

let tempDir: string;

describe('BalanceTracker', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'balance-test-'));
    (config as any).dataDir = tempDir;
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('isolates balance history by tenant context', async () => {
    const tracker = new BalanceTracker();
    (tracker as any).getBalance = async () => (
      getTenantIdOrDefault() === 'tenant-a' ? 100 : 200
    );

    await runWithTenant('tenant-a', () => tracker.recordBalance('0xSameWallet'));
    await runWithTenant('tenant-b', () => tracker.recordBalance('0xSameWallet'));

    const tenantAHistory = runWithTenant('tenant-a', () => tracker.getBalanceHistory('0xSameWallet'));
    const tenantBHistory = runWithTenant('tenant-b', () => tracker.getBalanceHistory('0xSameWallet'));

    assert.equal(tenantAHistory.length, 1);
    assert.equal(tenantBHistory.length, 1);
    assert.equal(tenantAHistory[0].balance, 100);
    assert.equal(tenantBHistory[0].balance, 200);
  });
});
