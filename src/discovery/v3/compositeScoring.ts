/**
 * Composite Score pillar scoring logic.
 *
 * Converts raw DuckDB stats into 0–100 pillar scores and blends them into
 * a Composite Score. Phase 1 implements Momentum + Consistency;
 * Phase 2+ pillars (Niche, CLV, Brier) are stubbed at 0.
 *
 * Scoring uses percentile ranks across the eligible cohort (same approach
 * as the existing tier scoring) so outliers don't dominate.
 */
import type {
  WalletMomentumStats,
  WalletConsistencyStats,
  CompositePillarScores,
  CompositeWalletScore,
} from './compositeTypes.js';

// ---------------------------------------------------------------------------
// Percentile rank helper (shared with tierScoring.ts pattern)
// ---------------------------------------------------------------------------

function percentileRank(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const sorted = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(n);
  for (let k = 0; k < n; k++) ranks[sorted[k].i] = (k + 0.5) / n;
  return ranks;
}

// ---------------------------------------------------------------------------
// Pillar: Momentum (Heat)
// ---------------------------------------------------------------------------

export function computeMomentumZ(stats: WalletMomentumStats): number {
  if (stats.active_days < 14 || stats.std_daily_pnl <= 0) return 0;
  if (stats.trades_7d === 0) return -1;

  const recentAvgDailyPnl = stats.pnl_7d / 7;
  const z = (recentAvgDailyPnl - stats.avg_daily_pnl) / stats.std_daily_pnl;
  return z;
}

// ---------------------------------------------------------------------------
// Pillar: Consistency (Risk DNA)
// ---------------------------------------------------------------------------

export function computeConsistencyRaw(stats: WalletConsistencyStats): number {
  if (stats.total_bets < 10 || stats.avg_bet_size <= 0) return 0;

  const clampedCv = Math.max(0.1, Math.min(5.0, stats.bet_size_cv));
  let consistency = 1.0 / clampedCv;

  if (stats.avg_bet_7d !== null && stats.avg_bet_7d > 0) {
    const tiltRatio = stats.avg_bet_7d / stats.avg_bet_size;
    if (tiltRatio > 3.0) {
      const penalty = Math.min(0.8, (tiltRatio - 3.0) * 0.15);
      consistency *= (1.0 - penalty);
    }
  }

  return consistency;
}

// ---------------------------------------------------------------------------
// Composite Score
// ---------------------------------------------------------------------------

export interface CombinedWalletStats {
  proxy_wallet: string;
  // Consistency
  avg_bet_size: number;
  std_bet_size: number;
  bet_size_cv: number;
  total_bets: number;
  avg_bet_7d: number | null;
  max_bet_size: number;
  // Momentum
  pnl_7d: number;
  trades_7d: number;
  pnl_30d: number;
  trades_30d: number;
  avg_daily_pnl: number;
  std_daily_pnl: number;
  active_days: number;
  // Phase 3 pillars (optional — null if pillar query not yet run)
  brier_score?: number | null;        // lower is better; invert for percentile ranking
  avg_clv_1h?: number | null;         // higher is better
  pct_positive_clv_1h?: number | null; // higher is better
  cat_volume_share?: number | null;   // concentration in top category
  cat_pnl?: number | null;            // PnL in top category
}

export interface CompositeScoringOutput {
  scores: CompositeWalletScore[];
  stats: {
    total: number;
    scored: number;
  };
}

// Phase 1 (original): momentum 0.35 + consistency 0.35 = 0.70 active weight.
// Phase 3 (hardening): wire in Brier (0.20), CLV (0.10), Niche (0.15).
// Sum = 1.15 → renormalized inside scoreComposite to sum to 1.0 across active pillars.
// Set a pillar to 0.00 to disable it; the active-weight renormalization keeps
// the score in [0,100] regardless of how many pillars are active.
const PILLAR_WEIGHTS = {
  momentum:    0.30,
  consistency: 0.25,
  niche:       0.15,
  clv:         0.10,
  brier:       0.20,
} as const;

export function scoreComposite(
  stats: CombinedWalletStats[],
  topN = 500
): CompositeScoringOutput {
  if (stats.length === 0) return { scores: [], stats: { total: 0, scored: 0 } };

  const now = Math.floor(Date.now() / 1000);

  const momentumZs = stats.map((s) =>
    computeMomentumZ({
      proxy_wallet: s.proxy_wallet,
      pnl_7d: s.pnl_7d,
      trades_7d: s.trades_7d,
      pnl_30d: s.pnl_30d,
      trades_30d: s.trades_30d,
      avg_daily_pnl: s.avg_daily_pnl,
      std_daily_pnl: s.std_daily_pnl,
      active_days: s.active_days,
    })
  );
  const consistencyRaws = stats.map((s) =>
    computeConsistencyRaw({
      proxy_wallet: s.proxy_wallet,
      avg_bet_size: s.avg_bet_size,
      std_bet_size: s.std_bet_size,
      bet_size_cv: s.bet_size_cv,
      total_bets: s.total_bets,
      avg_bet_7d: s.avg_bet_7d,
      max_bet_size: s.max_bet_size,
    })
  );

  // Pillar: Brier score — invert so higher rank = better calibration.
  // If brier_score is null (no resolved positions) treat as worst case (0.25 = coin-flip).
  const brierRaws = stats.map((s) =>
    1.0 - (s.brier_score != null ? s.brier_score : 0.25)
  );

  // Pillar: CLV — use pct_positive_clv_1h if available, else avg_clv_1h.
  const clvRaws = stats.map((s) =>
    s.pct_positive_clv_1h != null ? s.pct_positive_clv_1h
    : s.avg_clv_1h != null ? s.avg_clv_1h
    : 0
  );

  // Pillar: Niche — product of volume concentration × category PnL percentile.
  // Use cat_volume_share as the raw input; category PnL is ranked separately.
  const nicheRaws = stats.map((s) =>
    (s.cat_volume_share ?? 0) * Math.max(0, s.cat_pnl ?? 0)
  );

  const pctMomentum    = percentileRank(momentumZs);
  const pctConsistency = percentileRank(consistencyRaws);
  const pctBrier       = percentileRank(brierRaws);
  const pctClv         = percentileRank(clvRaws);
  const pctNiche       = percentileRank(nicheRaws);

  // Active pillars are those with non-zero weight.
  const activeWeightSum =
    PILLAR_WEIGHTS.momentum + PILLAR_WEIGHTS.consistency +
    PILLAR_WEIGHTS.niche + PILLAR_WEIGHTS.clv + PILLAR_WEIGHTS.brier;
  const wMomentum    = PILLAR_WEIGHTS.momentum    / activeWeightSum;
  const wConsistency = PILLAR_WEIGHTS.consistency / activeWeightSum;
  const wBrier       = PILLAR_WEIGHTS.brier       / activeWeightSum;
  const wClv         = PILLAR_WEIGHTS.clv         / activeWeightSum;
  const wNiche       = PILLAR_WEIGHTS.niche       / activeWeightSum;

  const composites = stats.map((_, i) => {
    const pillars: CompositePillarScores = {
      momentum:    pctMomentum[i]    * 100,
      consistency: pctConsistency[i] * 100,
      niche:       pctNiche[i]       * 100,
      clv:         pctClv[i]         * 100,
      brier:       pctBrier[i]       * 100,
    };
    const composite_score =
      wMomentum    * pillars.momentum    +
      wConsistency * pillars.consistency +
      wBrier       * pillars.brier       +
      wClv         * pillars.clv         +
      wNiche       * pillars.niche;

    return {
      proxy_wallet:  stats[i].proxy_wallet,
      composite_score,
      pillars,
      momentum_z:    momentumZs[i],
      bet_size_cv:   stats[i].bet_size_cv,
      pnl_7d:        stats[i].pnl_7d,
      trades_7d:     stats[i].trades_7d,
      computed_at:   now,
    };
  });

  composites.sort((a, b) => b.composite_score - a.composite_score);
  const topScores = composites.slice(0, topN);

  return {
    scores: topScores,
    stats: { total: stats.length, scored: topScores.length },
  };
}
