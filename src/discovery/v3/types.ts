export type TierName = 'alpha' | 'whale' | 'specialist';

export enum DittoExecutionState {
  NEW_UNRANKED = 'NEW_UNRANKED',
  CONSISTENT_PERFORMER = 'CONSISTENT_PERFORMER',
  HOT_STREAK = 'HOT_STREAK',
  SLOWING_REVERTING = 'SLOWING_REVERTING',
  COOLDOWN_PAUSED = 'COOLDOWN_PAUSED',
}

export interface V3ActivityRow {
  proxy_wallet: string;
  market_id: string;
  condition_id: string;
  event_id: string | null;
  ts_unix: number;
  block_number: number;
  tx_hash: string;
  log_index: number;
  role: 'maker' | 'taker';
  side: 'BUY' | 'SELL';
  price_yes: number;
  usd_notional: number;
  signed_size: number;
  abs_size: number;
}

export interface V3MarketRow {
  market_id: string;
  condition_id: string | null;
  event_id: string | null;
  question: string | null;
  slug: string | null;
  token1: string | null;
  token2: string | null;
  answer1: string | null;
  answer2: string | null;
  closed: number;
  neg_risk: number;
  outcome_prices: string | null;
  volume_total: number | null;
  created_at: string | null;
  end_date: string | null;
  updated_at: string | null;
}

export interface V3FeatureSnapshot {
  proxy_wallet: string;
  snapshot_day: string;
  trade_count: number;
  volume_total: number;
  distinct_markets: number;
  closed_positions: number;
  realized_pnl: number;
  unrealized_pnl: number;
  first_active_ts: number;
  last_active_ts: number;
  observation_span_days: number;
  /** Rolling 90-day trade count — for recency eligibility gate. */
  trade_count_90d?: number;
  /** Rolling 90-day volume in USD. */
  volume_90d?: number;
  /** Rolling 90-day realized PnL — for recency multiplier. */
  realized_pnl_90d?: number;
  /** Count of (wallet, market) pairs closed at a profit — true win-rate numerator. */
  closed_positions_positive?: number;
}

export interface V3WalletScore {
  proxy_wallet: string;
  tier: TierName;
  tier_rank: number;
  score: number;
  volume_total: number;
  trade_count: number;
  distinct_markets: number;
  closed_positions: number;
  realized_pnl: number;
  hit_rate: number | null;
  last_active_ts: number;
  reasons_json: string;
  updated_at: number;
  /** Composite Score — overall quality metric (0–100). Null if not yet computed. */
  composite_score?: number | null;
  /** Momentum pillar — recent performance vs baseline (0–100). */
  momentum_score?: number | null;
  /** Consistency pillar — bet sizing discipline (0–100). */
  consistency_score?: number | null;
  ditto_state?: string | null;
  /** Brier score (0–1, lower = better calibrated). Null if no resolved positions. */
  brier_score?: number | null;
  /** Average CLV over 1h window (positive = wallet enters before favorable moves). */
  avg_clv_1h?: number | null;
  /** Fraction of trades with positive 1h CLV. */
  pct_positive_clv_1h?: number | null;
  /** Top market category by volume (politics, crypto, sports, etc.). */
  top_category?: string | null;
  /** Fraction of total volume in the top category (0–1). */
  cat_volume_share?: number | null;
  /** Fraction of trades filled as maker (high = likely market maker, low copyability). */
  maker_ratio?: number | null;
  /** Whether this wallet passes the copyability gate (1 = copyable, 0 = excluded). */
  copyable?: number | null;
  /** Most recent signal type from the signal engine. */
  latest_signal?: string | null;
  /** Unix timestamp of the latest signal. */
  latest_signal_ts?: number | null;
}

export interface EligibilityInput {
  observation_span_days: number;
  distinct_markets: number;
  trade_count: number;
  closed_positions: number;
  last_active_ts: number;
  /** Total realized PnL (same units as v3 feature snapshots). */
  realized_pnl: number;
  /** Cumulative notional volume (eligibility: MIN_VOLUME_TOTAL). Not the same as `hit_rate` (scoring only). */
  volume_total: number;
  /** Rolling 90-day trade count — for recency gate. */
  trade_count_90d?: number;
  now_ts?: number;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}
