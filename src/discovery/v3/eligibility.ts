import { EligibilityInput, EligibilityResult } from './types.js';

export const ELIGIBILITY_THRESHOLDS = {
  MIN_OBSERVATION_SPAN_DAYS: 30,
  MIN_DISTINCT_MARKETS: 15,
  MIN_TRADE_COUNT: 50,
  MIN_CLOSED_POSITIONS: 10,
  MAX_DORMANCY_DAYS: 30,
  MIN_VOLUME_TOTAL: 10000,
  // No single individual trader on Polymarket can exceed ~$500M lifetime volume.
  // Addresses above this threshold are almost certainly smart contracts, routing
  // aggregators, or CTF adapter proxies that funnel multiple users' trades.
  // We exclude them so they don't pollute tier rankings.
  MAX_VOLUME_TOTAL: 500_000_000,
  // Raised from 0 — wallets must have at least $100 total lifetime realized profit.
  // Prevents lucky-but-broke wallets from qualifying on volume alone.
  MIN_REALIZED_PNL: 100,
  // Raised from 0 — at least $0.50 average per closed position.
  // No-op at 0; at 0.50 it gates out noise traders who grind tiny edges.
  MIN_PNL_PER_TRADE: 0.5,
  // Wallets must have traded at least 10 times in the last 90 days.
  // Prevents dormant historical winners from ranking over active traders.
  MIN_RECENT_TRADES_90D: 10,
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
  // Aggregator / system contract guard: no individual Polymarket trader can
  // have > $500M lifetime volume. Addresses above this are routing contracts.
  if (input.volume_total > ELIGIBILITY_THRESHOLDS.MAX_VOLUME_TOTAL) {
    reasons.push('VOLUME_EXCEEDS_INDIVIDUAL_MAX');
  }

  // Recency gate: wallet must have traded in the last 90 days.
  // Only checked when the snapshot includes trade_count_90d (post-hardening backfills).
  // Pre-hardening snapshots (field absent) skip this gate to avoid retroactively
  // failing all existing data before a fresh backfill is available.
  if (
    input.trade_count_90d != null &&
    input.trade_count_90d < ELIGIBILITY_THRESHOLDS.MIN_RECENT_TRADES_90D
  ) {
    reasons.push('INSUFFICIENT_RECENT_ACTIVITY');
  }

  return { eligible: reasons.length === 0, reasons };
}
