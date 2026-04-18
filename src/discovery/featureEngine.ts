import { DiscoveryWalletCandidate, DiscoveryWalletValidation } from './types.js';

type FeatureEngineInput = {
  validation: DiscoveryWalletValidation;
  candidates: DiscoveryWalletCandidate[];
  focusCategory?: string;
  latestTradePrice?: number;
  currentPrice?: number;
  averageSpreadBps: number;
  averageTopOfBookUsd: number;
};

export type DiscoveryFeatureSnapshot = {
  earlyEntryScore: number;
  categoryFocusScore: number;
  convictionScore: number;
  consistencyScore: number;
  marketSelectionScore: number;
  integrityPenalty: number;
  trustScore: number;
  confidenceEvidenceCount: number;
  cautionFlags: string[];
};

const HIGH_INFORMATION_CATEGORIES = new Set([
  'politics',
  'macro',
  'company',
  'legal',
  'geopolitics',
  'sports',
]);

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));

export const computeProfitabilityScore = (input: {
  realizedWinRate: number;
  realizedPnl: number;
  closedPositionsCount: number;
  marketSelectionScore: number;
}): number => {
  const pnlPenalty = input.closedPositionsCount >= 3 && input.realizedPnl < 0
    ? Math.min(40, Math.abs(input.realizedPnl) / 4 + 20)
    : 0;

  return clamp(
    input.realizedWinRate * 0.55 +
      (input.realizedPnl > 0 ? Math.min(35, input.realizedPnl / 20) : 0) +
      input.marketSelectionScore * 0.1 -
      pnlPenalty,
  );
};

export const buildDiscoveryFeatureSnapshot = (
  input: FeatureEngineInput,
): DiscoveryFeatureSnapshot => {
  const { validation, candidates, latestTradePrice, currentPrice, focusCategory } = input;
  const supportingSignals = candidates.filter((candidate) => Number(candidate.sourceMetric ?? 0) > 0).length;
  const sportsPriorityBoost = focusCategory === 'sports' ? 10 : 0;

  const earlyEntryScore = (() => {
    if (!Number.isFinite(latestTradePrice) || !Number.isFinite(currentPrice) || Number(latestTradePrice) <= 0) {
      return 10;
    }
    const movePct = ((Number(currentPrice) - Number(latestTradePrice)) / Number(latestTradePrice)) * 100;
    return clamp(movePct * 5 + 10);
  })();

  const categoryFocusScore = clamp(
    (focusCategory ? 45 : 25) +
      (HIGH_INFORMATION_CATEGORIES.has(focusCategory ?? '') ? 20 : 0) +
      sportsPriorityBoost +
      Math.min(20, supportingSignals * 4),
  );
  const convictionScore = clamp(
    Math.max(...candidates.map((candidate) => Number(candidate.sourceMetric ?? 0)), 0) / 100,
  );
  const consistencyScore = clamp(
    validation.tradeActivityCount * 4 + validation.realizedWinRate * 0.4 + Math.min(15, validation.marketsTouched * 2),
  );
  const marketSelectionScore = clamp(
    (HIGH_INFORMATION_CATEGORIES.has(focusCategory ?? '') ? 70 : 45) +
      sportsPriorityBoost +
      Math.min(20, validation.marketsTouched * 2),
  );

  const integrityPenalty = clamp(
    validation.makerRebateCount * 5 +
      (validation.tradeActivityCount > 0 &&
      Math.abs(validation.buyActivityCount - validation.sellActivityCount) / validation.tradeActivityCount > 0.7
        ? 12
        : 0),
    0,
    35,
  );

  const trustScore = clamp(
    validation.realizedWinRate * 0.3 +
      Math.min(30, validation.closedPositionsCount * 2) +
      Math.min(20, validation.marketsTouched * 2) +
      consistencyScore * 0.25 -
      integrityPenalty,
  );

  const cautionFlags: string[] = [];
  if (integrityPenalty >= 20) {
    cautionFlags.push('Potential structural or noisy behavior detected');
  }
  if (validation.closedPositionsCount < 3) {
    cautionFlags.push('Small resolved sample size');
  }
  if (input.averageSpreadBps > 120 || input.averageTopOfBookUsd < 1500) {
    cautionFlags.push('Recent markets may be difficult to copy efficiently');
  }

  return {
    earlyEntryScore,
    categoryFocusScore,
    convictionScore,
    consistencyScore,
    marketSelectionScore,
    integrityPenalty,
    trustScore,
    confidenceEvidenceCount: validation.tradeActivityCount + validation.closedPositionsCount + supportingSignals,
    cautionFlags,
  };
};
