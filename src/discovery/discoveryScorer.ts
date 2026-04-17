import { getDatabase } from '../database.js';
import { resolveDiscoverySurfaceBucket } from './strategyClassifier.js';
import {
  DiscoveryConfidenceBucket,
  DiscoveryReasonPayloadV2,
  DiscoveryStrategyClass,
  DiscoveryWalletReason,
  DiscoveryWalletScoreRow,
  DiscoveryWalletScoreV2Row,
} from './types.js';

type ScoreInput = {
  address: string;
  profitabilityScore: number;
  focusScore: number;
  copyabilityScore: number;
  earlyScore: number;
  consistencyScore: number;
  convictionScore: number;
  noisePenalty: number;
  updatedAt: number;
  trustScore?: number;
  strategyClass?: DiscoveryStrategyClass;
  confidenceBucket?: DiscoveryConfidenceBucket;
  scoreVersion?: number;
};

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));
const safeParseStringArray = (value: unknown): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => String(entry));
  } catch {
    return [];
  }
};

export const buildWalletScoreRow = (input: ScoreInput): DiscoveryWalletScoreRow => {
  const passedProfitabilityGate = input.profitabilityScore >= 55;
  const passedFocusGate = input.focusScore >= 50;
  const passedCopyabilityGate = input.copyabilityScore >= 55;

  const weightedScore = (
    input.profitabilityScore * 0.35 +
    input.copyabilityScore * 0.25 +
    input.focusScore * 0.2 +
    input.consistencyScore * 0.1 +
    input.earlyScore * 0.1 +
    input.convictionScore * 0.05
  ) - input.noisePenalty;
  const finalScore = Math.max(0, Math.round(weightedScore * 10) / 10);
  const trustScore = input.trustScore ?? clamp(
    input.profitabilityScore * 0.4 +
      input.focusScore * 0.2 +
      input.consistencyScore * 0.2 +
      input.copyabilityScore * 0.2 -
      input.noisePenalty * 0.8,
  );
  const confidenceBucket = input.confidenceBucket ?? (
    finalScore >= 70 && passedProfitabilityGate && passedFocusGate ? 'high' : finalScore >= 45 ? 'medium' : 'low'
  );
  const failedGates = [
    passedProfitabilityGate ? null : 'profitability',
    passedFocusGate ? null : 'focus',
    passedCopyabilityGate ? null : 'copyability',
  ].filter(Boolean) as string[];
  const surfaceBucket = resolveDiscoverySurfaceBucket({
    discoveryScore: finalScore,
    trustScore,
    copyabilityScore: input.copyabilityScore,
    strategyClass: input.strategyClass ?? 'unknown',
    failedGates,
    confidenceBucket,
  });

  return {
    address: input.address.toLowerCase(),
    profitabilityScore: input.profitabilityScore,
    focusScore: input.focusScore,
    copyabilityScore: input.copyabilityScore,
    earlyScore: input.earlyScore,
    consistencyScore: input.consistencyScore,
    convictionScore: input.convictionScore,
    noisePenalty: input.noisePenalty,
    passedProfitabilityGate,
    passedFocusGate,
    passedCopyabilityGate,
    finalScore,
    trustScore,
    strategyClass: input.strategyClass ?? 'unknown',
    confidenceBucket,
    surfaceBucket,
    scoreVersion: input.scoreVersion ?? 2,
    updatedAt: input.updatedAt,
  };
};

export const buildDiscoveryReasonRows = (scoreRow: DiscoveryWalletScoreRow): DiscoveryWalletReason[] => {
  const reasons: DiscoveryWalletReason[] = [];
  const createdAt = scoreRow.updatedAt;

  if (scoreRow.profitabilityScore >= 60) {
    reasons.push({
      address: scoreRow.address,
      reasonType: 'supporting',
      reasonCode: 'profitability',
      message: 'Shows repeat realized profitability.',
      createdAt,
    });
  }

  if (scoreRow.focusScore >= 55) {
    reasons.push({
      address: scoreRow.address,
      reasonType: 'supporting',
      reasonCode: 'focus',
      message: 'Activity is concentrated in the whitelisted discovery categories.',
      createdAt,
    });
  }

  if (scoreRow.copyabilityScore < 55) {
    reasons.push({
      address: scoreRow.address,
      reasonType: 'rejection',
      reasonCode: 'copyability-gate',
      message: 'Fails the copyability gate for current market conditions or trading behavior.',
      createdAt,
    });
  }

  if (scoreRow.noisePenalty >= 15) {
    reasons.push({
      address: scoreRow.address,
      reasonType: 'warning',
      reasonCode: 'noise',
      message: 'Noise penalties are elevated, so confidence is reduced.',
      createdAt,
    });
  }

  if (scoreRow.earlyScore >= 25) {
    reasons.push({
      address: scoreRow.address,
      reasonType: 'supporting',
      reasonCode: 'early-entry',
      message: 'Recent entries happened before a meaningful reprice.',
      createdAt,
    });
  }

  if ((scoreRow.trustScore ?? 0) >= 70) {
    reasons.push({
      address: scoreRow.address,
      reasonType: 'supporting',
      reasonCode: 'trust',
      message: 'Trust profile is stable across sample size, breadth, and behavior checks.',
      createdAt,
    });
  }

  if ((scoreRow.trustScore ?? 0) < 45) {
    reasons.push({
      address: scoreRow.address,
      reasonType: 'warning',
      reasonCode: 'trust-low',
      message: 'Trust confidence is still limited; watchlist mode is safer than immediate copying.',
      createdAt,
    });
  }

  return reasons;
};

export const buildReasonPayloadV2 = (
  scoreRow: DiscoveryWalletScoreRow,
  reasons: DiscoveryWalletReason[],
): DiscoveryReasonPayloadV2 => {
  const supportingReasons = reasons
    .filter((reason) => reason.reasonType === 'supporting')
    .map((reason) => reason.message)
    .slice(0, 5);
  const cautionFlags = reasons
    .filter((reason) => reason.reasonType !== 'supporting')
    .map((reason) => reason.message)
    .slice(0, 5);
  const primaryReason = supportingReasons[0] ?? (
    scoreRow.finalScore >= 60
      ? 'Emerging from recent high-signal activity.'
      : 'Captured for monitoring while confidence builds.'
  );

  return {
    primaryReason,
    supportingReasons,
    cautionFlags,
  };
};

export const upsertWalletScoreRow = (row: DiscoveryWalletScoreRow): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_wallet_scores (
      address, profitability_score, focus_score, copyability_score, early_score,
      consistency_score, conviction_score, noise_penalty, passed_profitability_gate,
      passed_focus_gate, passed_copyability_gate, final_score, trust_score,
      strategy_class, confidence_bucket, surface_bucket, score_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      previous_final_score = discovery_wallet_scores.final_score,
      previous_updated_at = discovery_wallet_scores.updated_at,
      previous_passed_profitability_gate = discovery_wallet_scores.passed_profitability_gate,
      previous_passed_focus_gate = discovery_wallet_scores.passed_focus_gate,
      previous_passed_copyability_gate = discovery_wallet_scores.passed_copyability_gate,
      profitability_score = excluded.profitability_score,
      focus_score = excluded.focus_score,
      copyability_score = excluded.copyability_score,
      early_score = excluded.early_score,
      consistency_score = excluded.consistency_score,
      conviction_score = excluded.conviction_score,
      noise_penalty = excluded.noise_penalty,
      passed_profitability_gate = excluded.passed_profitability_gate,
      passed_focus_gate = excluded.passed_focus_gate,
      passed_copyability_gate = excluded.passed_copyability_gate,
      final_score = excluded.final_score,
      trust_score = excluded.trust_score,
      strategy_class = excluded.strategy_class,
      confidence_bucket = excluded.confidence_bucket,
      surface_bucket = excluded.surface_bucket,
      score_version = excluded.score_version,
      updated_at = excluded.updated_at
  `).run(
    row.address,
    row.profitabilityScore,
    row.focusScore,
    row.copyabilityScore,
    row.earlyScore,
    row.consistencyScore,
    row.convictionScore,
    row.noisePenalty,
    row.passedProfitabilityGate ? 1 : 0,
    row.passedFocusGate ? 1 : 0,
    row.passedCopyabilityGate ? 1 : 0,
    row.finalScore,
    row.trustScore ?? 0,
    row.strategyClass ?? 'unknown',
    row.confidenceBucket ?? 'low',
    row.surfaceBucket ?? 'watch_only',
    row.scoreVersion ?? 2,
    row.updatedAt,
  );
};

export const upsertWalletScoreRowV2 = (
  row: DiscoveryWalletScoreRow,
  reasonPayload: DiscoveryReasonPayloadV2,
): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_wallet_scores_v2 (
      address, score_version, strategy_class, discovery_score, trust_score,
      copyability_score, confidence_bucket, surface_bucket, primary_reason,
      supporting_reasons_json, caution_flags_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      score_version = excluded.score_version,
      strategy_class = excluded.strategy_class,
      discovery_score = excluded.discovery_score,
      trust_score = excluded.trust_score,
      copyability_score = excluded.copyability_score,
      confidence_bucket = excluded.confidence_bucket,
      surface_bucket = excluded.surface_bucket,
      primary_reason = excluded.primary_reason,
      supporting_reasons_json = excluded.supporting_reasons_json,
      caution_flags_json = excluded.caution_flags_json,
      updated_at = excluded.updated_at
  `).run(
    row.address,
    row.scoreVersion ?? 2,
    row.strategyClass ?? 'unknown',
    row.finalScore,
    row.trustScore ?? 0,
    row.copyabilityScore,
    row.confidenceBucket ?? 'low',
    row.surfaceBucket ?? 'watch_only',
    reasonPayload.primaryReason,
    JSON.stringify(reasonPayload.supportingReasons),
    JSON.stringify(reasonPayload.cautionFlags),
    row.updatedAt,
  );

  db.prepare(`
    INSERT INTO discovery_wallet_reasons_v2 (
      address, primary_reason, supporting_reasons_json, caution_flags_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    row.address,
    reasonPayload.primaryReason,
    JSON.stringify(reasonPayload.supportingReasons),
    JSON.stringify(reasonPayload.cautionFlags),
    row.updatedAt,
  );
};

export const getWalletScoreRow = (address: string): DiscoveryWalletScoreRow | null => {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT *
    FROM discovery_wallet_scores
    WHERE address = ?
  `).get(address.toLowerCase()) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    address: String(row.address),
    profitabilityScore: Number(row.profitability_score),
    focusScore: Number(row.focus_score),
    copyabilityScore: Number(row.copyability_score),
    earlyScore: Number(row.early_score),
    consistencyScore: Number(row.consistency_score),
    convictionScore: Number(row.conviction_score),
    noisePenalty: Number(row.noise_penalty),
    passedProfitabilityGate: Boolean(row.passed_profitability_gate),
    passedFocusGate: Boolean(row.passed_focus_gate),
    passedCopyabilityGate: Boolean(row.passed_copyability_gate),
    finalScore: Number(row.final_score),
    trustScore: Number(row.trust_score ?? 0),
    strategyClass: String(row.strategy_class ?? 'unknown') as DiscoveryStrategyClass,
    confidenceBucket: String(row.confidence_bucket ?? 'low') as DiscoveryConfidenceBucket,
    surfaceBucket: String(row.surface_bucket ?? 'watch_only') as DiscoveryWalletScoreRow['surfaceBucket'],
    scoreVersion: Number(row.score_version ?? 1),
    previousFinalScore: row.previous_final_score === null || row.previous_final_score === undefined ? undefined : Number(row.previous_final_score),
    previousUpdatedAt: row.previous_updated_at === null || row.previous_updated_at === undefined ? undefined : Number(row.previous_updated_at),
    previousPassedProfitabilityGate: row.previous_passed_profitability_gate === null || row.previous_passed_profitability_gate === undefined
      ? undefined
      : Boolean(row.previous_passed_profitability_gate),
    previousPassedFocusGate: row.previous_passed_focus_gate === null || row.previous_passed_focus_gate === undefined
      ? undefined
      : Boolean(row.previous_passed_focus_gate),
    previousPassedCopyabilityGate: row.previous_passed_copyability_gate === null || row.previous_passed_copyability_gate === undefined
      ? undefined
      : Boolean(row.previous_passed_copyability_gate),
    updatedAt: Number(row.updated_at),
  };
};

export const getWalletScoreRowV2 = (address: string): DiscoveryWalletScoreV2Row | null => {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT *
    FROM discovery_wallet_scores_v2
    WHERE address = ?
  `).get(address.toLowerCase()) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    address: String(row.address),
    scoreVersion: Number(row.score_version),
    strategyClass: String(row.strategy_class) as DiscoveryStrategyClass,
    discoveryScore: Number(row.discovery_score),
    trustScore: Number(row.trust_score),
    copyabilityScore: Number(row.copyability_score),
    confidenceBucket: String(row.confidence_bucket) as DiscoveryConfidenceBucket,
    surfaceBucket: String(row.surface_bucket) as DiscoveryWalletScoreV2Row['surfaceBucket'],
    primaryReason: String(row.primary_reason),
    supportingReasons: safeParseStringArray(row.supporting_reasons_json),
    cautionFlags: safeParseStringArray(row.caution_flags_json),
    updatedAt: Number(row.updated_at),
  };
};

export const replaceWalletReasons = (
  address: string,
  reasons: DiscoveryWalletReason[],
  createdAt: number,
): void => {
  const db = getDatabase();
  const normalizedAddress = address.toLowerCase();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM discovery_wallet_reasons WHERE address = ?').run(normalizedAddress);
    const insert = db.prepare(`
      INSERT INTO discovery_wallet_reasons (address, reason_type, reason_code, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const reason of reasons) {
      insert.run(
        normalizedAddress,
        reason.reasonType,
        reason.reasonCode,
        reason.message,
        reason.createdAt || createdAt,
      );
    }
  });
  tx();
};

export const getWalletReasons = (address: string): DiscoveryWalletReason[] => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT address, reason_type, reason_code, message, created_at
    FROM discovery_wallet_reasons
    WHERE address = ?
    ORDER BY created_at DESC, id DESC
  `).all(address.toLowerCase()) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    address: String(row.address),
    reasonType: String(row.reason_type) as DiscoveryWalletReason['reasonType'],
    reasonCode: String(row.reason_code),
    message: String(row.message),
    createdAt: Number(row.created_at),
  }));
};

export const getRecentWalletReasons = (limit: number, offset: number): DiscoveryWalletReason[] => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT address, reason_type, reason_code, message, created_at
    FROM discovery_wallet_reasons
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    address: String(row.address),
    reasonType: String(row.reason_type) as DiscoveryWalletReason['reasonType'],
    reasonCode: String(row.reason_code),
    message: String(row.message),
    createdAt: Number(row.created_at),
  }));
};
