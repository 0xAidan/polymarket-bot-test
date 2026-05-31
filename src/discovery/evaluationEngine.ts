import { getDatabase } from '../database.js';
import { DiscoveryCostSnapshot, DiscoveryEvaluationSnapshot, DiscoveryWalletScoreRow } from './types.js';

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));

type RankedEvaluationCandidate = {
  score: number;
  isRelevant: boolean;
};

const isRelevantRow = (row: Pick<DiscoveryWalletScoreRow, 'passedProfitabilityGate' | 'passedFocusGate' | 'passedCopyabilityGate'>): boolean => {
  return row.passedProfitabilityGate && row.passedFocusGate && row.passedCopyabilityGate;
};

const precisionAtK = (rows: RankedEvaluationCandidate[], k: number): number => {
  if (rows.length === 0 || k <= 0) return 0;
  const topRows = rows.slice(0, k);
  const positives = topRows.filter((row) => row.isRelevant).length;
  return positives / topRows.length;
};

const meanAveragePrecision = (rows: RankedEvaluationCandidate[]): number => {
  if (rows.length === 0) return 0;
  let relevantSeen = 0;
  let runningPrecision = 0;
  rows.forEach((row, index) => {
    if (!row.isRelevant) return;
    relevantSeen += 1;
    runningPrecision += relevantSeen / (index + 1);
  });
  if (relevantSeen === 0) return 0;
  return runningPrecision / relevantSeen;
};

const ndcgProxy = (rows: RankedEvaluationCandidate[], k: number): number => {
  const topRows = rows.slice(0, k);
  if (topRows.length === 0) return 0;
  const dcg = topRows.reduce((sum, row, index) => {
    const gain = row.isRelevant ? 1 : 0;
    return sum + gain / Math.log2(index + 2);
  }, 0);
  const idealTop = [...topRows].sort((a, b) => Number(b.isRelevant) - Number(a.isRelevant));
  const idcg = idealTop.reduce((sum, row, index) => {
    const gain = row.isRelevant ? 1 : 0;
    return sum + gain / Math.log2(index + 2);
  }, 0);
  if (idcg === 0) return 0;
  return clamp(dcg / idcg);
};

export const insertDiscoveryEvaluationObservations = (
  runTimestamp: number,
  scoredRows: DiscoveryWalletScoreRow[],
): void => {
  if (scoredRows.length === 0) return;
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO discovery_eval_observations_v2 (
      run_at, address, discovery_score, passed_all_gates, confidence_bucket, strategy_class, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_at, address) DO UPDATE SET
      discovery_score = excluded.discovery_score,
      passed_all_gates = excluded.passed_all_gates,
      confidence_bucket = excluded.confidence_bucket,
      strategy_class = excluded.strategy_class,
      created_at = excluded.created_at
  `);
  const tx = db.transaction(() => {
    for (const row of scoredRows) {
      stmt.run(
        runTimestamp,
        row.address.toLowerCase(),
        row.finalScore,
        isRelevantRow(row) ? 1 : 0,
        row.confidenceBucket ?? null,
        row.strategyClass ?? null,
        runTimestamp,
      );
    }
  });
  tx();
};

export const createWalkForwardEvaluationSnapshot = (input: {
  runTimestamp: number;
  embargoRuns?: number;
  horizonRuns?: number;
  topK?: number;
}): DiscoveryEvaluationSnapshot | null => {
  const db = getDatabase();
  const runRows = db.prepare(`
    SELECT DISTINCT run_at
    FROM discovery_eval_observations_v2
    ORDER BY run_at ASC
  `).all() as Array<{ run_at: number }>;
  const runTimes = runRows.map((row) => Number(row.run_at)).filter((value) => Number.isFinite(value));
  const embargoRuns = Math.max(1, input.embargoRuns ?? 1);
  const horizonRuns = Math.max(1, input.horizonRuns ?? 3);
  const minimumRuns = embargoRuns + horizonRuns + 1;
  if (runTimes.length < minimumRuns) return null;

  const trainRunIndex = runTimes.length - minimumRuns;
  const trainRun = runTimes[trainRunIndex];
  const futureStartIndex = trainRunIndex + embargoRuns + 1;
  const futureEndIndex = Math.min(runTimes.length - 1, futureStartIndex + horizonRuns - 1);
  const futureRuns = runTimes.slice(futureStartIndex, futureEndIndex + 1);
  if (futureRuns.length === 0) return null;

  const trainRows = db.prepare(`
    SELECT address, discovery_score
    FROM discovery_eval_observations_v2
    WHERE run_at = ?
    ORDER BY discovery_score DESC
  `).all(trainRun) as Array<{ address: string; discovery_score: number }>;
  if (trainRows.length === 0) return null;

  const placeholders = futureRuns.map(() => '?').join(', ');
  const positiveRows = db.prepare(`
    SELECT DISTINCT address
    FROM discovery_eval_observations_v2
    WHERE run_at IN (${placeholders}) AND passed_all_gates = 1
  `).all(...futureRuns) as Array<{ address: string }>;
  const positives = new Set(positiveRows.map((row) => row.address.toLowerCase()));

  const candidates: RankedEvaluationCandidate[] = trainRows.map((row) => ({
    score: Number(row.discovery_score ?? 0),
    isRelevant: positives.has(row.address.toLowerCase()),
  }));
  const topK = Math.min(Math.max(1, input.topK ?? 10), candidates.length);
  const baselinePositiveRate = candidates.length === 0
    ? 0
    : candidates.filter((candidate) => candidate.isRelevant).length / candidates.length;

  return {
    windowStart: trainRun,
    windowEnd: futureRuns[futureRuns.length - 1] ?? trainRun,
    sampleSize: candidates.length,
    topK,
    precisionAtK: precisionAtK(candidates, topK),
    meanAveragePrecision: meanAveragePrecision(candidates),
    ndcg: ndcgProxy(candidates, topK),
    baselinePrecisionAtK: baselinePositiveRate,
    createdAt: input.runTimestamp,
    notes: 'Walk-forward evaluation (embargoed): labels sourced only from future runs after embargo.',
  };
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
  const walkForwardSnapshot = createWalkForwardEvaluationSnapshot({ runTimestamp: input.runTimestamp });
  if (walkForwardSnapshot) {
    return walkForwardSnapshot;
  }

  const sortedRows = [...input.scoredRows]
    .sort((a, b) => b.finalScore - a.finalScore)
    .map((row) => ({
      score: row.finalScore,
      isRelevant: isRelevantRow(row),
    }));
  const topK = Math.min(10, Math.max(1, sortedRows.length));
  const baselineRelevant = sortedRows.filter((row) => row.isRelevant).length;

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
