# Discovery System Audit

**Date:** 2026-05-31  
**Scope:** Legacy ingest (V1/V2 worker), Discovery v3 (DuckDB + Goldsky + refresh), API/UI surfaces  
**Method:** Code read + subagent explore pass; findings cite verified file paths

---

## Executive summary

The repo runs **three overlapping discovery paths** that are easy to confuse:

| Path | Production owner | Live fill ingest? |
|------|------------------|-------------------|
| Legacy `DiscoveryManager` (chain + API poller) | Main app, **passive mode only** | **No** — worker mode never started |
| V2 `DiscoveryWorkerRuntime` | `discoveryWorker.ts` / `start.cjs` | **No** — wallet seeding + scoring only (`freeModeNoAlchemy`) |
| V3 DuckDB pipeline | Same worker when `DISCOVERY_V3=true` | **Partial** — Goldsky off by default post–V2 cutover |

**Top risk:** Dashboard and `/api/discovery/status` can imply live chain/API ingest when the legacy worker path is dead. V3 rankings can look “random” when copyability filters, eligibility time base, and percentile tier design are misunderstood.

---

## Flag matrix (verified)

| Variable | Behavior | Reference |
|----------|----------|-----------|
| `DISCOVERY_V3` | Must be exactly `'true'` | `src/discovery/v3/featureFlag.ts:1-3` |
| `DISCOVERY_V3_GOLDSKY_ENABLED` | `'false'` default in `ENV_EXAMPLE.txt`; unset → off after 2026-04-28 cutover | `featureFlag.ts:6-19`, `ENV_EXAMPLE.txt:140` |
| `DISCOVERY_V3_LEGACY_WRITES` | Documented cutover guard; **not wired** into write paths | `src/discovery/v3/legacyMode.ts` |
| `DISCOVERY_V3_SKIP_ACTIVITY_ART_INDEXES` | Skips UNIQUE index; live dedup weaker | `ENV_EXAMPLE.txt:136-137` |

---

## Findings

### P0 — Critical

#### P0-1 Legacy chain listener + API poller never run in production
- **Issue:** `DiscoveryManager('worker')` is never constructed; only `passive` on main app.
- **Evidence:** `src/server.ts` (~line 74); no `DiscoveryManager('worker')` in repo.
- **Impact:** Real-time legacy ingest is dead code at runtime.
- **Fix status:** Documented; forward path deferred to Phase B plan. Status API now reports honestly (`discoveryControlPlane.ts`).

#### P0-2 Cross-source dedup key mismatch (chain vs API)
- **Issue:** Chain uses `txHash:logIndex`; API uses `txHash:detectedAt:assetId:side`. Same fill → two SQLite rows.
- **Evidence:** `chainListener.ts:199-204`, `apiPoller.ts:188-193`, `database.ts:217`
- **Fix status:** **Open** — requires canonical key normalization (future PR; not in this polish pass).

#### P0-3 V3 refresh loads full wallet cohort into Node for `scoreTiers`
- **Issue:** Batched DuckDB read still accumulates all snapshots in one `rows[]` for percentile ranking.
- **Evidence:** `refreshWorker.ts:86-120`, `172-193`
- **Fix status:** **Open** — needs DuckDB-side percentile or sharded scoring for 2M+ wallets.

---

### P1 — High

#### P1-1 V3 bootstrap failure was silent
- **Issue:** DuckDB/Goldsky/refresh failure logged but V2 cycles continued with no health flag.
- **Evidence:** `discoveryWorker.ts:683-689`
- **Fix status:** **Fixed** — writes `data/discovery-v3-worker-state.json` on success/failure (`workerState.ts`).

#### P1-2 Goldsky cursor could skip events at equal timestamps
- **Issue:** Single page + `timestamp_gt` cursor loses events when ≥500 share a timestamp.
- **Evidence:** `goldskyListener.ts` (pre-fix)
- **Fix status:** **Fixed** — compound `(timestamp, id)` cursor + pagination loop.

#### P1-3 Copyability filter computed but not applied to tier rankings
- **Issue:** `copyable=0` market makers still ranked in tiers.
- **Evidence:** `refreshWorker.ts`, `05_score_and_publish.ts`
- **Fix status:** **Fixed** — `shouldIncludeInTierRankings()` filters before `scoreTiers()`.

#### P1-4 Eligibility dormancy used wall-clock `Date.now()` instead of scoring `now_ts`
- **Issue:** Historical snapshots/backtests marked all wallets dormant when `now_ts` omitted.
- **Evidence:** `tierScoring.ts` → `isEligible()` (pre-fix)
- **Fix status:** **Fixed** — passes `now_ts` from tier scoring input.

#### P1-5 `/api/discovery/status` misreported chain/API health
- **Issue:** `chainListener.connected` always `false`; `apiPoller.running` inferred from run-log freshness.
- **Evidence:** `discoveryControlPlane.ts:198-208` (pre-fix)
- **Fix status:** **Fixed** — reads runtime heartbeat when present; adds explanatory `note` fields and `v3` block.

#### P1-6 Goldsky disabled + V1 schema post–V2 cutover
- **Issue:** Default config has no live global fill tail until forward path implemented.
- **Evidence:** `workerIntegration.ts:64-91`, `ENV_EXAMPLE.txt:138-140`
- **Fix status:** Documented in forward plan; **not implementing forward ingest in this PR**.

#### P1-7 Composite score in publish path uses 2 pillars only
- **Issue:** Production DuckDB query blends momentum + consistency; Brier/CLV/niche stored but unused for rank.
- **Evidence:** `compositeQueries.ts:149-151` vs `compositeScoring.ts:109-115`
- **Fix status:** **Open** — documented in scoring audit; recalibration needs owner sign-off.

#### P1-8 `/api/discovery/signals` synthesizes from reason strings
- **Issue:** Not the `signalEngine` DB path.
- **Evidence:** `discoveryRoutes.ts:1178-1193`
- **Fix status:** **Open** — label API response or wire real signals.

---

### P2 — Medium

#### P2-1 `DISCOVERY_V3_LEGACY_WRITES` guard unused
- **Reference:** `legacyMode.ts` — only tested, never called from writers.

#### P2-2 `distinct_markets` snapshot inflation (SUM of daily approx counts)
- **Reference:** `scripts/backfill/04_emit_snapshots.ts:309`
- **Impact:** Eligibility + alpha breadth overstated.

#### P2-3 Publish display PnL patch without re-rank
- **Reference:** `finalizePublishScores.ts:141-181`

#### P2-4 V2 gates soft-only (surface bucket suppression)
- **Reference:** `discoveryScorer.ts:41-53`, `strategyClassifier.ts:80-81`

#### P2-5 In-memory dedup FIFO eviction at 50k keys
- **Reference:** `tradeIngestion.ts:25-26`, `181-189`

#### P2-6 Goldsky row insert uses string-built SQL
- **Reference:** `goldskyListener.ts:182-198` — batch path preferred for backfill.

---

## Backfill / data integrity (A3)

| Check | Script / path | Notes |
|-------|---------------|-------|
| HF parquet fetch | `scripts/backfill/00_fetch_parquet.ts` | `users.parquet` needs ~70GB free |
| DuckDB load + dedup | `02_load_events.ts`, `02d_dedup_and_index.ts` | GROUP BY + arg_min pattern required (ops doc) |
| Snapshots | `04_emit_snapshots.ts` | DELETE+rebuild; determinism tested |
| Score publish | `05_score_and_publish.ts` | SQLite read model |
| Coverage validate | `06_validate.ts` | 20-wallet Data API spot check, 1% tolerance |
| Promotion gate | `06_promotion_gate.ts` | Hard block on integrity failures |

**Coverage contract:** `DISCOVERY_V3_HISTORICAL_COVERAGE_MAX_TS` default `1772668800` — see `coverageContract.ts`, `discovery-v3-operations.md`.

**Known gap:** HF dataset ends **2026-03-04** [DOC] https://huggingface.co/datasets/SII-WANGZJ/Polymarket_data — forward tail requires separate ingest (Phase B plan only).

---

## Fixes delivered in this PR

1. Goldsky pagination + compound cursor (`goldskyListener.ts`, `schema.ts`)
2. Copyability exclusion from tier rankings (`tierScoring.ts`, `refreshWorker.ts`, `05_score_and_publish.ts`)
3. Eligibility `now_ts` propagation (`tierScoring.ts`) — **real scoring bug**
4. V3 worker bootstrap health file (`workerState.ts`, `discoveryWorker.ts`)
5. Honest discovery status API (`discoveryControlPlane.ts`, `types.ts`)
6. Eligibility tests aligned to 50% hard gates (`tests/v3-eligibility.test.ts`)
7. Score breakdown diagnostic (`scripts/diagnostics/score_breakdown_dump.ts`)

---

## Recommended next steps (not this PR)

1. Implement forward ingest per `docs/plans/discovery-forward-listening-comprehensive-plan.md`
2. Normalize cross-source dedup keys (P0-2)
3. Fix `distinct_markets` to true COUNT DISTINCT (P2-2)
4. Wire or remove `DISCOVERY_V3_LEGACY_WRITES`
5. Align composite scoring query with 5-pillar spec or document intentional 2-pillar MVP
