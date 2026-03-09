import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { closeDatabase, initDatabase } from '../src/database.js';
import { DiscoveryControlPlane } from '../src/discovery/discoveryControlPlane.ts';
import { buildWalletScoreRow, replaceWalletReasons, upsertWalletScoreRow } from '../src/discovery/discoveryScorer.ts';
import { upsertWalletCandidates } from '../src/discovery/walletSeedEngine.ts';
import { upsertWalletValidation } from '../src/discovery/walletValidator.ts';

test('DiscoveryControlPlane includes unvalidated candidates as needs-validation rows', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-control-plane-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    upsertWalletCandidates([{
      address: '0xneedsvalidation',
      sourceType: 'leaderboard',
      sourceLabel: 'POLITICS_WEEK',
      conditionId: 'condition-1',
      marketTitle: 'Fed Rates',
      sourceRank: 1,
      sourceMetric: 9000,
      sourceMetadata: { category: 'POLITICS' },
      firstSeenAt: 1710000000,
      lastSeenAt: 1710000000,
      updatedAt: 1710000000,
    }]);

    const wallets = new DiscoveryControlPlane().getWallets('volume', 50, 0);
    const wallet = wallets.find((row: any) => row.address === '0xneedsvalidation');

    assert.ok(wallet, 'expected pending candidate to appear in discovery feed');
    assert.equal(wallet.discoveryState, 'Needs Validation');
    assert.equal(wallet.whyNotTracked, 'Waiting for official wallet validation before it can be promoted.');
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('DiscoveryControlPlane exposes reason codes and change summaries for scored wallets', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-control-plane-scored-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    upsertWalletCandidates([{
      address: '0xscoredwallet',
      sourceType: 'leaderboard',
      sourceLabel: 'POLITICS_WEEK',
      conditionId: 'condition-1',
      marketTitle: 'Fed Rates',
      sourceRank: 1,
      sourceMetric: 12000,
      sourceMetadata: { category: 'POLITICS' },
      firstSeenAt: 1710000000,
      lastSeenAt: 1710000000,
      updatedAt: 1710000000,
    }]);

    upsertWalletValidation({
      address: '0xscoredwallet',
      openPositionsCount: 1,
      closedPositionsCount: 2,
      realizedPnl: 300,
      realizedWinRate: 66,
      makerRebateCount: 0,
      tradeActivityCount: 4,
      buyActivityCount: 3,
      sellActivityCount: 1,
      marketsTouched: 3,
      lastValidatedAt: 1710000000,
    });

    upsertWalletScoreRow(buildWalletScoreRow({
      address: '0xscoredwallet',
      profitabilityScore: 58,
      focusScore: 56,
      copyabilityScore: 60,
      earlyScore: 12,
      consistencyScore: 40,
      convictionScore: 20,
      noisePenalty: 0,
      updatedAt: 1710000000,
    }));

    upsertWalletScoreRow(buildWalletScoreRow({
      address: '0xscoredwallet',
      profitabilityScore: 72,
      focusScore: 68,
      copyabilityScore: 74,
      earlyScore: 18,
      consistencyScore: 48,
      convictionScore: 24,
      noisePenalty: 0,
      updatedAt: 1710003600,
    }));

    replaceWalletReasons('0xscoredwallet', [
      {
        address: '0xscoredwallet',
        reasonType: 'supporting',
        reasonCode: 'profitability',
        message: 'Shows repeat realized profitability.',
        createdAt: 1710003600,
      },
      {
        address: '0xscoredwallet',
        reasonType: 'supporting',
        reasonCode: 'focus',
        message: 'Activity is concentrated in the whitelisted discovery categories.',
        createdAt: 1710003600,
      },
    ], 1710003600);

    const wallets = new DiscoveryControlPlane().getWallets('score', 50, 0);
    const wallet = wallets.find((row: any) => row.address === '0xscoredwallet');

    assert.ok(wallet, 'expected scored wallet to appear in discovery feed');
    assert.deepEqual(wallet.reasonCodes, ['focus', 'profitability']);
    assert.equal(wallet.discoveryState, 'Qualified');
    assert.match(wallet.whatChanged, /score improved/i);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
