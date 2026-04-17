import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, mkdtempSync, rmSync } from 'fs';

import { config } from '../src/config.js';
import { closeDatabase, initDatabase } from '../src/database.js';
import {
  createCycleEvaluationSnapshot,
  createWalkForwardEvaluationSnapshot,
  insertDiscoveryEvaluationObservations,
} from '../src/discovery/evaluationEngine.ts';

const buildScoreRow = (
  address: string,
  score: number,
  passedAllGates: boolean,
) => ({
  address,
  finalScore: score,
  passedProfitabilityGate: passedAllGates,
  passedFocusGate: passedAllGates,
  passedCopyabilityGate: passedAllGates,
  confidenceBucket: passedAllGates ? 'high' : 'low',
  strategyClass: passedAllGates ? 'informational_directional' : 'unknown',
});

test('createWalkForwardEvaluationSnapshot builds embargoed metrics from stored observations', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-eval-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    const runs = [100, 200, 300, 400, 500];
    const addresses = {
      leader: '0x1111000000000000000000000000000000000001',
      follower: '0x2222000000000000000000000000000000000002',
      neutral: '0x3333000000000000000000000000000000000003',
    };

    insertDiscoveryEvaluationObservations(runs[0], [
      buildScoreRow(addresses.leader, 92, true) as any,
      buildScoreRow(addresses.follower, 71, false) as any,
      buildScoreRow(addresses.neutral, 40, false) as any,
    ]);

    insertDiscoveryEvaluationObservations(runs[1], [
      buildScoreRow(addresses.leader, 88, true) as any,
      buildScoreRow(addresses.follower, 69, false) as any,
    ]);

    insertDiscoveryEvaluationObservations(runs[2], [
      buildScoreRow(addresses.leader, 85, true) as any,
      buildScoreRow(addresses.follower, 72, true) as any,
    ]);

    insertDiscoveryEvaluationObservations(runs[3], [
      buildScoreRow(addresses.leader, 84, true) as any,
      buildScoreRow(addresses.neutral, 64, true) as any,
    ]);

    insertDiscoveryEvaluationObservations(runs[4], [
      buildScoreRow(addresses.leader, 82, true) as any,
      buildScoreRow(addresses.follower, 73, true) as any,
    ]);

    const snapshot = createWalkForwardEvaluationSnapshot({ runTimestamp: runs[4] });
    assert.ok(snapshot);
    assert.equal(snapshot?.windowStart, runs[0]);
    assert.equal(snapshot?.windowEnd, runs[4]);
    assert.equal(snapshot?.sampleSize, 3);
    assert.equal(snapshot?.topK, 3);
    assert.equal((snapshot?.precisionAtK ?? 0) > 0, true);
    assert.match(snapshot?.notes || '', /Walk-forward evaluation/);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('createCycleEvaluationSnapshot falls back to online proxy metrics without enough history', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-eval-online-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  const runTimestamp = 1700000000;
  try {
    const snapshot = createCycleEvaluationSnapshot({
      runTimestamp,
      scoredRows: [
        buildScoreRow('0xaaaa000000000000000000000000000000000001', 90, true) as any,
        buildScoreRow('0xbbbb000000000000000000000000000000000002', 75, false) as any,
        buildScoreRow('0xcccc000000000000000000000000000000000003', 66, true) as any,
      ] as any,
    });

    assert.equal(snapshot.windowEnd, runTimestamp);
    assert.equal(snapshot.sampleSize, 3);
    assert.equal(snapshot.topK, 3);
    assert.equal(snapshot.precisionAtK <= 1, true);
    assert.match(snapshot.notes || '', /Online proxy metrics/);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
