import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { closeDatabase, getDatabase, initDatabase } from '../src/database.js';
import { getDiscoveryMarketPool } from '../src/discovery/categorySeeder.ts';
import { getLatestDiscoveryRunLog } from '../src/discovery/runLog.ts';
import { getWalletScoreRow, getWalletScoreRowV2 } from '../src/discovery/discoveryScorer.ts';
import { getWalletValidation } from '../src/discovery/walletValidator.ts';
import { getWalletCandidates, getWalletCandidatesV2 } from '../src/discovery/walletSeedEngine.ts';
import { DiscoveryWorkerRuntime } from '../src/discovery/discoveryWorker.ts';
import { updateDiscoveryConfig } from '../src/discovery/statsStore.js';
import { getLatestDiscoveryEvaluationSnapshot } from '../src/discovery/evaluationEngine.ts';

test('DiscoveryWorkerRuntime runs an end-to-end free-mode discovery cycle', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-worker-runtime-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();
  updateDiscoveryConfig({ enabled: true, marketCount: 1 });

  try {
    const runtime = new DiscoveryWorkerRuntime({
      now: () => 1710000000,
      marketSeedLimit: 1,
      leaderboardCategories: ['POLITICS'],
      leaderboardWindows: ['WEEK'],
      fetchActiveEvents: async () => [
        {
          id: 'event-1',
          slug: 'fed-rates',
          title: 'Fed Rates',
          tags: [{ slug: 'economics', label: 'Economics' }],
          markets: [
            {
              id: 'market-1',
              conditionId: 'condition-fed',
              slug: 'will-the-fed-cut-rates-in-june',
              question: 'Will the Fed cut rates in June?',
              clobTokenIds: JSON.stringify(['yes-fed', 'no-fed']),
              outcomes: ['Yes', 'No'],
              volume24hr: '450000',
              acceptingOrders: true,
              competitive: true,
            },
          ],
        },
      ],
      fetchLeaderboard: async () => [
        { proxyWallet: '0xabc', rank: 1, pnl: 500, vol: 10000 },
      ],
      fetchMarketPositions: async () => [
        { positions: [{ proxyWallet: '0xabc', totalPnl: 400, currentValue: 1000 }] },
      ],
      fetchHolders: async () => [{ proxyWallet: '0xabc', size: 1000 }],
      fetchTrades: async () => [{ proxyWallet: '0xabc', size: 100, price: 0.4 }],
      fetchProfile: async () => ({ name: 'Macro Alpha', pseudonym: 'macro-alpha', verifiedBadge: true }),
      fetchTraded: async () => ({ traded: 8 }),
      fetchPositions: async () => [{ conditionId: 'condition-fed' }],
      fetchClosedPositions: async () => [{ realizedPnl: 120 }],
      fetchActivity: async () => [{ type: 'TRADE', side: 'BUY', marketSlug: 'fed-rates' }],
      fetchMarketContext: async () => ({ averageSpreadBps: 20, averageTopOfBookUsd: 5000 }),
    });

    await runtime.runCycle();

    assert.equal(getDiscoveryMarketPool(10).length, 1);
    assert.equal(getWalletCandidates(10).length > 0, true);
    assert.equal(getWalletCandidatesV2(10).length > 0, true);
    assert.equal(getWalletValidation('0xabc')?.realizedPnl, 120);
    assert.equal((getWalletScoreRow('0xabc')?.finalScore ?? 0) > 0, true);
    assert.equal((getWalletScoreRowV2('0xabc')?.discoveryScore ?? 0) > 0, true);
    const candidateHistoryCount = (getDatabase().prepare(
      'SELECT COUNT(*) AS cnt FROM discovery_wallet_candidates_v2'
    ).get() as { cnt: number }).cnt;
    assert.equal(candidateHistoryCount > 0, true);
    assert.equal(getLatestDiscoveryRunLog()?.candidateCount, 1);
    assert.equal((getLatestDiscoveryEvaluationSnapshot()?.sampleSize ?? 0) >= 1, true);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('DiscoveryWorkerRuntime start honors saved discovery enabled flag', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-worker-disabled-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();
  updateDiscoveryConfig({ enabled: false });

  let fetches = 0;

  try {
    const runtime = new DiscoveryWorkerRuntime({
      fetchActiveEvents: async () => {
        fetches += 1;
        return [];
      },
    });

    await runtime.start();
    await runtime.stop();

    assert.equal(fetches, 0);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('DiscoveryWorkerRuntime uses saved marketCount to cap seeded markets', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-worker-market-count-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();
  updateDiscoveryConfig({ enabled: true, marketCount: 1 });

  let marketPositionCalls = 0;

  try {
    const runtime = new DiscoveryWorkerRuntime({
      now: () => 1710000000,
      fetchActiveEvents: async () => [
        {
          id: 'event-1',
          slug: 'macro-1',
          title: 'Macro 1',
          tags: [{ slug: 'economics', label: 'Economics' }],
          markets: [
            {
              id: 'market-1',
              conditionId: 'condition-1',
              slug: 'market-1',
              question: 'Market 1',
              clobTokenIds: JSON.stringify(['yes-1', 'no-1']),
              outcomes: ['Yes', 'No'],
            },
          ],
        },
        {
          id: 'event-2',
          slug: 'macro-2',
          title: 'Macro 2',
          tags: [{ slug: 'economics', label: 'Economics' }],
          markets: [
            {
              id: 'market-2',
              conditionId: 'condition-2',
              slug: 'market-2',
              question: 'Market 2',
              clobTokenIds: JSON.stringify(['yes-2', 'no-2']),
              outcomes: ['Yes', 'No'],
            },
          ],
        },
      ],
      fetchLeaderboard: async () => [],
      fetchMarketPositions: async () => {
        marketPositionCalls += 1;
        return [];
      },
      fetchHolders: async () => [],
      fetchTrades: async () => [],
      fetchProfile: async () => null,
      fetchTraded: async () => null,
      fetchPositions: async () => [],
      fetchClosedPositions: async () => [],
      fetchActivity: async () => [],
      fetchMarketContext: async () => ({ averageSpreadBps: 20, averageTopOfBookUsd: 5000 }),
    });

    await runtime.runCycle();

    assert.equal(marketPositionCalls, 1);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('DiscoveryWorkerRuntime records budget and acceptance metrics in the run log', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-worker-metrics-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();
  updateDiscoveryConfig({ enabled: true, marketCount: 1 });

  try {
    const runtime = new DiscoveryWorkerRuntime({
      now: () => 1710000000,
      marketSeedLimit: 1,
      leaderboardCategories: ['POLITICS'],
      leaderboardWindows: ['WEEK'],
      fetchActiveEvents: async () => [
        {
          id: 'event-1',
          slug: 'fed-rates',
          title: 'Fed Rates',
          tags: [{ slug: 'economics', label: 'Economics' }],
          markets: [
            {
              id: 'market-1',
              conditionId: 'condition-fed',
              slug: 'will-the-fed-cut-rates-in-june',
              question: 'Will the Fed cut rates in June?',
              clobTokenIds: JSON.stringify(['yes-fed', 'no-fed']),
              outcomes: ['Yes', 'No'],
              volume24hr: '450000',
              acceptingOrders: true,
              competitive: true,
            },
          ],
        },
      ],
      fetchLeaderboard: async () => [
        { proxyWallet: '0xabc', rank: 1, pnl: 500, vol: 10000 },
      ],
      fetchMarketPositions: async () => [
        { positions: [{ proxyWallet: '0xabc', totalPnl: 400, currentValue: 1000 }] },
      ],
      fetchHolders: async () => [{ proxyWallet: '0xabc', size: 1000 }],
      fetchTrades: async () => [{ proxyWallet: '0xabc', size: 100, price: 0.4 }],
      fetchProfile: async () => ({ name: 'Macro Alpha', pseudonym: 'macro-alpha', verifiedBadge: true }),
      fetchTraded: async () => ({ traded: 8 }),
      fetchPositions: async () => [{ conditionId: 'condition-fed' }],
      fetchClosedPositions: async () => [{ realizedPnl: 120 }],
      fetchActivity: async () => [{ type: 'TRADE', side: 'BUY', marketSlug: 'fed-rates' }],
      fetchMarketContext: async () => ({ averageSpreadBps: 20, averageTopOfBookUsd: 5000 }),
    });

    await runtime.runCycle();

    const runLog = getLatestDiscoveryRunLog();

    assert.ok(runLog, 'expected discovery run log to exist');
    assert.equal(runLog?.freeModeNoAlchemy, true);
    assert.equal(runLog?.categoryPurityPct, 100);
    assert.equal(runLog?.copyabilityPassPct, 100);
    assert.equal(runLog?.walletsWithTwoReasonsPct, 100);
    assert.equal(typeof runLog?.estimatedCostUsd, 'number');
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('DiscoveryWorkerRuntime preserves feature snapshot history across cycles', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-worker-feature-history-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();
  updateDiscoveryConfig({ enabled: true, marketCount: 1 });

  try {
    const runtime = new DiscoveryWorkerRuntime({
      now: (() => {
        const runTimes = [1710000000, 1710000600];
        let index = 0;
        return () => runTimes[Math.min(index++, runTimes.length - 1)];
      })(),
      marketSeedLimit: 1,
      leaderboardCategories: ['SPORTS'],
      leaderboardWindows: ['WEEK'],
      fetchActiveEvents: async () => [
        {
          id: 'event-1',
          slug: 'lakers-celtics',
          title: 'Lakers vs Celtics',
          tags: [{ slug: 'sports', label: 'Sports' }],
          markets: [
            {
              id: 'market-1',
              conditionId: 'condition-sports',
              slug: 'will-the-lakers-win',
              question: 'Will the Lakers win?',
              clobTokenIds: JSON.stringify(['yes-sports', 'no-sports']),
              outcomes: ['Yes', 'No'],
              volume24hr: '250000',
              acceptingOrders: true,
              competitive: true,
            },
          ],
        },
      ],
      fetchLeaderboard: async () => [
        { proxyWallet: '0xsports', rank: 1, pnl: 500, vol: 10000 },
      ],
      fetchMarketPositions: async () => [
        { positions: [{ proxyWallet: '0xsports', totalPnl: 400, currentValue: 1000 }] },
      ],
      fetchHolders: async () => [{ proxyWallet: '0xsports', size: 1000 }],
      fetchTrades: async () => [{ proxyWallet: '0xsports', size: 100, price: 0.4 }],
      fetchProfile: async () => ({ name: 'Sports Alpha', pseudonym: 'sports-alpha', verifiedBadge: true }),
      fetchTraded: async () => ({ traded: 8 }),
      fetchPositions: async () => [{ conditionId: 'condition-sports' }],
      fetchClosedPositions: async () => [{ realizedPnl: 120 }],
      fetchActivity: async () => [{ type: 'TRADE', side: 'BUY', marketSlug: 'lakers-celtics' }],
      fetchMarketContext: async () => ({ averageSpreadBps: 20, averageTopOfBookUsd: 5000 }),
    });

    await runtime.runCycle();
    await runtime.runCycle();

    const historyCount = (getDatabase().prepare(`
      SELECT COUNT(*) AS cnt
      FROM discovery_wallet_feature_history_v2
      WHERE address = ?
    `).get('0xsports') as { cnt: number }).cnt;

    assert.equal(historyCount, 2);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('DiscoveryWorkerRuntime defaults leaderboard seeding to sports-first scope', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-worker-sports-default-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();
  updateDiscoveryConfig({ enabled: true, marketCount: 1 });

  const requestedCategories: string[] = [];

  try {
    const runtime = new DiscoveryWorkerRuntime({
      now: () => 1710000000,
      marketSeedLimit: 1,
      fetchActiveEvents: async () => [],
      fetchLeaderboard: async (category: string) => {
        requestedCategories.push(category);
        return [];
      },
      fetchMarketPositions: async () => [],
      fetchHolders: async () => [],
      fetchTrades: async () => [],
      fetchProfile: async () => null,
      fetchTraded: async () => null,
      fetchPositions: async () => [],
      fetchClosedPositions: async () => [],
      fetchActivity: async () => [],
      fetchMarketContext: async () => ({ averageSpreadBps: 20, averageTopOfBookUsd: 5000 }),
    });

    await runtime.runCycle();

    assert.deepEqual([...new Set(requestedCategories)], ['SPORTS']);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
