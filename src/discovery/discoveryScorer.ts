import { getDatabase } from '../database.js';
import { DiscoveryWalletReason, DiscoveryWalletScoreRow } from './types.js';

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
    finalScore: Math.max(0, Math.round(weightedScore * 10) / 10),
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

  return reasons;
};

export const upsertWalletScoreRow = (row: DiscoveryWalletScoreRow): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_wallet_scores (
      address, profitability_score, focus_score, copyability_score, early_score,
      consistency_score, conviction_score, noise_penalty, passed_profitability_gate,
      passed_focus_gate, passed_copyability_gate, final_score, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
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
