import { DittoExecutionState } from './types.js';

export interface DittoEngineInput {
  trade_count: number;
  pnl_7d: number;
  momentum_z: number;
  bet_size_cv: number;
  tier_score: number; // 0-100 percentile score
}

/**
 * Derives the Ditto Execution State based on the JUNGLE Score stats
 * returned from the SQL pillars.
 * 
 * Rules:
 * - NEW/UNRANKED: < 12 trades
 * - COOLDOWN/PAUSED: Score drops below threshold, or extreme variance (cv > 4.0)
 * - HOT STREAK: Positive PnL and high momentum vs avg
 * - SLOWING/REVERTING: Negative momentum vs avg
 * - CONSISTENT PERFORMER: Default stable state
 */
export function determineDittoState(input: DittoEngineInput): DittoExecutionState {
  if (input.trade_count < 12) {
    return DittoExecutionState.NEW_UNRANKED;
  }

  // Cooldown / Paused: Score below 45 (45th percentile) or extreme unit drifting (CV > 4.0)
  if (input.tier_score < 45 || input.bet_size_cv > 4.0) {
    return DittoExecutionState.COOLDOWN_PAUSED;
  }

  // Hot Streak: Score exceeds 80 and has high momentum (z > 1.5)
  if (input.tier_score >= 80 && input.momentum_z > 1.5 && input.pnl_7d > 0) {
    return DittoExecutionState.HOT_STREAK;
  }

  // Slowing / Reverting: Score is dipping or edge is fading (negative momentum)
  if (input.momentum_z < 0 && input.tier_score < 70) {
    return DittoExecutionState.SLOWING_REVERTING;
  }

  return DittoExecutionState.CONSISTENT_PERFORMER;
}
