export type TierName = 'alpha' | 'whale' | 'specialist';

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
  now_ts?: number;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}
