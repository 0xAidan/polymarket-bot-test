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
}

export interface CompositeScoringOutput {
  scores: CompositeWalletScore[];
  stats: {
    total: number;
    scored: number;
  };
}

const PILLAR_WEIGHTS = {
  momentum:    0.35,
  consistency: 0.35,
  niche:       0.00,
  clv:         0.00,
  brier:       0.00,
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

  const pctMomentum    = percentileRank(momentumZs);
  const pctConsistency = percentileRank(consistencyRaws);

  const activeWeightSum = PILLAR_WEIGHTS.momentum + PILLAR_WEIGHTS.consistency;
  const wMomentum    = PILLAR_WEIGHTS.momentum    / activeWeightSum;
  const wConsistency = PILLAR_WEIGHTS.consistency / activeWeightSum;

  const composites = stats.map((_, i) => {
    const pillars: CompositePillarScores = {
      momentum:    pctMomentum[i]    * 100,
      consistency: pctConsistency[i] * 100,
      niche: 0,
      clv:   0,
      brier: 0,
    };
    const composite_score =
      wMomentum    * pillars.momentum +
      wConsistency * pillars.consistency;

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
