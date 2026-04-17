import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { closeDatabase, initDatabase } from '../src/database.js';
import {
  computeCopyabilityScore,
  passesCopyabilityGate,
} from '../src/discovery/copyabilityScorer.ts';
import { computeEarlyEntryScore } from '../src/discovery/earlyEntryScorer.ts';
import {
  buildDiscoveryReasonRows,
  buildReasonPayloadV2,
  buildWalletScoreRow,
  getWalletScoreRow,
  getWalletScoreRowV2,
  upsertWalletScoreRow,
  upsertWalletScoreRowV2,
  replaceWalletReasons,
  getWalletReasons,
} from '../src/discovery/discoveryScorer.ts';

test('computeCopyabilityScore penalizes maker rebates and one-sided excessive churn', () => {
  const score = computeCopyabilityScore({
    makerRebateCount: 8,
    tradeActivityCount: 30,
    buyActivityCount: 15,
    sellActivityCount: 15,
  }, {
    averageSpreadBps: 180,
    averageTopOfBookUsd: 400,
  });

  assert.equal(passesCopyabilityGate(score), false);
});

test('computeEarlyEntryScore rewards entries before a meaningful reprice', () => {
  assert.equal(computeEarlyEntryScore({
    entryPrice: 0.42,
    currentPrice: 0.63,
  }) > computeEarlyEntryScore({
    entryPrice: 0.58,
    currentPrice: 0.63,
  }), true);
});

test('buildWalletScoreRow requires profitability, focus, and copyability gates', () => {
  const score = buildWalletScoreRow({
    address: '0xabc',
    profitabilityScore: 78,
    focusScore: 62,
    copyabilityScore: 66,
    earlyScore: 30,
    consistencyScore: 55,
    convictionScore: 22,
    noisePenalty: 8,
    updatedAt: 1710000000,
  });

  assert.equal(score.passedProfitabilityGate, true);
  assert.equal(score.passedFocusGate, true);
  assert.equal(score.passedCopyabilityGate, true);
  assert.equal(score.finalScore > 0, true);
});

test('buildDiscoveryReasonRows emits supporting and warning reasons from score components', () => {
  const reasons = buildDiscoveryReasonRows({
    address: '0xabc',
    profitabilityScore: 78,
    focusScore: 62,
    copyabilityScore: 48,
    earlyScore: 30,
    consistencyScore: 55,
    convictionScore: 22,
    noisePenalty: 18,
    passedProfitabilityGate: true,
    passedFocusGate: true,
    passedCopyabilityGate: false,
    finalScore: 41,
    updatedAt: 1710000000,
  });

  assert.equal(reasons.some((reason) => reason.reasonType === 'supporting'), true);
  assert.equal(reasons.some((reason) => reason.reasonType === 'warning'), true);
  assert.equal(reasons.some((reason) => reason.reasonType === 'rejection'), true);
});

test('wallet score rows and reasons are persisted', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-wallet-scores-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    const row = buildWalletScoreRow({
      address: '0xabc',
      profitabilityScore: 78,
      focusScore: 62,
      copyabilityScore: 66,
      earlyScore: 30,
      consistencyScore: 55,
      convictionScore: 22,
      noisePenalty: 8,
      updatedAt: 1710000000,
    });

    upsertWalletScoreRow(row);
    replaceWalletReasons(
      '0xabc',
      buildDiscoveryReasonRows(row),
      1710000000,
    );

    const storedRow = getWalletScoreRow('0xabc');
    const storedReasons = getWalletReasons('0xabc');
    const reasonPayload = buildReasonPayloadV2(row, storedReasons);
    upsertWalletScoreRowV2(row, reasonPayload);
    const storedRowV2 = getWalletScoreRowV2('0xabc');

    assert.ok(storedRow);
    assert.equal(storedRow?.address, '0xabc');
    assert.equal(storedRow?.strategyClass, 'unknown');
    assert.equal(storedReasons.length > 0, true);
    assert.ok(storedRowV2);
    assert.equal(storedRowV2?.scoreVersion, 2);
    assert.equal(storedRowV2?.surfaceBucket, storedRow?.surfaceBucket);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
