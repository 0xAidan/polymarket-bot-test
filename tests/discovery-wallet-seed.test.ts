import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { closeDatabase, initDatabase } from '../src/database.js';
import {
  buildHolderSeedCandidates,
  buildLeaderboardSeedCandidates,
  buildMarketPositionSeedCandidates,
  buildTradeSeedCandidates,
  getWalletCandidates,
  upsertWalletCandidates,
} from '../src/discovery/walletSeedEngine.ts';

test('buildLeaderboardSeedCandidates converts ranked rows into wallet candidates', () => {
  const candidates = buildLeaderboardSeedCandidates(
    [
      { proxyWallet: '0xABC', userName: 'alpha', rank: 2, pnl: 1200, vol: 30000 },
    ],
    { category: 'POLITICS', timePeriod: 'WEEK', detectedAt: 1710000000 },
  );

  assert.deepEqual(candidates, [
    {
      address: '0xabc',
      sourceType: 'leaderboard',
      sourceLabel: 'POLITICS:WEEK',
      conditionId: undefined,
      marketTitle: undefined,
      sourceRank: 2,
      sourceMetric: 1200,
      sourceMetadata: { userName: 'alpha', volume: 30000 },
      firstSeenAt: 1710000000,
      lastSeenAt: 1710000000,
      updatedAt: 1710000000,
    },
  ]);
});

test('buildMarketPositionSeedCandidates flattens market-position rows into wallet candidates', () => {
  const candidates = buildMarketPositionSeedCandidates(
    [
      {
        positions: [
          {
            proxyWallet: '0xAAA',
            name: 'Macro Whale',
            totalPnl: 4500,
            currentValue: 12000,
          },
        ],
      },
    ],
    {
      conditionId: 'condition-fed',
      marketTitle: 'Will the Fed cut rates in June?',
      detectedAt: 1710000000,
    },
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.address, '0xaaa');
  assert.equal(candidates[0]?.sourceType, 'market-positions');
  assert.equal(candidates[0]?.conditionId, 'condition-fed');
  assert.equal(candidates[0]?.sourceMetric, 4500);
});

test('buildHolderSeedCandidates preserves top-holder source order and size', () => {
  const candidates = buildHolderSeedCandidates(
    [
      { proxyWallet: '0xHOLDER', size: 22000 },
    ],
    {
      conditionId: 'condition-fed',
      marketTitle: 'Will the Fed cut rates in June?',
      detectedAt: 1710000000,
    },
  );

  assert.equal(candidates[0]?.address, '0xholder');
  assert.equal(candidates[0]?.sourceType, 'holders');
  assert.equal(candidates[0]?.sourceMetric, 22000);
});

test('buildTradeSeedCandidates prefers proxyWallet and skips rows without an address', () => {
  const candidates = buildTradeSeedCandidates(
    [
      { proxyWallet: '0xTRADE', size: 100, price: 0.62 },
      { size: 50, price: 0.4 },
    ],
    {
      conditionId: 'condition-fed',
      marketTitle: 'Will the Fed cut rates in June?',
      detectedAt: 1710000000,
    },
  );

  assert.deepEqual(candidates, [
    {
      address: '0xtrade',
      sourceType: 'trades',
      sourceLabel: 'recent-trades',
      conditionId: 'condition-fed',
      marketTitle: 'Will the Fed cut rates in June?',
      sourceRank: undefined,
      sourceMetric: 62,
      sourceMetadata: { price: 0.62, size: 100 },
      firstSeenAt: 1710000000,
      lastSeenAt: 1710000000,
      updatedAt: 1710000000,
    },
  ]);
});

test('wallet candidates are upserted and ordered by recency and source strength', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-wallet-candidates-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    upsertWalletCandidates([
      {
        address: '0xaaa',
        sourceType: 'leaderboard',
        sourceLabel: 'POLITICS:WEEK',
        sourceRank: 1,
        sourceMetric: 9000,
        firstSeenAt: 1710000000,
        lastSeenAt: 1710000000,
        updatedAt: 1710000000,
      },
      {
        address: '0xbbb',
        sourceType: 'market-positions',
        sourceLabel: 'market-positions',
        conditionId: 'condition-fed',
        sourceMetric: 4500,
        firstSeenAt: 1710000010,
        lastSeenAt: 1710000010,
        updatedAt: 1710000010,
      },
    ]);

    const candidates = getWalletCandidates(10);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]?.address, '0xbbb');
    assert.equal(candidates[1]?.address, '0xaaa');
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
