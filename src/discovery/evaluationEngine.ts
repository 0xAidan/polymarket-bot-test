import { getDatabase } from '../database.js';
import { DiscoveryCostSnapshot, DiscoveryEvaluationSnapshot, DiscoveryWalletScoreRow } from './types.js';

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));

const precisionAtK = (rows: DiscoveryWalletScoreRow[], k: number): number => {
  if (rows.length === 0 || k <= 0) return 0;
  const topRows = rows.slice(0, k);
  const positives = topRows.filter(
    (row) => row.passedProfitabilityGate && row.passedFocusGate && row.passedCopyabilityGate,
  ).length;
  return positives / topRows.length;
};

const meanAveragePrecision = (rows: DiscoveryWalletScoreRow[]): number => {
  if (rows.length === 0) return 0;
  let relevantSeen = 0;
  let runningPrecision = 0;
  rows.forEach((row, index) => {
    const isRelevant = row.passedProfitabilityGate && row.passedFocusGate && row.passedCopyabilityGate;
    if (!isRelevant) return;
    relevantSeen += 1;
    runningPrecision += relevantSeen / (index + 1);
  });
  if (relevantSeen === 0) return 0;
  return runningPrecision / relevantSeen;
};

const ndcgProxy = (rows: DiscoveryWalletScoreRow[], k: number): number => {
  const topRows = rows.slice(0, k);
  if (topRows.length === 0) return 0;
  const dcg = topRows.reduce((sum, row, index) => {
    const gain = row.passedProfitabilityGate && row.passedFocusGate && row.passedCopyabilityGate ? 1 : 0;
    return sum + gain / Math.log2(index + 2);
  }, 0);
  const idealTop = [...topRows].sort((a, b) => Number(b.passedProfitabilityGate) - Number(a.passedProfitabilityGate));
  const idcg = idealTop.reduce((sum, row, index) => {
    const gain = row.passedProfitabilityGate && row.passedFocusGate && row.passedCopyabilityGate ? 1 : 0;
    return sum + gain / Math.log2(index + 2);
  }, 0);
  if (idcg === 0) return 0;
  return clamp(dcg / idcg);
};

export const insertDiscoveryEvaluationSnapshot = (snapshot: DiscoveryEvaluationSnapshot): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_eval_snapshots_v2 (
      window_start, window_end, sample_size, top_k, precision_at_k,
      mean_average_precision, ndcg, baseline_precision_at_k, created_at, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.windowStart,
    snapshot.windowEnd,
    snapshot.sampleSize,
    snapshot.topK,
    snapshot.precisionAtK,
    snapshot.meanAveragePrecision,
    snapshot.ndcg,
    snapshot.baselinePrecisionAtK,
    snapshot.createdAt,
    snapshot.notes ?? null,
  );
};

export const createCycleEvaluationSnapshot = (input: {
  runTimestamp: number;
  scoredRows: DiscoveryWalletScoreRow[];
  windowSeconds?: number;
}): DiscoveryEvaluationSnapshot => {
  const sortedRows = [...input.scoredRows].sort((a, b) => b.finalScore - a.finalScore);
  const topK = Math.min(10, Math.max(1, sortedRows.length));
  const baselineRelevant = sortedRows.filter(
    (row) => row.passedProfitabilityGate && row.passedFocusGate && row.passedCopyabilityGate,
  ).length;

  return {
    windowStart: input.runTimestamp - (input.windowSeconds ?? 24 * 60 * 60),
    windowEnd: input.runTimestamp,
    sampleSize: sortedRows.length,
    topK,
    precisionAtK: precisionAtK(sortedRows, topK),
    meanAveragePrecision: meanAveragePrecision(sortedRows),
    ndcg: ndcgProxy(sortedRows, topK),
    baselinePrecisionAtK: sortedRows.length > 0 ? baselineRelevant / sortedRows.length : 0,
    createdAt: input.runTimestamp,
    notes: 'Online proxy metrics (point-in-time, no future labels).',
  };
};

export const insertDiscoveryCostSnapshots = (snapshots: DiscoveryCostSnapshot[]): void => {
  if (snapshots.length === 0) return;
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO discovery_cost_snapshots_v2 (
      provider, endpoint, request_count, estimated_cost_usd, coverage_count, runtime_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    snapshots.forEach((snapshot) => {
      stmt.run(
        snapshot.provider,
        snapshot.endpoint,
        snapshot.requestCount,
        snapshot.estimatedCostUsd,
        snapshot.coverageCount,
        snapshot.runtimeMs,
        snapshot.createdAt,
      );
    });
  });
  tx();
};

export const getLatestDiscoveryEvaluationSnapshot = (): DiscoveryEvaluationSnapshot | null => {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT *
    FROM discovery_eval_snapshots_v2
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: Number(row.id),
    windowStart: Number(row.window_start),
    windowEnd: Number(row.window_end),
    sampleSize: Number(row.sample_size),
    topK: Number(row.top_k),
    precisionAtK: Number(row.precision_at_k),
    meanAveragePrecision: Number(row.mean_average_precision),
    ndcg: Number(row.ndcg),
    baselinePrecisionAtK: Number(row.baseline_precision_at_k),
    createdAt: Number(row.created_at),
    notes: row.notes ? String(row.notes) : undefined,
  };
};
