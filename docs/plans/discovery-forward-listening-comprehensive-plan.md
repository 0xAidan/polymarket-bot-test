# Discovery Forward Listening — Comprehensive Engineering Plan

**Date:** 2026-05-31  
**Status:** PLAN ONLY — no production forward ingest in the parent PR  
**Supersedes/extends:** `docs/research/2026-05-31-discovery-forward-fill-relayer-feasibility.md`  
**Budget constraint:** ≤ **$10 USD / day** total; **no Alchemy WebSocket** as primary; **hourly latency OK**

---

## Changelog vs 2026-05-31 relayer feasibility doc

| Topic | Prior doc | This doc |
|-------|-----------|----------|
| Relayer API | Disqualified with OpenAPI citations | **Reconfirmed — disqualify** (Appendix C) |
| Goldsky GraphQL | Recommended with V2 gaps | **Hourly poll + pagination**; V2 subgraph deprecated [DOC] |
| Primary MVP | Goldsky 5-min poll | **Hourly `eth_getLogs` on V2 contracts + optional filtered Goldsky Turbo** |
| Cost model | Qualitative | **Per-option $/day math** with [DOC]/[UNKNOWN] tags |
| Scoring integration | Mentioned | **Full B5 section** |
| Rollout | P0/P1 spikes | **Phased roadmap B8** |

---

## B1 — Problem definition

### B1.1 Past / present / future (operational)

| Mode | Meaning in this codebase | Source of truth |
|------|--------------------------|-----------------|
| **Past** | HuggingFace `users.parquet` / historical Goldsky backfill through coverage max ts | DuckDB `discovery_activity_v3` |
| **Present** | Latest per-wallet snapshot day in `discovery_feature_snapshots_v3` | Emitted by `04_emit_snapshots.ts` / hourly refresh |
| **Future** | Fills after coverage max ts → live tail → wallet profile upsert → snapshot tick | **Not shipped** — this plan |

**Coverage boundary [CODE]:** `DISCOVERY_V3_HISTORICAL_COVERAGE_MAX_TS` default `1772668800` (`coverageContract.ts`, `ENV_EXAMPLE.txt`).

### B1.2 Coverage scopes

| Scope | Definition | Whale discovery fit |
|-------|------------|---------------------|
| **Global fill coverage** | Every `OrderFilled` on CTF + NegRisk exchanges | **Required** for unknown whale discovery |
| **Market-scoped** | Poll `/trades` or CLOB WS per token/market | Misses wallets trading unwatched markets |
| **Wallet-scoped** | Data API `/activity?user=` | Validation + enrichment only |

### B1.3 Wallet resolution

- **Proxy vs EOA:** Activity attributes to `proxy_wallet` in v3 schema [CODE] `discovery-v3-architecture-notes.md`.
- **Maker/taker split:** Each chain event → two rows; taker `log_index + 1_000_000_000` [CODE] architecture notes.
- **Copy-trading pattern:** `POLYMARKET_FUNDER_ADDRESS` is the proxy holding funds [CODE] `agent-knowledge.mdc` §11.

---

## B2 — Complete option universe

Anti-hallucination tags: **[CODE]** repo | **[DOC]** official URL | **[WEB]** third-party | **[UNKNOWN]**

---

### Option 1 — Goldsky public GraphQL (`orderbook-subgraph/0.0.1`)

**[CODE]** Endpoint: `src/discovery/v3/goldskyListener.ts` → `GOLDSKY_ENDPOINT`  
**[DOC]** Rate limit: 50 req / 10s — https://docs.goldsky.com/subgraphs/graphql-endpoints  
**[DOC]** Post-2026-04-28: Polymarket subgraphs **deprecated/incomplete** — https://docs.goldsky.com/chains/polymarket

| Dimension | Assessment |
|-----------|------------|
| Coverage | Global while subgraph syncs; **V2 incomplete** after cutover [DOC] |
| Latency @ hourly | ≤60 min + indexing lag [UNKNOWN] |
| **$/day** | `24 polls × N pages × $0` ≈ **$0** [DOC] |
| Completeness risks | V1 schema; synthetic log_index [CODE]; 500/page without loop (fixed in polish PR) |
| Attribution | maker/taker addresses present |
| Scoring coupling | Hourly refresh rebuilds snapshots [CODE] `refreshWorker.ts` |
| Multi-tenant | DuckDB per deployment; SQLite read model per tenant in hosted mode [CODE] |
| Failure modes | Subgraph stall, V2 gap | Replay: re-poll with compound cursor |

**Math:** 2,000 fills/hr → 4 pages/poll → 96 req/day ≪ 50/10s → **$0/day** [DOC]

---

### Option 2 — Goldsky Mirror / Turbo Pipelines

**[DOC]** https://docs.goldsky.com/chains/polymarket — datasets `polymarket.order_filled` v2.0.0  
**[DOC]** Pricing: 750 worker-hrs/mo free; 1M events/mo free; +$1/100k events — https://docs.goldsky.com/pricing/summary

| Dimension | Assessment |
|-----------|------------|
| Coverage | Global on-chain v2 when pipeline active [DOC] |
| Latency | Native <1s; hourly batch sink OK |
| **$/day** | Filtered webhook ~50k rows/day → **~$0.17/day** [DOC][UNKNOWN volume] |
| | Unfiltered 5M events/mo → **~$1.33/day** [DOC] |
| | Unfiltered 50M/mo → **~$16/day — REJECT** over budget [DOC] |
| Completeness risks | Event volume blowout; hosted DB sink +$115/mo [DOC] |
| Attribution | v2 fields incl. builder [DOC] |
| Failure modes | Pipeline stall | Gap-fill: block-range backfill [DOC] |

**Recommendation:** **Runner-up** — filtered Turbo webhook → DuckDB, not 24/7 global firehose.

---

### Option 3 — Self-hosted subgraph → Postgres/DuckDB

**[WEB]** Community `poly_data` pattern; ** [DOC]** Polymarket moved to Goldsky Turbo not DIY subgraph

| Dimension | Assessment |
|-----------|------------|
| Coverage | High if maintained through v2 migrations |
| Latency | Indexer lag minutes–hours [WEB] |
| **$/day** | Lean: **$1–3/day** (VM + RPC) [UNKNOWN] |
| Ops burden | **High** — schema migrations, reorgs, monitoring |
| Verdict | **Reject for MVP** — ops cost > managed Turbo |

---

### Option 4 — Polygon RPC HTTP `eth_getLogs` (non-Alchemy)

**[DOC]** Public RPC list: https://docs.polygon.technology/pos/reference/rpc-endpoints  
**[DOC]** QuickNode trial: 5 blocks/request, 10M credits/mo — https://support.quicknode.com/articles/3261121056-understanding-the-10-000-block-range-limit-for-querying-logs-and-events  
**[CODE]** Legacy decoder: `src/discovery/chainListener.ts` (V2-capable when wired)

| Dimension | Assessment |
|-----------|------------|
| Coverage | **Global** for configured exchange contracts + OrderFilled topic [DOC] |
| Latency @ hourly | Poll ~1,800 blocks/hr (2s block time) [WEB] polygonblocktime.com |
| **$/day** | Public RPC: **$0** [DOC]; QN trial then ~**$1.6/day** sustained [DOC][UNKNOWN] |
| Completeness risks | Chunk errors, provider rate limits, must index V1+V2 during transition |
| Attribution | Full maker/taker from log decode [CODE] |
| Failure modes | RPC 429, incomplete ranges | Gap-fill: re-fetch block ranges |

**Math (hourly, 2 contracts, 5-block chunks):**  
720 calls/hr × 20 credits × 24 = 345,600 credits/day — fits QN trial [DOC]

**Verdict:** **Primary MVP candidate** — no Alchemy WS, hourly batch, global coverage.

---

### Option 5 — Polygon WS log subscribe

**[WEB]** Alchemy/Infura WS priced per compute unit — prior project experience: **rejected** as primary  
Cheaper alternatives (PublicNode, self-hosted erigon): **[UNKNOWN]** sustained global fill volume cost

| Dimension | Assessment |
|-----------|------------|
| Coverage | Global |
| Latency | 2–3s |
| **$/day** | Alchemy: **>>$10** at global fill volume [UNKNOWN] — **REJECT** |
| Verdict | Analyze only; **not recommended** under budget |

---

### Option 6 — Polymarket Data API `/trades`, `/activity`

**[DOC]** https://docs.polymarket.com/api-reference/core/get-user-activity — requires `user=`  
**[DOC]** Rate limits: general 1000/10s; `/trades` 200/10s — https://docs.polymarket.com/api-reference/rate-limits  
**[CODE]** Validator: `06_validate.ts`, `dataApiValidator.ts`

| Dimension | Assessment |
|-----------|------------|
| Coverage | **Per-wallet / per-market — NOT global** [DOC] |
| Latency @ hourly | OK for validation cohort |
| **$/day** | **$0** (500 wallets × 24 = 12k req/day) [DOC] |
| Verdict | **Hybrid validation only** — not discovery tail |

---

### Option 7 — CLOB REST `/data/trades`

**[DOC]** Authenticated user trades only — https://docs.polymarket.com/api-reference/trade/get-trades  
**Verdict:** **Reject** for global discovery [DOC]

---

### Option 8 — CLOB Market WebSocket

**[DOC]** `wss://ws-subscriptions-clob.polymarket.com/ws/market` — per `assets_ids`  
Fan-out: O(active markets × tokens) — **[UNKNOWN]** connection count at scale  
**Verdict:** **Reject** as global whale finder; OK for watched-market copy-trade

---

### Option 9 — RTDS WebSocket

**[DOC]** `wss://ws-live-data.polymarket.com` — comments, crypto/equity prices **NOT fills** — https://docs.polymarket.com/market-data/websocket/overview  
**Verdict:** **Disqualify** for forward-fill [DOC]

---

### Option 10 — Relayer API

**[CODE][DOC]** Disqualified in `2026-05-31-discovery-forward-fill-relayer-feasibility.md`  
Write path; `/transactions` per authenticated owner only; 25 submit/min [DOC]  
**Verdict:** **Do not use** — unchanged

---

### Option 11 — HuggingFace / parquet refresh

**[DOC]** https://huggingface.co/datasets/SII-WANGZJ/Polymarket_data — MIT license; updated 2026-03-05; coverage through **2026-03-04**  
**[CODE]** `00_fetch_parquet.ts`, `02_load_events.ts`

| Dimension | Assessment |
|-----------|------------|
| Coverage | Historical bulk; lag weeks–months |
| **$/day** | **$0** license; storage egress [UNKNOWN] |
| Verdict | **Daily reconcile** + live tail; not standalone forward path |

---

### Option 12 — Third-party analytics (Dune, Allium, ClickHouse)

**[DOC]** Dune `polymarket_polygon.*` ~24h refresh — https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/overview  
**[DOC]** Allium `polygon.predictions.trades` — https://docs.allium.so/historical-data/predictions  
**[WEB]** PolyNode ~$50/mo Starter — https://docs.polynode.dev/guides/rate-limits

| Provider | Live? | $/day | Role |
|----------|-------|-------|------|
| Dune Free | ~24h batch | **$0** | Reconcile positions/prices |
| Allium Realtime | 2–8s | **$10+** if API-primary [DOC] | Reject as primary |
| PolyNode Starter | ~seconds | **~$1.67** [WEB] | **Optional outsource** |

---

### Option 13 — Hybrid (recommended architecture)

```
Hourly eth_getLogs (V2 exchanges)
    → normalizeOrderFilledV2 [NEW]
    → DuckDB discovery_activity_v3
    → hourly refreshWorker (existing)
    → SQLite → API/UI

Daily: HF or Dune reconcile (drift detection)
Spot: Data API 06_validate sample
```

**$/day:** **$0–3** [DOC][UNKNOWN]

---

### Option 14 — Community indexer bots

**[WEB]** predmktdata Snapshot $49/mo; PolyNode $50/mo  
**[UNKNOWN]** API completeness vs chain without audit  
**Verdict:** Tier-2 if self-host `getLogs` ops unacceptable; require chain audit sample

---

## B3 — Decision matrix

**Weighted rubric:**

| Criterion | Weight |
|-----------|--------|
| Cost | 40% |
| Completeness | 25% |
| Ops complexity | 15% |
| Latency (hourly OK) | 10% |
| v3 alignment | 10% |

| Option | Cost | Complete | Ops | Latency | v3 fit | Weighted |
|--------|------|----------|-----|---------|--------|----------|
| Hourly `eth_getLogs` public RPC | 9 | 8 | 6 | 8 | 9 | **8.0** |
| Goldsky GraphQL hourly | 10 | 4 | 9 | 8 | 8 | 7.5 |
| Filtered Goldsky Turbo webhook | 8 | 9 | 7 | 9 | 10 | **8.4** |
| Hybrid getLogs + Dune reconcile | 9 | 9 | 5 | 7 | 9 | **8.1** |
| PolyNode Starter API | 8 | 8 | 10 | 9 | 7 | 8.0 |
| Alchemy WS | 1 | 9 | 8 | 10 | 7 | 4.5 |
| Data API alone | 10 | 2 | 10 | 8 | 5 | 5.5 |
| Relayer | N/A | 0 | — | — | — | **0** |

### Primary recommendation (MVP under $10/day)

**Filtered Goldsky Turbo `polymarket.order_filled` v2 → webhook/batch → DuckDB**, with **hourly `eth_getLogs` on public Polygon RPC** as **independent audit + fallback**.

Rationale:
- v2-complete fills [DOC]
- Stays near **$0–2/day** with filtered sink [DOC]
- No Alchemy WS
- Reuses `goldskyListener` normalize patterns + UNIQUE dedup [CODE]
- Hourly refresh already implemented [CODE] `workerIntegration.ts`

### Runner-up
Self-hosted **hourly `eth_getLogs` only** on public RPC — $0, more decode ops, full control.

### Explicitly rejected
| Option | Reason |
|--------|--------|
| Alchemy/global WS | Cost [owner constraint] |
| Relayer | Not a read path [DOC][CODE] |
| RTDS / CLOB market WS | Not global fills [DOC] |
| Data API polling | Not global [DOC] |
| Unfiltered global Turbo | >$10/day at scale [DOC] |
| Legacy Goldsky 0.0.1 alone | V2 incomplete [DOC] |

---

## B4 — Target architecture (plan-only)

```mermaid
flowchart LR
  subgraph ingest [Hourly ingest]
    RPC[Polygon eth_getLogs]
    GS[Goldsky Turbo webhook optional]
  end
  subgraph store [Analytics]
    NORM[normalizeOrderFilledV2]
    DUCK[(DuckDB discovery_activity_v3)]
    SNAP[buildSnapshotEmitSql]
    FEAT[(discovery_feature_snapshots_v3)]
  end
  subgraph score [Hourly tick]
    TIER[scoreTiers]
    PUB[finalizePublishScores]
    SQL[(SQLite read model)]
  end
  subgraph serve [App]
    API[/api/discovery/v3/*]
    UI[/discovery-v3/]
  end
  RPC --> NORM
  GS --> NORM
  NORM --> DUCK
  DUCK --> SNAP --> FEAT --> TIER --> PUB --> SQL --> API --> UI
```

### Future file checklist (no implementation now)

| File | Change |
|------|--------|
| `src/discovery/v3/orderFilledV2Decoder.ts` | **NEW** — decode V2 OrderFilled logs |
| `src/discovery/v3/rpcLogPoller.ts` | **NEW** — hourly `eth_getLogs` batch |
| `src/discovery/v3/goldskyListener.ts` | Extend for Turbo webhook payload OR keep GraphQL fallback |
| `src/discovery/v3/workerIntegration.ts` | Schedule RPC poller; env flags |
| `src/discovery/v3/featureFlag.ts` | `DISCOVERY_V3_RPC_POLL_ENABLED`, etc. |
| `scripts/backfill/07_goldsky_gap_fill.ts` | Gap heal patterns |
| `tests/v3-rpc-poller.test.ts` | **NEW** |

### Gap-fill strategy
1. Persist `last_processed_block` in `pipeline_cursor` [CODE]
2. On miss: re-fetch block range with overlap (e.g. 100 blocks)
3. `INSERT OR IGNORE` on UNIQUE(tx_hash, log_index) [CODE]
4. Weekly: compare row counts vs Dune/`06_validate` sample

### New wallet onboarding
- Live tail creates activity rows → next hourly snapshot includes wallet  
- No full historical backfill required for **ranking** (eligibility gates apply)  
- Optional: lazy backfill via Data API for wallets crossing signal threshold

---

## B5 — Scoring integration plan

1. **Trigger:** End of successful ingest batch OR hourly timer (existing `refreshIntervalMs`) [CODE]
2. **Snapshot:** DELETE + rebuild all snapshots [CODE] architecture notes — deterministic
3. **Score:** `scoreTiers` on copyable-filtered cohort [CODE] fixed in polish PR
4. **Publish:** Quality gate + optional display patch [CODE] `finalizePublishScores.ts`
5. **Monitoring:**
   - `score_breakdown_dump.ts` smell stats daily
   - Canary wallets: 5 known-good + 5 known-bad addresses
   - Alert if top-10 alpha has >2 negative PnL or any `copyable=0`

**Prevent high-score/bad-wallet recurrence:**
- Enforce copyability at rank time (**done**)
- Fix `distinct_markets` inflation (future)
- Pass `now_ts` consistently (**done**)
- Document whale tier ≠ profitability

---

## B6 — Cost guardrails & kill switches

| Guard | Mechanism |
|-------|-----------|
| Daily spend cap | Env `DISCOVERY_FORWARD_MAX_USD_DAY` — log-only initially [NEW] |
| RPC backoff | Exponential on 429; widen poll interval |
| Disable live ingest | `DISCOVERY_V3_GOLDSKY_ENABLED=false` + `DISCOVERY_V3_RPC_POLL_ENABLED=false` |
| Fail-safe | Keep last good SQLite publish; health shows stale cursor age [CODE] `/api/discovery/v3/health` |

**Recommended production defaults (budget mode):**
```
DISCOVERY_V3=true
DISCOVERY_V3_GOLDSKY_ENABLED=false   # until Turbo v2 wired
DISCOVERY_V3_RPC_POLL_ENABLED=true   # future flag
DISCOVERY_V3_RPC_POLL_INTERVAL_MS=3600000
POLYGON_RPC_URL=https://polygon-rpc.com  # or QuickNode paid if needed
```

---

## B7 — Validation & acceptance (future implementation PR)

| Metric | Target | Method |
|--------|--------|--------|
| Coverage | ≥95% of reference fills in 24h window | Sample 1000 chain fills vs DuckDB [UNKNOWN baseline] |
| Attribution | ≥99% rows with resolved proxy_wallet | SQL null check |
| Dedup | 0 duplicate (tx_hash, log_index) | `06_promotion_gate.ts` |
| Scoring lag | Tail → rank update ≤2 hours | Soak test |
| Smell test | ≤1/10 top alpha with negative PnL | `score_breakdown_dump.ts` |

**7-day burn-in:** Run hourly ingest + refresh; daily smell dump; no promotion until gate green.

---

## B8 — Phased rollout roadmap

| Phase | Scope | Est effort | Depends on |
|-------|--------|------------|------------|
| **P0** | RPC hourly poller + V2 decoder → DuckDB | 3–5 days | Polygon RPC, contract ABIs [DOC] |
| **P1** | Goldsky Turbo filtered webhook | 2–3 days | Goldsky account [DOC] |
| **P2** | Gap-fill automation + cursor health alerts | 1–2 days | P0 |
| **P3** | `distinct_markets` fix + composite pillar alignment | 2–4 days | Scoring audit sign-off |
| **P4** | Dune daily reconcile job | 1–2 days | Dune API key (optional) |

---

## B9 — Open questions & experiments

### Experiments (exact probes)

| # | Probe | Pass | Fail |
|---|-------|------|------|
| E1 | `curl -X POST $GOLDSKY_ENDPOINT -d '{query: orderFilledEvents(first:1)}'` | 200 + data | errors / empty post-cutover |
| E2 | `eth_getLogs` 1hr range on V2 exchange | >0 logs | 0 or RPC error |
| E3 | Compare 50 fills chain vs DuckDB | ≥95% match | <90% |
| E4 | 24h ingest cost estimate from RPC provider dashboard | ≤$10 | >$10 |
| E5 | Turbo webhook 1h trial event count | <100k/day filtered | >1M/day unfiltered |

### Owner decisions (max 5)

1. Accept **hourly** rank updates (vs 5-min)?
2. Prefer **self-host RPC** vs **Goldsky Turbo** as primary?
3. Is **whale tier = volume not PnL** acceptable in UI copy?
4. Budget for **QuickNode Build ($49/mo)** if public RPC unreliable?
5. Golden wallet list for smell tests (10 good + 10 bad addresses)?

---

## B10 — Appendices

### Appendix A — Source ledger

| URL | Tag |
|-----|-----|
| https://docs.goldsky.com/chains/polymarket | [DOC] |
| https://docs.goldsky.com/pricing/summary | [DOC] |
| https://docs.goldsky.com/subgraphs/graphql-endpoints | [DOC] |
| https://docs.polymarket.com/api-reference/rate-limits | [DOC] |
| https://docs.polymarket.com/resources/blockchain-data | [DOC] |
| https://docs.polymarket.com/market-data/websocket/overview | [DOC] |
| https://docs.polygon.technology/pos/reference/rpc-endpoints | [DOC] |
| https://huggingface.co/datasets/SII-WANGZJ/Polymarket_data | [DOC] |
| https://docs.dune.com/data-catalog/curated/prediction-markets/polymarket/overview | [DOC] |
| https://docs.allium.so/historical-data/predictions | [DOC] |
| https://docs.polynode.dev/guides/rate-limits | [WEB] |
| https://www.paradigm.xyz/2025/12/polymarket-volume-is-being-double-counted | [WEB] |

### Appendix B — ENV catalog (discovery)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DISCOVERY_V3` | false | Master v3 switch |
| `DUCKDB_PATH` | ./data/discovery_v3.duckdb | Analytics DB |
| `DISCOVERY_V3_GOLDSKY_ENABLED` | false | Legacy subgraph poll |
| `DISCOVERY_V3_SKIP_ACTIVITY_ART_INDEXES` | false | Backfill memory tradeoff |
| `DISCOVERY_V3_HISTORICAL_COVERAGE_MAX_TS` | 1772668800 | Coverage contract |
| `DISCOVERY_V3_LEGACY_WRITES` | unset | Cutover (unwired) |
| `DISCOVERY_ENABLED` | false | Legacy worker cycles |
| `DISCOVERY_ALCHEMY_WS_URL` | — | **Avoid** — cost |
| `GAP_MAX_NOTIONAL_USD` | 250000 | Ingest outlier cap [CODE] |

### Appendix C — Relayer comparison (unchanged verdict)

See full disqualification: `docs/research/2026-05-31-discovery-forward-fill-relayer-feasibility.md` §3–4.  
Relayer remains **write-only**, **per-user**, **25 submit/min** [DOC] — unsuitable for global discovery.

### Appendix D — Glossary

| Term | Meaning |
|------|---------|
| **OrderFilled** | On-chain log when CTF exchange matches an order |
| **Maker / Taker** | Resting vs aggressive side of fill |
| **Neg risk** | Negative-risk market type; separate exchange contract |
| **Proxy wallet** | Polymarket smart wallet holding USDC/positions (type 2 sig) |
| **Point-in-time purity** | Snapshots use only data with `ts < day_end` |

---

## Plain-language summary for owner

**What was broken:** Rankings could mark every wallet "inactive" due to a time bug; market-making bots could appear in top lists; Goldsky could skip trades when many happened at once; the dashboard implied live chain listening when it wasn't running.

**Why not Alchemy:** Streaming every trade over WebSocket costs too much and you already tried it. Hourly batch polling is enough for discovery.

**Recommended forward path:** Once a day (or hour), ask Polygon's blockchain for new trades using cheap public RPC, save them to DuckDB, re-score, update the dashboard. Optionally add Goldsky's newer v2 pipeline later for cleaner data. HuggingFace history stays as the past; this adds the future.

**What happens next:** A **separate implementation PR** builds the hourly RPC poller — this PR only fixes today's scoring/trust issues and delivers the full research plan.
