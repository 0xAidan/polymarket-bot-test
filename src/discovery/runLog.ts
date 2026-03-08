import { getDatabase } from '../database.js';
import { DiscoveryRunLog } from './types.js';

export const insertDiscoveryRunLog = (log: DiscoveryRunLog): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_run_log (
      phase, gamma_request_count, data_request_count, clob_request_count,
      candidate_count, qualified_count, rejected_count, duration_ms,
      estimated_cost_usd, category_purity_pct, copyability_pass_pct,
      wallets_with_two_reasons_pct, free_mode_no_alchemy, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.phase,
    log.gammaRequestCount,
    log.dataRequestCount,
    log.clobRequestCount,
    log.candidateCount,
    log.qualifiedCount,
    log.rejectedCount,
    log.durationMs,
    log.estimatedCostUsd ?? 0,
    log.categoryPurityPct ?? 0,
    log.copyabilityPassPct ?? 0,
    log.walletsWithTwoReasonsPct ?? 0,
    log.freeModeNoAlchemy === false ? 0 : 1,
    log.notes ?? null,
    log.createdAt,
  );
};

export const getLatestDiscoveryRunLog = (): DiscoveryRunLog | null => {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT *
    FROM discovery_run_log
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    runId: Number(row.id),
    phase: String(row.phase),
    gammaRequestCount: Number(row.gamma_request_count),
    dataRequestCount: Number(row.data_request_count),
    clobRequestCount: Number(row.clob_request_count),
    candidateCount: Number(row.candidate_count),
    qualifiedCount: Number(row.qualified_count),
    rejectedCount: Number(row.rejected_count),
    durationMs: Number(row.duration_ms),
    estimatedCostUsd: Number(row.estimated_cost_usd ?? 0),
    categoryPurityPct: Number(row.category_purity_pct ?? 0),
    copyabilityPassPct: Number(row.copyability_pass_pct ?? 0),
    walletsWithTwoReasonsPct: Number(row.wallets_with_two_reasons_pct ?? 0),
    freeModeNoAlchemy: Boolean(row.free_mode_no_alchemy),
    notes: row.notes ? String(row.notes) : undefined,
    createdAt: Number(row.created_at),
  };
};
