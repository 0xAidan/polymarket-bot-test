import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { runWithTenant } from '../src/tenantContext.js';
import { PerformanceTracker } from '../src/performanceTracker.js';

let tempDir: string;

describe('PerformanceTracker', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'perf-test-'));
    (config as any).dataDir = tempDir;
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('isolates recent trades by tenant context', async () => {
    const tracker = new PerformanceTracker();

    await runWithTenant('tenant-a', () => tracker.recordTrade({
      timestamp: new Date('2026-03-24T00:00:00.000Z'),
      walletAddress: '0xaaa',
      marketId: 'mkt-a',
      outcome: 'YES',
      amount: '10',
      price: '0.45',
      success: true,
      status: 'executed',
      executionTimeMs: 10,
    }));

    await runWithTenant('tenant-b', () => tracker.recordTrade({
      timestamp: new Date('2026-03-24T00:05:00.000Z'),
      walletAddress: '0xbbb',
      marketId: 'mkt-b',
      outcome: 'NO',
      amount: '5',
      price: '0.55',
      success: false,
      status: 'failed',
      executionTimeMs: 20,
    }));

    const tenantATracker = new PerformanceTracker();
    await runWithTenant('tenant-a', () => tenantATracker.initialize());
    const tenantBTracker = new PerformanceTracker();
    await runWithTenant('tenant-b', () => tenantBTracker.initialize());

    assert.deepEqual(
      runWithTenant('tenant-a', () => tenantATracker.getRecentTrades().map(trade => trade.marketId)),
      ['mkt-a'],
    );
    assert.deepEqual(
      runWithTenant('tenant-b', () => tenantBTracker.getRecentTrades().map(trade => trade.marketId)),
      ['mkt-b'],
    );
  });
});
