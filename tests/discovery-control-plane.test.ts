import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { closeDatabase, initDatabase } from '../src/database.js';
import { DiscoveryControlPlane } from '../src/discovery/discoveryControlPlane.ts';
import { buildReasonPayloadV2, buildWalletScoreRow, replaceWalletReasons, upsertWalletScoreRow, upsertWalletScoreRowV2 } from '../src/discovery/discoveryScorer.ts';
import { upsertWalletFeatureSnapshotV2 } from '../src/discovery/v2DataStore.ts';
import { upsertWalletCandidates, upsertWalletCandidatesV2 } from '../src/discovery/walletSeedEngine.ts';
import { upsertWalletValidation } from '../src/discovery/walletValidator.ts';
import { evaluateAndPersistAllocationPolicies } from '../src/allocation/policyEngine.ts';
import { updateDiscoveryConfig } from '../src/discovery/statsStore.ts';

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
    assert.equal(wallet.schemaVersion, 2);
    assert.equal(typeof wallet.displayName, 'string');
    assert.equal(typeof wallet.discoveryScore, 'number');
    assert.equal(typeof wallet.trustScore, 'number');
    assert.equal(typeof wallet.copyabilityScore, 'number');
    assert.equal(typeof wallet.confidence, 'string');
    assert.equal(typeof wallet.surfaceBucket, 'string');
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('DiscoveryControlPlane prefers persisted v2 provenance for supporting markets and channels', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-control-plane-v2-provenance-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    upsertWalletCandidates([{
      address: '0xprovenancewallet',
      sourceType: 'leaderboard',
      sourceLabel: 'SPORTS_WEEK',
      conditionId: 'condition-1',
      marketTitle: 'Fallback Market',
      sourceRank: 1,
      sourceMetric: 12000,
      sourceMetadata: { category: 'SPORTS' },
      firstSeenAt: 1710000000,
      lastSeenAt: 1710000000,
      updatedAt: 1710000000,
    }]);

    upsertWalletValidation({
      address: '0xprovenancewallet',
      openPositionsCount: 1,
      closedPositionsCount: 3,
      realizedPnl: 420,
      realizedWinRate: 70,
      makerRebateCount: 0,
      tradeActivityCount: 6,
      buyActivityCount: 4,
      sellActivityCount: 2,
      marketsTouched: 4,
      lastValidatedAt: 1710000000,
    });

    const row = buildWalletScoreRow({
      address: '0xprovenancewallet',
      profitabilityScore: 72,
      focusScore: 68,
      copyabilityScore: 74,
      earlyScore: 18,
      consistencyScore: 48,
      convictionScore: 24,
      noisePenalty: 0,
      trustScore: 71,
      strategyClass: 'informational_directional',
      confidenceBucket: 'high',
      scoreVersion: 2,
      updatedAt: 1710003600,
    });
    upsertWalletScoreRow(row);
    upsertWalletScoreRowV2(row, buildReasonPayloadV2(row, [
      {
        address: row.address,
        reasonType: 'supporting',
        reasonCode: 'sports_focus',
        message: 'Shows repeat sports edge.',
        createdAt: 1710003600,
      },
    ]));
    upsertWalletFeatureSnapshotV2({
      address: '0xprovenancewallet',
      runTimestamp: 1710003600,
      focusCategory: 'sports',
      strategyClass: 'informational_directional',
      confidenceBucket: 'high',
      sourceChannels: ['leaderboard', 'trades'],
      supportingMarkets: ['Lakers vs Celtics', 'Warriors vs Suns'],
      featureSnapshot: {
        marketSelectionScore: 66,
        categoryFocusScore: 72,
        consistencyScore: 59,
        convictionScore: 62,
        trustScore: 71,
        integrityPenalty: 3,
        confidenceEvidenceCount: 8,
        cautionFlags: [],
      },
      metrics: {
        averageSpreadBps: 18,
        averageTopOfBookUsd: 7200,
        latestTradePrice: 0.44,
        currentPrice: 0.51,
      },
    });

    const wallets = new DiscoveryControlPlane().getWallets('trust', 50, 0);
    const wallet = wallets.find((entry: any) => entry.address === '0xprovenancewallet');

    assert.ok(wallet, 'expected wallet to appear in trust feed');
    assert.deepEqual(wallet.supportingMarkets, ['Lakers vs Celtics', 'Warriors vs Suns']);
    assert.deepEqual(wallet.sourceChannels, ['leaderboard', 'trades']);
    assert.equal(wallet.evidenceCount, 8);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('DiscoveryControlPlane can surface pending candidates from the v2 candidate snapshot without legacy rows', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-control-plane-v2-candidates-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    upsertWalletCandidatesV2([{
      address: '0xv2candidate',
      sourceType: 'leaderboard',
      sourceLabel: 'SPORTS_WEEK',
      conditionId: 'condition-v2',
      marketTitle: 'Lakers vs Celtics',
      sourceRank: 1,
      sourceMetric: 9000,
      sourceMetadata: { category: 'SPORTS' },
      firstSeenAt: 1710000000,
      lastSeenAt: 1710000000,
      updatedAt: 1710000000,
    }], 1710000000);

    const wallets = new DiscoveryControlPlane().getWallets('volume', 50, 0);
    const wallet = wallets.find((row: any) => row.address === '0xv2candidate');

    assert.ok(wallet, 'expected v2 candidate to appear in discovery feed');
    assert.equal(wallet.discoveryState, 'Needs Validation');
    assert.deepEqual(wallet.supportingMarkets, ['Lakers vs Celtics']);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('DiscoveryControlPlane includes allocation posture on surfaced wallets', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-control-plane-allocation-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    upsertWalletCandidatesV2([{
      address: '0xallocwallet',
      sourceType: 'leaderboard',
      sourceLabel: 'SPORTS_WEEK',
      conditionId: 'condition-alloc',
      marketTitle: 'Lakers vs Celtics',
      sourceRank: 1,
      sourceMetric: 10000,
      sourceMetadata: { category: 'SPORTS' },
      firstSeenAt: 1710000000,
      lastSeenAt: 1710000000,
      updatedAt: 1710000000,
    }], 1710000000);

    upsertWalletValidation({
      address: '0xallocwallet',
      openPositionsCount: 1,
      closedPositionsCount: 3,
      realizedPnl: 420,
      realizedWinRate: 70,
      makerRebateCount: 0,
      tradeActivityCount: 6,
      buyActivityCount: 4,
      sellActivityCount: 2,
      marketsTouched: 4,
      lastValidatedAt: 1710000000,
    });

    const row = buildWalletScoreRow({
      address: '0xallocwallet',
      profitabilityScore: 74,
      focusScore: 71,
      copyabilityScore: 69,
      earlyScore: 22,
      consistencyScore: 55,
      convictionScore: 33,
      noisePenalty: 0,
      trustScore: 72,
      strategyClass: 'informational_directional',
      confidenceBucket: 'high',
      scoreVersion: 2,
      updatedAt: 1710003600,
    });
    row.surfaceBucket = 'trusted';
    upsertWalletScoreRow(row);
    upsertWalletScoreRowV2(row, buildReasonPayloadV2(row, [
      {
        address: row.address,
        reasonType: 'supporting',
        reasonCode: 'sports_focus',
        message: 'Shows repeat sports edge.',
        createdAt: 1710003600,
      },
    ]));
    evaluateAndPersistAllocationPolicies([{
      address: '0xallocwallet',
      discoveryScore: 74,
      trustScore: 72,
      copyabilityScore: 69,
      confidenceBucket: 'high',
      strategyClass: 'informational_directional',
      cautionFlags: [],
      updatedAt: 1710003600,
    }], 1710003600);

    const wallets = new DiscoveryControlPlane().getWallets('trust', 50, 0);
    const wallet = wallets.find((entry: any) => entry.address === '0xallocwallet');

    assert.ok(wallet, 'expected wallet to appear in trust feed');
    assert.equal(typeof wallet.allocationState, 'string');
    assert.equal(wallet.allocationState, 'CONSISTENT');
    assert.equal(typeof wallet.allocationWeight, 'number');
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('DiscoveryControlPlane v2-primary mode does not fall back to legacy scores', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-control-plane-v2-primary-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    updateDiscoveryConfig({ readMode: 'v2-primary' } as any);

    upsertWalletCandidatesV2([{
      address: '0xv2only',
      sourceType: 'leaderboard',
      sourceLabel: 'SPORTS_WEEK',
      conditionId: 'condition-v2',
      marketTitle: 'Lakers vs Celtics',
      sourceRank: 1,
      sourceMetric: 9000,
      sourceMetadata: { category: 'SPORTS' },
      firstSeenAt: 1710000000,
      lastSeenAt: 1710000000,
      updatedAt: 1710000000,
    }], 1710000000);

    upsertWalletValidation({
      address: '0xv2only',
      openPositionsCount: 1,
      closedPositionsCount: 2,
      realizedPnl: 500,
      realizedWinRate: 70,
      makerRebateCount: 0,
      tradeActivityCount: 5,
      buyActivityCount: 3,
      sellActivityCount: 2,
      marketsTouched: 3,
      lastValidatedAt: 1710000000,
    });

    upsertWalletScoreRow(buildWalletScoreRow({
      address: '0xv2only',
      profitabilityScore: 90,
      focusScore: 90,
      copyabilityScore: 90,
      earlyScore: 20,
      consistencyScore: 50,
      convictionScore: 30,
      noisePenalty: 0,
      updatedAt: 1710000000,
    }));

    const wallets = new DiscoveryControlPlane().getWallets('trust', 50, 0);
    const wallet = wallets.find((entry: any) => entry.address === '0xv2only');

    assert.ok(wallet, 'expected v2 candidate to appear');
    assert.equal(wallet.discoveryScore, 0);
    assert.equal(wallet.trustScore, 0);
    assert.equal(wallet.copyabilityScore, 0);
    assert.equal(wallet.scoreVersion, 2);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
