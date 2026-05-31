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

/**
 * Recency multiplier: rewards wallets whose recent (90-day) PnL is tracking
 * above or at their historical daily rate, and penalises those who have gone
 * quiet or reversed.
 *
 * Formula:
 *   expected_pnl_90d = (lifetime_pnl / observation_span_days) × 90
 *   ratio = realized_pnl_90d / max(1, abs(expected_pnl_90d))
 *   multiplier = clamp(0.5 + 0.5 × ratio, 0.5, 1.5)
 *
 * Interpretations:
 *   ratio ≈ 1.0  → performing at historical rate  → multiplier = 1.0 (neutral)
 *   ratio > 2.0  → performing 2× historical rate  → multiplier = 1.5 (cap)
 *   ratio = 0    → no recent PnL                  → multiplier = 0.5 (half score)
 *   ratio < 0    → losing money recently           → multiplier < 0.5 (floor = 0.5)
 *
 * Only active when the snapshot includes `realized_pnl_90d` (post-hardening backfills).
 * Pre-hardening snapshots (field absent) return 1.0 (no change).
 */
function computeRecencyMultiplier(snap: V3FeatureSnapshot): number {
  if (snap.realized_pnl_90d == null || snap.observation_span_days <= 0) return 1.0;
  const dailyRate = snap.realized_pnl / Math.max(1, snap.observation_span_days);
  const expected90 = dailyRate * 90;
  const ratio = snap.realized_pnl_90d / Math.max(1, Math.abs(expected90));
  return Math.min(1.5, Math.max(0.5, 0.5 + 0.5 * ratio));
}

export interface NicheData {
  top_category: string;
  cat_volume_share: number;  // fraction of wallet's total volume in top category (0–1)
  cat_pnl: number;           // cash-flow PnL in the top category
}

export interface TierScoringInput {
  snapshot: V3FeatureSnapshot;
  now_ts: number;
  /** Niche data for this wallet — used to power the Specialist tier. */
  niche?: NicheData;
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
  input: TierScoringInput;
  reasons: string[];
}

export function shouldIncludeInTierRankings(
  proxyWallet: string,
  copyableByWallet: ReadonlyMap<string, { copyable: number }>
): boolean {
  const row = copyableByWallet.get(proxyWallet);
  return row?.copyable !== 0;
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
      trade_count_90d: snap.trade_count_90d,
      now_ts: x.now_ts ?? now,
    });
    return { wallet: snap.proxy_wallet, eligible, snapshot: snap, input: x, reasons };
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

  // Specialist: niche concentration × niche PnL × overall edge.
  // cat_volume_share: how focused the wallet is on one category (0–1).
  // cat_pnl: how much money they make in that category.
  // We combine: concentration × PnL as the "niche dominance" raw signal.
  const nicheDominance = eligible.map((r) => {
    const n = r.input.niche;
    if (!n) return 0;
    // Scale cat_pnl to be positive-anchored: a wallet losing $1000 in their niche
    // gets a negative dominance score — they specialize, but they're bad at it.
    return Math.max(0, n.cat_volume_share) * Math.max(0, n.cat_pnl);
  });
  const nicheConcentration = eligible.map((r) => r.input.niche?.cat_volume_share ?? 0);

  // Percentile-rank each feature independently before blending.
  // This makes every dimension outlier-resistant: one wallet with 50× the
  // median volume only reaches pct=1.0, not z≈50, so it can't drown out
  // the other dimensions in the weighted sum. The blend of per-feature
  // percentile ranks is then re-ranked at the end to produce the final
  // tier score (still a valid total order; just more evenly spaced).
  const pctEdge             = percentileRank(edgeRate);
  const pctBreadth          = percentileRank(breadth);
  const pctTrades           = percentileRank(tradeCount);
  const pctVolume           = percentileRank(volume);
  const pctSpan             = percentileRank(span);
  const pctNicheDominance   = percentileRank(nicheDominance);
  const pctNicheConcentration = percentileRank(nicheConcentration);

  const alphaRaw = eligible.map((_, i) =>
    0.45 * pctEdge[i] + 0.35 * pctBreadth[i] + 0.20 * pctTrades[i]
  );
  const whaleRaw = eligible.map((_, i) =>
    0.60 * pctVolume[i] + 0.25 * pctTrades[i] + 0.15 * pctSpan[i]
  );
  // Specialist: category dominance (PnL × concentration) drives 50%, focus 30%,
  // overall edge 20%. Wallets with no niche data get full percentile rank of 0
  // across the niche dimensions, naturally ranking below niche-identified wallets.
  const specialistRaw = eligible.map((_, i) =>
    0.50 * pctNicheDominance[i] + 0.30 * pctNicheConcentration[i] + 0.20 * pctEdge[i]
  );

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
    const softM    = computeSoftMultiplier(s, now);
    const recencyM = computeRecencyMultiplier(s);
    const combined = softM * recencyM;
    allRanked.push(
      { wallet: s.proxy_wallet, snapshot: s, tier: 'alpha',      score: alphaPct[i]      * 100 * combined, reasons: ['edge_rate', 'market_breadth', 'trade_count'] },
      { wallet: s.proxy_wallet, snapshot: s, tier: 'whale',      score: whalePct[i]      * 100 * combined, reasons: ['volume_total', 'trade_count', 'observation_span'] },
      { wallet: s.proxy_wallet, snapshot: s, tier: 'specialist', score: specialistPct[i] * 100 * combined, reasons: ['niche_dominance', 'niche_concentration', 'edge_rate'] },
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
        // True win rate: fraction of closed positions that were profitable.
        // Falls back to the old PnL-proxy if closed_positions_positive is not yet
        // present in the snapshot (pre-hardening backfill runs).
        hit_rate: r.snapshot.closed_positions > 0
          ? (r.snapshot.closed_positions_positive != null
              ? r.snapshot.closed_positions_positive / r.snapshot.closed_positions
              : Math.min(1, Math.max(0,
                  0.5 + (r.snapshot.realized_pnl / Math.max(1, r.snapshot.volume_total)) * 2
                )))
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
