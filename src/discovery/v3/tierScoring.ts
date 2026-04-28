import { V3FeatureSnapshot, V3WalletScore, TierName } from './types.js';
import { isEligible } from './eligibility.js';

/**
 * Latest-per-wallet reduction over a set of snapshots. The snapshots already
 * respect point-in-time purity; the most recent one is the "present" feature
 * row for ranking.
 */
export function latestSnapshotPerWallet(
  snapshots: V3FeatureSnapshot[]
): Map<string, V3FeatureSnapshot> {
  const byWallet = new Map<string, V3FeatureSnapshot>();
  for (const s of snapshots) {
    const existing = byWallet.get(s.proxy_wallet);
    if (!existing || s.snapshot_day > existing.snapshot_day) {
      byWallet.set(s.proxy_wallet, s);
    }
  }
  return byWallet;
}

/**
 * Pearson-style z-score over an already-filtered (eligible) cohort. Falls back
 * to 0 for a zero-variance cohort so the rank-by-z is well-defined.
 */
function zScores(values: number[]): number[] {
  if (values.length === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  if (std === 0) return values.map(() => 0);
  return values.map((v) => (v - mean) / std);
}

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

export interface TierScoringInput {
  snapshot: V3FeatureSnapshot;
  now_ts: number;
}

export interface TierScoringOutput {
  scores: V3WalletScore[];
  stats: {
    total: number;
    eligible: number;
    rejection_rate: number;
  };
}

interface Scored {
  wallet: string;
  eligible: boolean;
  snapshot: V3FeatureSnapshot;
  reasons: string[];
}

/**
 * Tier scoring per parent plan §6. Alpha uses a blended edge/activity z-score,
 * Whales sort by observation-weighted volume, Specialists is a placeholder
 * single-category score (real impl requires category-level snapshots).
 */
export function scoreTiers(
  inputs: TierScoringInput[],
  topN: number = 500
): TierScoringOutput {
  const now = inputs[0]?.now_ts ?? Math.floor(Date.now() / 1000);

  const preScored: Scored[] = inputs.map((x) => {
    const snap = x.snapshot;
    const { eligible, reasons } = isEligible({
      observation_span_days: snap.observation_span_days,
      distinct_markets: snap.distinct_markets,
      trade_count: snap.trade_count,
      closed_positions: snap.closed_positions,
      last_active_ts: snap.last_active_ts,
      realized_pnl: snap.realized_pnl,
      volume_total: snap.volume_total,
    });
    return { wallet: snap.proxy_wallet, eligible, snapshot: snap, reasons };
  });

  const eligible = preScored.filter((r) => r.eligible);

  // Alpha: blend realized edge rate + activity breadth.
  const edgeRate = eligible.map((r) =>
    r.snapshot.closed_positions > 0
      ? r.snapshot.realized_pnl / Math.max(1, r.snapshot.closed_positions)
      : 0
  );
  const breadth = eligible.map((r) => r.snapshot.distinct_markets);
  const tradeCount = eligible.map((r) => r.snapshot.trade_count);
  const volume = eligible.map((r) => r.snapshot.volume_total);
  const span = eligible.map((r) => r.snapshot.observation_span_days);

  // Percentile-rank each feature independently before blending.
  // This makes every dimension outlier-resistant: one wallet with 50× the
  // median volume only reaches pct=1.0, not z≈50, so it can't drown out
  // the other dimensions in the weighted sum. The blend of per-feature
  // percentile ranks is then re-ranked at the end to produce the final
  // tier score (still a valid total order; just more evenly spaced).
  const pctEdge    = percentileRank(edgeRate);
  const pctBreadth = percentileRank(breadth);
  const pctTrades  = percentileRank(tradeCount);
  const pctVolume  = percentileRank(volume);
  const pctSpan    = percentileRank(span);

  const alphaRaw      = eligible.map((_, i) => 0.45 * pctEdge[i]    + 0.35 * pctBreadth[i] + 0.20 * pctTrades[i]);
  const whaleRaw      = eligible.map((_, i) => 0.60 * pctVolume[i]  + 0.25 * pctTrades[i]  + 0.15 * pctSpan[i]);
  const specialistRaw = eligible.map((_, i) => 0.55 * pctEdge[i]    + 0.25 * pctBreadth[i] + 0.20 * pctVolume[i]);

  const alphaPct = percentileRank(alphaRaw);
  const whalePct = percentileRank(whaleRaw);
  const specialistPct = percentileRank(specialistRaw);

  interface Ranked {
    wallet: string;
    snapshot: V3FeatureSnapshot;
    tier: TierName;
    score: number;
    reasons: string[];
  }
  const allRanked: Ranked[] = [];

  for (let i = 0; i < eligible.length; i++) {
    const s = eligible[i].snapshot;
    allRanked.push(
      { wallet: s.proxy_wallet, snapshot: s, tier: 'alpha',       score: alphaPct[i] * 100,      reasons: ['edge_rate', 'market_breadth', 'trade_count'] },
      { wallet: s.proxy_wallet, snapshot: s, tier: 'whale',       score: whalePct[i] * 100,      reasons: ['volume_total', 'trade_count', 'observation_span'] },
      { wallet: s.proxy_wallet, snapshot: s, tier: 'specialist',  score: specialistPct[i] * 100, reasons: ['edge_rate', 'market_breadth', 'volume_total'] },
    );
  }

  const byTier: Record<TierName, Ranked[]> = { alpha: [], whale: [], specialist: [] };
  for (const r of allRanked) byTier[r.tier].push(r);
  for (const tier of Object.keys(byTier) as TierName[]) {
    byTier[tier].sort((a, b) => b.score - a.score);
    byTier[tier] = byTier[tier].slice(0, topN);
  }

  const out: V3WalletScore[] = [];
  for (const tier of Object.keys(byTier) as TierName[]) {
    const rows = byTier[tier];
    for (let rank = 0; rank < rows.length; rank++) {
      const r = rows[rank];
      out.push({
        proxy_wallet: r.wallet,
        tier,
        tier_rank: rank + 1,
        score: r.score,
        volume_total: r.snapshot.volume_total,
        trade_count: r.snapshot.trade_count,
        distinct_markets: r.snapshot.distinct_markets,
        closed_positions: r.snapshot.closed_positions,
        realized_pnl: r.snapshot.realized_pnl,
        hit_rate:r.snapshot.closed_positions > 0
        ? Math.min(1, Math.max(0,
            0.5 + (r.snapshot.realized_pnl / r.snapshot.volume_total) * 2
          ))
        : null,
        last_active_ts: r.snapshot.last_active_ts,
        reasons_json: JSON.stringify(r.reasons),
        updated_at: now,
      });
    }
  }

  return {
    scores: out,
    stats: {
      total: preScored.length,
      eligible: eligible.length,
      rejection_rate: preScored.length === 0 ? 0 : 1 - eligible.length / preScored.length,
    },
  };
}
