import { EligibilityInput, EligibilityResult } from './types.js';

export const ELIGIBILITY_THRESHOLDS = {
  MIN_OBSERVATION_SPAN_DAYS: 30,
  MIN_DISTINCT_MARKETS: 15,
  MIN_TRADE_COUNT: 50,
  MIN_CLOSED_POSITIONS: 10,
  MAX_DORMANCY_DAYS: 30,
  MIN_VOLUME_TOTAL: 10000,
  MIN_REALIZED_PNL: 0,
  MIN_PNL_PER_TRADE: 0,
} as const;

export function isEligible(input: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  const now = input.now_ts ?? Math.floor(Date.now() / 1000);

  // Hard gates use 50% of each threshold. Wallets in [50%, 100%) of the
  // threshold pass here and receive a proportional score penalty via
  // softGateMultiplier() in tierScoring.ts. Wallets below 50% are still
  // excluded entirely — they're too far from any reasonable quality bar.
  if (input.observation_span_days < ELIGIBILITY_THRESHOLDS.MIN_OBSERVATION_SPAN_DAYS * 0.5) {
    reasons.push('OBSERVATION_SPAN_TOO_SHORT');
  }
  if (input.distinct_markets < ELIGIBILITY_THRESHOLDS.MIN_DISTINCT_MARKETS * 0.5) {
    reasons.push('TOO_FEW_DISTINCT_MARKETS');
  }
  if (input.trade_count < ELIGIBILITY_THRESHOLDS.MIN_TRADE_COUNT * 0.5) {
    reasons.push('TOO_FEW_TRADES');
  }
  if (input.closed_positions < ELIGIBILITY_THRESHOLDS.MIN_CLOSED_POSITIONS * 0.5) {
    reasons.push('TOO_FEW_CLOSED_POSITIONS');
  }
  // Dormancy hard gate: fail if inactive for more than 2× MAX_DORMANCY_DAYS.
  // The soft zone (MAX_DORMANCY_DAYS → 2×MAX_DORMANCY_DAYS) is handled by
  // softGateMultiplierMax() in tierScoring.ts.
  const dormancyCutoff = now - ELIGIBILITY_THRESHOLDS.MAX_DORMANCY_DAYS * 2 * 86400;
  if (input.last_active_ts < dormancyCutoff) {
    reasons.push('DORMANT');
  }

  // Binary checks — threshold is 0 so there is no meaningful soft zone.
  if (input.realized_pnl < ELIGIBILITY_THRESHOLDS.MIN_REALIZED_PNL) {
    reasons.push('REALIZED_PNL_TOO_LOW');
  }
  if (input.closed_positions > 0) {
    const pnlPerClosed = input.realized_pnl / input.closed_positions;
    if (pnlPerClosed < ELIGIBILITY_THRESHOLDS.MIN_PNL_PER_TRADE) {
      reasons.push('PNL_PER_TRADE_TOO_LOW');
    }
  }
  if (input.volume_total < ELIGIBILITY_THRESHOLDS.MIN_VOLUME_TOTAL * 0.5) {
    reasons.push('VOLUME_TOTAL_TOO_LOW');
  }

  return { eligible: reasons.length === 0, reasons };
}
