type CopyabilityValidation = {
  makerRebateCount: number;
  tradeActivityCount: number;
  buyActivityCount: number;
  sellActivityCount: number;
};

type CopyabilityMarketContext = {
  averageSpreadBps: number;
  averageTopOfBookUsd: number;
};

export const computeCopyabilityScore = (
  validation: CopyabilityValidation,
  marketContext: CopyabilityMarketContext,
): number => {
  let score = 100;

  score -= Math.min(35, validation.makerRebateCount * 6);

  const tradeCount = Math.max(validation.tradeActivityCount, 1);
  const twoSidedRatio = Math.min(validation.buyActivityCount, validation.sellActivityCount) / tradeCount;
  score -= Math.min(20, twoSidedRatio * 40);

  if (tradeCount > 20) {
    score -= Math.min(15, (tradeCount - 20) * 1.2);
  }

  if (marketContext.averageSpreadBps > 100) {
    score -= Math.min(20, (marketContext.averageSpreadBps - 100) / 5);
  }

  if (marketContext.averageTopOfBookUsd < 1_000) {
    score -= Math.min(20, (1_000 - marketContext.averageTopOfBookUsd) / 50);
  }

  return Math.max(0, Math.round(score * 10) / 10);
};

export const passesCopyabilityGate = (score: number): boolean => score >= 55;
