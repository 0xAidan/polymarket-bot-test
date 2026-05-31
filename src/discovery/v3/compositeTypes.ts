/**
 * Composite Score type definitions.
 *
 * The Composite Score is a wallet quality metric built from 5 pillars:
 *   1. Momentum  (Heat)        — recent 7d performance vs long-term baseline
 *   2. Consistency (Risk DNA)  — bet sizing discipline, tilt detection
 *   3. Niche      (Spray&Pray) — category focus / concentration (Phase 2)
 *   4. CLV        (Market Edge) — closing line value / alpha (Phase 3)
 *   5. Brier      (Accuracy)   — probabilistic calibration (Phase 4)
 *
 * Phase 1 implements Momentum + Consistency; others are stubbed at 0.
 */

// ---------------------------------------------------------------------------
// Raw stats computed by DuckDB queries
// ---------------------------------------------------------------------------

/** Per-wallet momentum stats from DuckDB. */
export interface WalletMomentumStats {
  proxy_wallet: string;
  /** Sum of trade-level edge (usd_notional × (price_yes − 0.5)) over last 7 days. */
  pnl_7d: number;
  /** Number of trades in last 7 days. */
  trades_7d: number;
  /** Sum of trade-level edge over last 30 days. */
  pnl_30d: number;
  /** Number of trades in last 30 days. */
  trades_30d: number;
  /** Average daily PnL across all active days. */
  avg_daily_pnl: number;
  /** Stddev of daily PnL across all active days. */
  std_daily_pnl: number;
  /** Number of distinct days with activity. */
  active_days: number;
}

/** Per-wallet bet sizing stats from DuckDB. */
export interface WalletConsistencyStats {
  proxy_wallet: string;
  /** Mean bet size (usd_notional) across all trades. */
  avg_bet_size: number;
  /** Standard deviation of bet sizes. */
  std_bet_size: number;
  /** Coefficient of variation: std/mean (lower = more consistent). */
  bet_size_cv: number;
  /** Total number of bets. */
  total_bets: number;
  /** Mean bet size over last 7 days (null if no recent trades). */
  avg_bet_7d: number | null;
  /** Largest single bet ever placed. */
  max_bet_size: number;
}

// ---------------------------------------------------------------------------
// Pillar scores (0–100 scale)
// ---------------------------------------------------------------------------

export interface CompositePillarScores {
  /** Heat Pillar: recent performance vs baseline (0–100). */
  momentum: number;
  /** Risk DNA: bet sizing consistency (0–100, higher = more consistent). */
  consistency: number;
  /** Spray & Pray: niche focus (0–100). Phase 2 — stub 0. */
  niche: number;
  /** Market Edge: closing line value (0–100). Phase 3 — stub 0. */
  clv: number;
  /** Probabilistic Accuracy: Brier score (0–100). Phase 4 — stub 0. */
  brier: number;
}

export interface CompositeWalletScore {
  proxy_wallet: string;
  /** Overall composite score (weighted blend of pillar scores, 0–100). */
  composite_score: number;
  /** Individual pillar scores. */
  pillars: CompositePillarScores;
  /** Per-pillar raw values for debugging / display. */
  momentum_z: number;
  bet_size_cv: number;
  pnl_7d: number;
  trades_7d: number;
  /** Timestamp when this score was computed. */
  computed_at: number;
}
