import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { closeDatabase, getDatabase, initDatabase } from '../src/database.js';
import { upsertWalletFeatureSnapshotV2 } from '../src/discovery/v2DataStore.ts';

test('wallet feature snapshots preserve history while latest snapshot stays current', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-v2-features-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    upsertWalletFeatureSnapshotV2({
      address: '0xabc',
      runTimestamp: 1710000000,
      focusCategory: 'sports',
      strategyClass: 'informational_directional',
      confidenceBucket: 'medium',
      featureSnapshot: {
        marketSelectionScore: 55,
        categoryFocusScore: 60,
        consistencyScore: 45,
        convictionScore: 50,
        trustScore: 58,
        integrityPenalty: 5,
        confidenceEvidenceCount: 4,
        cautionFlags: ['thin_history'],
      },
      metrics: {
        averageSpreadBps: 20,
        averageTopOfBookUsd: 5000,
        latestTradePrice: 0.41,
        currentPrice: 0.47,
      },
    });

    upsertWalletFeatureSnapshotV2({
      address: '0xabc',
      runTimestamp: 1710000600,
      focusCategory: 'sports',
      strategyClass: 'informational_directional',
      confidenceBucket: 'high',
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

    const latestRow = getDatabase().prepare(`
      SELECT snapshot_at, trust_score, confidence_bucket
      FROM discovery_wallet_features_v2
      WHERE address = ?
    `).get('0xabc') as { snapshot_at: number; trust_score: number; confidence_bucket: string };

    assert.equal(latestRow.snapshot_at, 1710000600);
    assert.equal(latestRow.trust_score, 71);
    assert.equal(latestRow.confidence_bucket, 'high');

    const historyRows = getDatabase().prepare(`
      SELECT snapshot_at, trust_score
      FROM discovery_wallet_feature_history_v2
      WHERE address = ?
      ORDER BY snapshot_at ASC
    `).all('0xabc') as Array<{ snapshot_at: number; trust_score: number }>;

    assert.equal(historyRows.length, 2);
    assert.deepEqual(historyRows.map((row) => row.snapshot_at), [1710000000, 1710000600]);
    assert.deepEqual(historyRows.map((row) => row.trust_score), [58, 71]);
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
