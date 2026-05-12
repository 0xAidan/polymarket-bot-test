import { V3FeatureSnapshot, V3WalletScore, TierName } from './types.js';
import { isEligible, ELIGIBILITY_THRESHOLDS } from './eligibility.js';

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

/**
 * Soft gate for lower-bound thresholds (larger-is-better dimensions).
 *
 *   value >= min          → 1.0  (full score, no penalty)
 *   min*0.5 <= value < min → linear ramp from 0 → 1  (partial score)
 *   value < min*0.5        → 0    (hard exclude — caller already filtered these out
 *                                  via isEligible, but 0 is returned defensively)
 *
 * Linear ramp: (value − min×0.5) / (min×0.5)
 *   At value = min×0.5 → 0   At value = min → 1
 */
function softGateMultiplier(value: number, min: number): number {
  if (value >= min) return 1.0;
  if (value < min * 0.5) return 0;
  return (value - min * 0.5) / (min * 0.5);
}

/**
 * Soft gate for upper-bound thresholds (smaller-is-better dimensions, e.g. dormancy).
 *
 *   value <= max          → 1.0
 *   max < value <= max*2  → linear ramp from 1 → 0
 *   value > max*2          → 0  (hard exclude)
 */
function softGateMultiplierMax(value: number, max: number): number {
  if (value <= max) return 1.0;
  if (value > max * 2) return 0;
  return (max * 2 - value) / max;
}

/**
 * Combined soft multiplier for a single snapshot.
 * Takes the minimum across all dimensions so the tightest constraint governs.
 * Wallets fully above every threshold return 1.0; wallets in the soft zone
 * on any dimension are penalised proportionally on their final score.
 */
function computeSoftMultiplier(snap: V3FeatureSnapshot, nowTs: number): number {
  const dormancyDays = (nowTs - snap.last_active_ts) / 86400;
  return Math.min(
    softGateMultiplier(snap.trade_count,           ELIGIBILITY_THRESHOLDS.MIN_TRADE_COUNT),
    softGateMultiplier(snap.distinct_markets,      ELIGIBILITY_THRESHOLDS.MIN_DISTINCT_MARKETS),
    softGateMultiplier(snap.closed_positions,      ELIGIBILITY_THRESHOLDS.MIN_CLOSED_POSITIONS),
    softGateMultiplier(snap.volume_total,          ELIGIBILITY_THRESHOLDS.MIN_VOLUME_TOTAL),
    softGateMultiplier(snap.observation_span_days, ELIGIBILITY_THRESHOLDS.MIN_OBSERVATION_SPAN_DAYS),
    softGateMultiplierMax(dormancyDays,            ELIGIBILITY_THRESHOLDS.MAX_DORMANCY_DAYS),
  );
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

  // ── Extract raw features from eligible cohort ──
  const edgeRate = eligible.map((r) =>
    r.snapshot.closed_positions > 0
      ? r.snapshot.realized_pnl / Math.max(1, r.snapshot.closed_positions)
      : 0
  );
  const breadth = eligible.map((r) => r.snapshot.distinct_markets);
  const tradeCount = eligible.map((r) => r.snapshot.trade_count);
  const volume = eligible.map((r) => r.snapshot.volume_total);
  const span = eligible.map((r) => r.snapshot.observation_span_days);

  // Momentum proxy: last_active_ts — higher (more recent) is better.
  const momentum = eligible.map((r) => r.snapshot.last_active_ts);

  // Consistency proxy: average bet size (volume / trades). More consistent
  // sizing produces a higher percentile relative to the cohort.
  const consistency = eligible.map((r) =>
    r.snapshot.trade_count > 0
      ? r.snapshot.volume_total / r.snapshot.trade_count
      : 0
  );

  // Percentile-rank each feature independently before blending.
  // This makes every dimension outlier-resistant: one wallet with 50× the
  // median volume only reaches pct=1.0, not z≈50, so it can't drown out
  // the other dimensions in the weighted sum. The blend of per-feature
  // percentile ranks is then re-ranked at the end to produce the final
  // tier score (still a valid total order; just more evenly spaced).
  const pctEdge        = percentileRank(edgeRate);
  const pctBreadth     = percentileRank(breadth);
  const pctTrades      = percentileRank(tradeCount);
  const pctVolume      = percentileRank(volume);
  const pctSpan        = percentileRank(span);
  const pctMomentum    = percentileRank(momentum);
  const pctConsistency = percentileRank(consistency);

  // Alpha (edge-focused, sharp bettors): 35% edge + 25% breadth + 20% momentum + 15% consistency + 5% trades
  const alphaRaw      = eligible.map((_, i) => 0.35 * pctEdge[i] + 0.25 * pctBreadth[i] + 0.20 * pctMomentum[i] + 0.15 * pctConsistency[i] + 0.05 * pctTrades[i]);
  // Whale (volume-focused): 55% volume + 20% trades + 15% span + 10% consistency
  const whaleRaw      = eligible.map((_, i) => 0.55 * pctVolume[i] + 0.20 * pctTrades[i] + 0.15 * pctSpan[i] + 0.10 * pctConsistency[i]);
  // Specialist (consistency-focused, safe to copy): 35% edge + 30% consistency + 20% momentum + 15% breadth
  const specialistRaw = eligible.map((_, i) => 0.35 * pctEdge[i] + 0.30 * pctConsistency[i] + 0.20 * pctMomentum[i] + 0.15 * pctBreadth[i]);

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
    const softM = computeSoftMultiplier(s, now);
    allRanked.push(
      { wallet: s.proxy_wallet, snapshot: s, tier: 'alpha',      score: alphaPct[i]     * 100 * softM, reasons: ['edge_rate', 'market_breadth', 'momentum', 'consistency', 'trade_count'] },
      { wallet: s.proxy_wallet, snapshot: s, tier: 'whale',      score: whalePct[i]     * 100 * softM, reasons: ['volume_total', 'trade_count', 'observation_span', 'consistency'] },
      { wallet: s.proxy_wallet, snapshot: s, tier: 'specialist', score: specialistPct[i] * 100 * softM, reasons: ['edge_rate', 'consistency', 'momentum', 'market_breadth'] },
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
        // True hit rate requires per-market resolution data (Brier pillar, Phase 4).
        // The edge proxy (realized_pnl = Σ notional × (price−0.5)) is always positive
        // for above-50-cent buys and produces 100% for nearly every wallet — misleading.
        hit_rate: null,
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
