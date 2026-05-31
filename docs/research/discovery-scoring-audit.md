# Discovery Scoring Forensic Audit

**Date:** 2026-05-31  
**Audience:** Product + engineering  
**Related:** `docs/plans/2026-04-14-discovery-ranking-model-spec.md`, `docs/discovery-v3-architecture-notes.md`

---

## 1. Two parallel scoring systems

| System | Store | Primary sort | Used by UI |
|--------|-------|--------------|------------|
| **Legacy V2** | SQLite `discovery_wallet_scores_v2` | Weighted `finalScore` + surface bucket | Legacy discovery tab |
| **V3 tiers** | DuckDB snapshots → SQLite `discovery_wallet_scores_v3` | Percentile tier score per alpha/whale/specialist | `/discovery-v3/` |

They answer different questions. Rank order **will not** match raw Polymarket PnL by design — but several wiring bugs made the gap worse than intended.

---

## 2. Legacy (V2) pipeline

### 2.1 Whale score (`walletScorer.ts`)
Additive points (~108 max): volume, ROI, consistency, size, diversity, PnL, positions. Used for heat indicators and legacy sort fallback.

### 2.2 Dimension pipeline (`discoveryWorker.ts` → `discoveryScorer.ts`)

| Dimension | Weight | Module |
|-----------|--------|--------|
| Profitability | 0.35 | `featureEngine.ts` |
| Copyability | 0.25 | `copyabilityScorer.ts` |
| Focus | 0.20 | `featureEngine.ts` + worker blend |
| Consistency | 0.10 | `featureEngine.ts` |
| Early | 0.10 | `earlyEntryScorer.ts` |
| Conviction | 0.05 | `featureEngine.ts` |
| Noise | subtract | `featureEngine.ts` |

**Gates (thresholds only):** profitability ≥55, focus ≥50, copyability ≥55.  
**Enforcement:** Soft — failed gates set `surfaceBucket=suppressed` (`strategyClassifier.ts:80-81`) but rows remain in DB with full `finalScore`.

---

## 3. V3 pipeline

### 3.1 Snapshots (`04_emit_snapshots.ts`)
Point-in-time daily cumulative features. Cash-flow PnL + resolution payouts on closed markets.

**Known data issue — `distinct_markets` inflation:**

```309:309:scripts/backfill/04_emit_snapshots.ts
              SUM(distinct_markets_day)          OVER w   AS distinct_markets,
```

Summing daily approximate distinct counts **double-counts** markets active on multiple days → inflates breadth → helps alpha tier + eligibility.

### 3.2 Eligibility (`eligibility.ts`)

Hard gates at **50%** of numeric thresholds (soft zone 50–100% penalized in `tierScoring.ts`).  
Dormancy hard fail at **2× MAX_DORMANCY_DAYS (60 days)**.

**Bug fixed this PR:** `scoreTiers()` did not pass `now_ts` into `isEligible()`, so dormancy used real wall clock and could mark all backfill wallets dormant during scoring.

### 3.3 Tier scoring (`tierScoring.ts`)

Eligible cohort only → percentile ranks → tier blends → second percentile → score 0–150.

| Tier | Blend |
|------|-------|
| **Alpha** | 45% edge rate (pnl/closed), 35% breadth, 20% trades |
| **Whale** | 60% volume, 25% trades, 15% span — **ignores PnL** |
| **Specialist** | 50% niche dominance, 30% concentration, 20% edge |

**Why top wallets fail smell test:**
1. **Whale tier** ranks volume kings, not profitability.
2. **Percentile ranks** cluster scores 90+ for eligible cohort top.
3. **Display PnL patch** updates card stats without re-ranking (`finalizePublishScores.ts`).
4. **Copyability** was metadata-only — **fixed:** non-copyable wallets excluded from tier rank input.

### 3.4 Composite score (production vs spec)

- **Spec:** 5 pillars in `compositeScoring.ts` (momentum, consistency, niche, CLV, Brier).
- **Production:** DuckDB query uses **(momentum + consistency) / 2** only (`compositeQueries.ts:151`).
- Brier/CLV/niche computed and stored; **do not affect tier_rank**.

### 3.5 Publish path
1. `scoreTiers` → eligible rankings  
2. `finalizePublishScores` → Polymarket profile enrichment + quality gate  
3. Reference PnL fallback for failed wallets (`reference_display: true` skips heuristics)  
4. Top-50 display patch overwrites PnL/volume **without re-sort**

---

## 4. Smell test rubric (written)

A top-10 wallet in **alpha** tier should:
- [ ] Have `realized_pnl > 0` (or documented reference_display override)
- [ ] Have `copyable !== 0` (**now enforced at rank time**)
- [ ] Have `hit_rate` from `closed_positions_positive` when available (not PnL/volume proxy)
- [ ] Not be an obvious market maker (`maker_ratio < 0.7`)
- [ ] Have traded within 60 days (hard) / 30 days (soft penalty)

A top-10 wallet in **whale** tier may be high-volume/low-PnL **by design** — UI should label tier intent.

**Score distribution:** Expect top percentile × multipliers → many scores 85–100; not a bug if documented.

---

## 5. Bugs vs weights vs stale data

| Symptom | Root cause | Type | Status |
|---------|------------|------|--------|
| All wallets ineligible after backfill | Missing `now_ts` in eligibility | **Bug** | **Fixed** |
| Market makers in top alpha | Copyability not filtered | **Bug** | **Fixed** |
| Rank ≠ displayed PnL | Publish patch without re-rank | **Bug/UX** | Open |
| High scores clustered 90+ | Double percentile + eligible-only cohort | **Design** | Document |
| Whale top is losing wallet | Whale tier ignores PnL | **Design** | Document |
| Breadth inflated | SUM distinct_markets_day | **Bug** | Open |
| V2 gate fail still high score | Soft suppression only | **Design** | Open |
| Stale ranks | Snapshot not re-emitted | **Ops** | Run 04+05 |

---

## 6. Diagnostics

### New script
```bash
npx tsx scripts/diagnostics/score_breakdown_dump.ts --top 50 --random 50
npx tsx scripts/diagnostics/score_breakdown_dump.ts --addresses 0xabc...,0xdef...
```

Prints tier rank, score, PnL, volume, hit rate, copyable, maker ratio per wallet + smell summary.

### Recommended follow-ups
- `distinct_markets_inflation.ts` — compare SUM vs COUNT DISTINCT from activity table
- `rank_vs_pnl_correlation.ts` — Spearman ρ rank vs PnL
- `composite_pillar_drift.ts` — 2-pillar vs 5-pillar rank delta

---

## 7. Tests updated/added

| File | Change |
|------|--------|
| `tests/v3-eligibility.test.ts` | Aligned to 50% hard gates |
| `tests/v3-tier-copyability.test.ts` | Copyability filter helper |
| `tests/v3-scoring.test.ts` | Tier membership assertions (design-accurate) |
| `tests/v3-goldsky-listener.test.ts` | Pagination + cursor API |

---

## 8. Recalibration policy (future)

Do **not** change tier weights without:
1. Before/after table on golden wallet set (≥20 addresses)
2. Smell rubric pass rate on top-50 per tier
3. Owner sign-off on whale tier “volume not PnL” UX

Composite 5-pillar alignment is a **separate decision** from tier ranking.
