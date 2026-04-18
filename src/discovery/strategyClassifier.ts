import {
  DiscoveryConfidenceBucket,
  DiscoverySurfaceBucket,
  DiscoveryStrategyClass,
  DiscoveryWalletValidation,
} from './types.js';

const HIGH_INFORMATION_CATEGORIES = new Set([
  'politics',
  'macro',
  'company',
  'legal',
  'geopolitics',
  'sports',
]);

type StrategyClassifierInput = {
  focusCategory?: string;
  validation: DiscoveryWalletValidation;
  copyabilityScore: number;
  earlyScore: number;
  noisePenalty: number;
};

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));

export const classifyDiscoveryStrategy = (
  input: StrategyClassifierInput,
): DiscoveryStrategyClass => {
  const { validation, copyabilityScore, earlyScore, noisePenalty, focusCategory } = input;
  const buySellGap = Math.abs(validation.buyActivityCount - validation.sellActivityCount);
  const balancedOrderFlow = validation.tradeActivityCount > 0 && buySellGap / validation.tradeActivityCount < 0.2;

  if (noisePenalty >= 20 || validation.makerRebateCount >= 12) {
    return 'suspicious';
  }

  if (validation.makerRebateCount >= 5 && balancedOrderFlow) {
    return copyabilityScore < 45 ? 'structural_arbitrage' : 'market_maker';
  }

  if (earlyScore >= 18 && HIGH_INFORMATION_CATEGORIES.has(focusCategory ?? '')) {
    return 'informational_directional';
  }

  if (validation.tradeActivityCount >= 10 && earlyScore < 12) {
    return 'reactive_momentum';
  }

  return validation.tradeActivityCount >= 4 ? 'informational_directional' : 'unknown';
};

export const computeConfidenceBucket = (input: {
  observationCount: number;
  distinctMarkets: number;
  recencyHours: number;
  strategyClass: DiscoveryStrategyClass;
}): DiscoveryConfidenceBucket => {
  const observationScore = clamp((input.observationCount / 20) * 100);
  const marketBreadthScore = clamp((input.distinctMarkets / 10) * 100);
  const recencyScore = input.recencyHours <= 24 ? 100 : input.recencyHours <= 72 ? 70 : 40;
  const strategyPenalty = input.strategyClass === 'unknown' ? 12 : 0;
  const confidenceScore = clamp(
    observationScore * 0.5 + marketBreadthScore * 0.25 + recencyScore * 0.25 - strategyPenalty,
  );

  if (confidenceScore >= 75) return 'high';
  if (confidenceScore >= 45) return 'medium';
  return 'low';
};

export const resolveDiscoverySurfaceBucket = (input: {
  discoveryScore: number;
  trustScore: number;
  copyabilityScore: number;
  strategyClass: DiscoveryStrategyClass;
  failedGates: string[];
  confidenceBucket: DiscoveryConfidenceBucket;
}): DiscoverySurfaceBucket => {
  if (input.failedGates.length > 0 || input.strategyClass === 'suspicious') {
    return 'suppressed';
  }

  if (input.copyabilityScore >= 70 && input.trustScore >= 70) {
    return 'copyable';
  }

  if (input.trustScore >= 70 && input.discoveryScore >= 60) {
    return 'trusted';
  }

  if (input.discoveryScore >= 60 && input.copyabilityScore >= 55 && input.trustScore >= 50) {
    return 'emerging';
  }

  return 'watch_only';
};
