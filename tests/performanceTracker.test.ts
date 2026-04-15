import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import type { TradeMetrics } from '../src/types.js';
import { config } from '../src/config.js';
import { runWithTenant } from '../src/tenantContext.js';
import { PerformanceTracker } from '../src/performanceTracker.js';

let tempDir: string;

/** Minimal fields for recordTrade (id added by tracker). */
function tradePayload(overrides: Partial<Omit<TradeMetrics, 'id'>>): Omit<TradeMetrics, 'id'> {
  return {
    timestamp: new Date(),
    walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    marketId: 'mkt-default',
    outcome: 'YES',
    amount: '10',
    price: '0.5',
    success: true,
    status: 'executed',
    executionTimeMs: 100,
    detectedTxHash: `0x${'a'.repeat(64)}`,
    ...overrides,
  };
}

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

    await runWithTenant('tenant-a', () => tracker.recordTrade(tradePayload({
      timestamp: new Date('2026-03-24T00:00:00.000Z'),
      walletAddress: '0xaaa',
      marketId: 'mkt-a',
      detectedTxHash: `0x${'1'.repeat(64)}`,
    })));

    await runWithTenant('tenant-b', () => tracker.recordTrade(tradePayload({
      timestamp: new Date('2026-03-24T00:05:00.000Z'),
      walletAddress: '0xbbb',
      marketId: 'mkt-b',
      success: false,
      status: 'failed',
      executionTimeMs: 20,
      detectedTxHash: `0x${'2'.repeat(64)}`,
    })));

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

  describe('getStats (performance tab summary)', () => {
    it('returns zeros when no trades recorded', async () => {
      const tracker = new PerformanceTracker();
      await tracker.initialize();
      const stats = await tracker.getStats(4);
      assert.equal(stats.totalTrades, 0);
      assert.equal(stats.successfulTrades, 0);
      assert.equal(stats.failedTrades, 0);
      assert.equal(stats.successRate, 0);
      assert.equal(stats.averageLatencyMs, 0);
      assert.equal(stats.walletsTracked, 4);
      assert.equal(stats.totalVolume, '0');
    });

    it('computes success rate, counts, latency mean, and volume', async () => {
      const tracker = new PerformanceTracker();
      await tracker.initialize();
      const recent = Date.now();
      await tracker.recordTrade(tradePayload({
        timestamp: new Date(recent - 60_000),
        executionTimeMs: 10,
        success: true,
        detectedTxHash: `0x${'b'.repeat(64)}`,
      }));
      await tracker.recordTrade(tradePayload({
        timestamp: new Date(recent - 45_000),
        marketId: 'mkt-2',
        executionTimeMs: 40,
        success: true,
        detectedTxHash: `0x${'c'.repeat(64)}`,
      }));
      await tracker.recordTrade(tradePayload({
        timestamp: new Date(recent - 30_000),
        marketId: 'mkt-3',
        amount: '5',
        success: false,
        status: 'failed',
        executionTimeMs: 20,
        detectedTxHash: `0x${'d'.repeat(64)}`,
      }));

      const stats = await tracker.getStats(2);
      assert.equal(stats.totalTrades, 3);
      assert.equal(stats.successfulTrades, 2);
      assert.equal(stats.failedTrades, 1);
      assert.equal(stats.successRate, 66.67);
      assert.equal(stats.averageLatencyMs, 23);
      assert.equal(stats.totalVolume, '25');
      assert.equal(stats.walletsTracked, 2);
      assert.ok(stats.tradesLast24h >= 3);
      assert.ok(stats.tradesLastHour >= 3);
    });
  });

  describe('getRecentTrades', () => {
    it('returns newest first and respects limit', async () => {
      const tracker = new PerformanceTracker();
      await tracker.initialize();
      const base = Date.UTC(2026, 5, 1, 12, 0, 0);
      for (let i = 1; i <= 5; i += 1) {
        await tracker.recordTrade(tradePayload({
          timestamp: new Date(base + i * 60_000),
          marketId: `mkt-${i}`,
          detectedTxHash: `0x${String(i).padStart(64, '0')}`,
        }));
      }
      const recent = tracker.getRecentTrades(3);
      assert.equal(recent.length, 3);
      assert.deepEqual(recent.map(t => t.marketId), ['mkt-5', 'mkt-4', 'mkt-3']);
    });
  });

  describe('getPerformanceData (chart series)', () => {
    it('returns a single starting point when there are no metrics', async () => {
      const tracker = new PerformanceTracker();
      await tracker.initialize();
      const points = tracker.getPerformanceData(750);
      assert.equal(points.length, 1);
      assert.equal(points[0].balance, 750);
      assert.equal(points[0].totalTrades, 0);
      assert.equal(points[0].successfulTrades, 0);
      assert.equal(points[0].cumulativeVolume, 0);
    });

    it('accumulates volume and applies estimated PnL only for successful trades', async () => {
      const tracker = new PerformanceTracker();
      await tracker.initialize();
      const t0 = Date.UTC(2026, 5, 1, 10, 0, 0);
      await tracker.recordTrade(tradePayload({
        timestamp: new Date(t0),
        amount: '10',
        price: '0.5',
        success: true,
        marketId: 'm-a',
        detectedTxHash: `0x${'e'.repeat(64)}`,
      }));
      await tracker.recordTrade(tradePayload({
        timestamp: new Date(t0 + 60_000),
        amount: '4',
        price: '0.25',
        success: false,
        status: 'failed',
        marketId: 'm-b',
        detectedTxHash: `0x${'f'.repeat(64)}`,
      }));

      const points = tracker.getPerformanceData(1000);
      assert.ok(points.length >= 3);
      const last = points[points.length - 1];
      assert.equal(last.cumulativeVolume, 14);
      assert.equal(last.successfulTrades, 1);
      const estimatedPnL = 10 * 0.5 * 0.02;
      assert.ok(Math.abs(last.balance - (1000 + estimatedPnL)) < 1e-9);
    });
  });

  describe('getWalletStats', () => {
    it('filters metrics by wallet address case-insensitively', async () => {
      const tracker = new PerformanceTracker();
      await tracker.initialize();
      const addr = '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefabcd';
      await tracker.recordTrade(tradePayload({
        walletAddress: addr,
        marketId: 'w1',
        detectedTxHash: `0x${'1'.repeat(64)}`,
      }));
      await tracker.recordTrade(tradePayload({
        walletAddress: addr.toLowerCase(),
        marketId: 'w2',
        success: false,
        status: 'rejected',
        executionTimeMs: 50,
        detectedTxHash: `0x${'2'.repeat(64)}`,
      }));
      await tracker.recordTrade(tradePayload({
        walletAddress: '0x9999999999999999999999999999999999999999',
        marketId: 'w3',
        detectedTxHash: `0x${'3'.repeat(64)}`,
      }));

      const w = tracker.getWalletStats(addr);
      assert.equal(w.tradesCopied, 2);
      assert.equal(w.successfulCopies, 1);
      assert.equal(w.failedCopies, 1);
      assert.equal(w.successRate, 50);
      assert.equal(w.averageLatencyMs, 75);
    });
  });

  describe('deduplication', () => {
    it('does not record the same logical trade twice within the 5-minute window', async () => {
      const tracker = new PerformanceTracker();
      await tracker.initialize();
      const ts = new Date('2026-07-01T15:00:00.000Z');
      const payload = tradePayload({
        timestamp: ts,
        marketId: 'same-mkt',
        detectedTxHash: `0x${'4'.repeat(64)}`,
      });
      await tracker.recordTrade(payload);
      await tracker.recordTrade({ ...payload, detectedTxHash: `0x${'5'.repeat(64)}` });

      const stats = await tracker.getStats(0);
      assert.equal(stats.totalTrades, 1);
    });
  });

  describe('persistence', () => {
    it('reloads metrics from disk in a new tracker instance', async () => {
      const a = new PerformanceTracker();
      await a.initialize();
      await a.recordTrade(tradePayload({
        marketId: 'persist-1',
        detectedTxHash: `0x${'6'.repeat(64)}`,
      }));
      await a.recordTrade(tradePayload({
        marketId: 'persist-2',
        success: false,
        status: 'failed',
        detectedTxHash: `0x${'7'.repeat(64)}`,
      }));

      const b = new PerformanceTracker();
      await b.initialize();
      const stats = await b.getStats(1);
      assert.equal(stats.totalTrades, 2);
      assert.equal(stats.successfulTrades, 1);
      assert.equal(stats.failedTrades, 1);
    });
  });
});
