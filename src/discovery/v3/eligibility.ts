import { EligibilityInput, EligibilityResult } from './types.js';

export const ELIGIBILITY_THRESHOLDS = {
  MIN_OBSERVATION_SPAN_DAYS: 30,
  MIN_DISTINCT_MARKETS: 10,
  MIN_TRADE_COUNT: 20,
  MIN_CLOSED_POSITIONS: 5,
  MAX_DORMANCY_DAYS: 45,
} as const;

export function isEligible(input: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  const now = input.now_ts ?? Math.floor(Date.now() / 1000);

  if (input.observation_span_days < ELIGIBILITY_THRESHOLDS.MIN_OBSERVATION_SPAN_DAYS) {
    reasons.push('OBSERVATION_SPAN_TOO_SHORT');
  }
  if (input.distinct_markets < ELIGIBILITY_THRESHOLDS.MIN_DISTINCT_MARKETS) {
    reasons.push('TOO_FEW_DISTINCT_MARKETS');
  }
  if (input.trade_count < ELIGIBILITY_THRESHOLDS.MIN_TRADE_COUNT) {
    reasons.push('TOO_FEW_TRADES');
  }
  if (input.closed_positions < ELIGIBILITY_THRESHOLDS.MIN_CLOSED_POSITIONS) {
    reasons.push('TOO_FEW_CLOSED_POSITIONS');
  }
  const dormancyCutoff = now - ELIGIBILITY_THRESHOLDS.MAX_DORMANCY_DAYS * 86400;
  if (input.last_active_ts < dormancyCutoff) {
    reasons.push('DORMANT');
  }

  return { eligible: reasons.length === 0, reasons };
}
