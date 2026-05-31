# Discovery v3 Forward-Fill: Can the Polymarket Relayer API Help?

**Date:** 2026-05-31  
**Audience:** Aidan (product owner)  
**Author:** Engineering research pass  
**Verdict:** **NO** — the Relayer API cannot solve Discovery v3 forward-fill.

---

## 1. Question & Verdict

**Question:** After the HuggingFace backfill completes, can we use Polymarket’s Relayer “Submit a transaction” API to keep Discovery v3 always up to date?

**Answer:** **No.** The Relayer is a **write path** for gasless on-chain actions (redeem, merge, approvals, wallet deploy). It does **not** expose global `OrderFilled` trade activity. Discovery needs a **read path** that sees every wallet’s fills on Polygon — the Relayer only sees transactions **your app submitted through the relayer for your own users**.

**What you likely confused it with:**

| You might have meant | What it actually does |
|----------------------|------------------------|
| **Relayer “Submit a transaction”** | Sends *your* signed txs; pays gas for *your* users |
| **Relayer “Get recent transactions”** | Lists *your authenticated user’s* relayer-submitted txs only |
| **Data API `/activity` or `/trades`** | Read API for per-wallet or per-market trades (still not global) |
| **Goldsky subgraph / Mirror pipeline** | On-chain analytics — what Polymarket recommends and what v3 already uses |

The bot **already uses the Relayer correctly** in `src/positionLifecycle.ts` for gasless redeem/merge — that pattern is unrelated to discovery ingestion.

---

## 2. Executive Summary (plain English)

1. **Do not pursue Relayer for discovery forward-fill.** It is the wrong tool category.
2. **Keep the current architecture:** HuggingFace parquet backfill → DuckDB, then **Goldsky orderbook subgraph polling** for live tail (already wired in `workerIntegration.ts`).
3. **Improve forward-fill by fixing known Goldsky gaps**, not by swapping in Relayer — especially V2 `OrderFilled` compatibility, synthetic `log_index` / missing `condition_id`, 5-minute poll latency, and gap-fill dedup guards.
4. **Long-term upgrade path:** Polymarket’s official analytics guidance points to **Goldsky streaming pipelines (Mirror)** into your own database — same event source, better ops than hand-rolled GraphQL polling.
5. **Optional hybrid:** Data API validation (already in `06_validate.ts`) + periodic chain-listener bridge for low-latency V2 fills — but only as enhancement, not replacement for global ingest.
6. **Relayer read endpoints** (`GET /transactions`) only return txs **you submitted via relayer for one owner address** — useless for finding whale wallets globally.
7. **Rate limits confirm the mismatch:** Relayer `/submit` is capped at **25 requests/minute** — appropriate for redeem/merge, not millions of discovery events/day.
8. **Next engineering work (P0):** Harden Goldsky live ingest (V2 normalizer, batch insert, dedup, poll interval tuning). **P1:** Spike chainListener → DuckDB v3 bridge. **P2:** Evaluate Goldsky Mirror vs self-hosted subgraph poll.

---

## 3. What the Relayer Actually Does

Primary sources:

- [Submit a transaction](https://docs.polymarket.com/api-reference/relayer/submit-a-transaction)
- [Get a transaction by ID](https://docs.polymarket.com/api-reference/relayer/get-a-transaction-by-id)
- [Get recent transactions for a user](https://docs.polymarket.com/api-reference/relayer/get-recent-transactions-for-a-user)
- [Get relayer address and nonce](https://docs.polymarket.com/api-reference/relayer/get-relayer-address-and-nonce)
- [Relayer OpenAPI](https://docs.polymarket.com/api-spec/relayer-openapi.yaml)
- [Gasless Transactions](https://docs.polymarket.com/trading/gasless.md)
- [Rate Limits](https://docs.polymarket.com/api-reference/rate-limits.md)

### 3.1 Endpoint inventory

| Endpoint | Method | Read/Write | Auth | Global trade data? |
|----------|--------|------------|------|-------------------|
| `/submit` | POST | **Write** | Builder HMAC **or** Relayer API key headers | **No** — submits one signed tx |
| `/transaction?id=` | GET | Read (status) | **None** (public poll by tx ID) | **No** — one relayer job you already submitted |
| `/transactions` | GET | Read (history) | Builder HMAC **or** Relayer API key | **No** — recent txs **owned by authenticated user only** |
| `/nonce?address=&type=` | GET | Read (setup) | None | **No** — wallet nonce for signing |
| `/relay-payload?address=&type=` | GET | Read (setup) | None | **No** — relayer address + nonce |
| `/deployed?address=` | GET | Read (setup) | None | **No** — wallet deploy status |
| `/relayer/api/keys` | GET | Read (admin) | Gamma or Relayer API key | **No** — key management |

**Auth headers (from OpenAPI):**

- **Builder:** `POLY_BUILDER_API_KEY`, `POLY_BUILDER_TIMESTAMP`, `POLY_BUILDER_PASSPHRASE`, `POLY_BUILDER_SIGNATURE`
- **Relayer API key:** `RELAYER_API_KEY`, `RELAYER_API_KEY_ADDRESS` (must match key owner)

**Rate limits ([Rate Limits](https://docs.polymarket.com/api-reference/rate-limits.md)):**

| Endpoint | Limit |
|----------|-------|
| Relayer `/submit` | **25 req / 1 min** |
| Other Relayer GET endpoints | Not listed separately (general throttling via Cloudflare) |

**`/submit` payload (write):** `from`, `to`, `proxyWallet`, `data` (encoded calldata), `nonce`, `signature`, `signatureParams`, `type` (`SAFE` | `PROXY`). Response: `transactionID`, `state` (`STATE_NEW`). On-chain hash comes later via `GET /transaction`.

**`/transactions` response fields:** `transactionID`, `transactionHash`, `from`, `to`, `proxyAddress`, `data`, `nonce`, `state`, `type`, `owner`, timestamps. These describe **relayer-submitted contract calls** (e.g. redeem to CTF address), **not** parsed `OrderFilled` maker/taker rows.

**[Gasless doc](https://docs.polymarket.com/trading/gasless.md) explicitly lists covered operations:**

- Wallet deployment  
- Token approvals  
- CTF split / merge / redeem  
- Transfers  

Trading / order matching is **not** listed. Order placement goes through the **CLOB API**, not the Relayer.

### 3.2 Hypothesis test: write vs read

| Hypothesis | Result |
|------------|--------|
| Relayer is a transaction submission API | **Confirmed** — OpenAPI description: “Submit and track gasless transactions” |
| Relayer exposes global OrderFilled feed | **Disproved** — no list-all-trades endpoint; `/transactions` is per authenticated owner |
| “Recent transactions” means all Polymarket trades | **Disproved** — doc says “transactions submitted to the Relayer, **owned by a specific user**” |

---

## 4. Polymarket Read Paths That *Could* Feed Discovery

Built from [llms.txt](https://docs.polymarket.com/llms.txt) (2026-05-31 fetch). **Read paths only.**

| API / source | Base URL | Scope | Auth | Discovery fit |
|--------------|----------|-------|------|---------------|
| **Data API `/activity`** | `data-api.polymarket.com` | Per **user** (required `user=` param) | None | Per-wallet backfill/validation; not global |
| **Data API `/trades`** | `data-api.polymarket.com` | Per **user** and/or **market** | None | Market-scoped polling (legacy `apiPoller.ts`); incomplete globally |
| **Data API positions, closed-positions, leaderboard** | same | Per user / aggregates | None | Scoring enrichment, not raw fill stream |
| **CLOB `/trades`, `/data/trades`** | `clob.polymarket.com` | **Authenticated user’s** trades | L2 API key | Copy-trading, not global discovery |
| **CLOB Market WebSocket** | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | Per subscribed **token IDs** | None | Real-time book/trades for watched markets only |
| **CLOB User WebSocket** | [User Channel](https://docs.polymarket.com/market-data/websocket/user-channel.md) | **Authenticated user** orders/fills | API key | Not global |
| **RTDS WebSocket** | [RTDS](https://docs.polymarket.com/market-data/websocket/rtds.md) | Comments, crypto/equity prices | Varies | Not trade fills |
| **Goldsky subgraph** (public GraphQL) | `api.goldsky.com/.../orderbook-subgraph/...` | **Global** OrderFilled index | None | **Current v3 live ingest** |
| **Goldsky Mirror / streaming** | [Goldsky Polymarket](https://docs.goldsky.com/chains/polymarket) | **Global** on-chain activity | Goldsky account | **Official analytics recommendation** |
| **Polygon RPC `eth_subscribe` logs** | Your Alchemy/Infura WS | **Global** OrderFilled on exchange contracts | RPC key | Legacy `chainListener.ts`; 2–3s latency |
| **Dune / Allium / ClickHouse CryptoHouse** | Third-party | **Global** SQL analytics | Account | Research/backfill, not live bot path |

**Official analytics guidance ([Data Resources](https://docs.polymarket.com/resources/blockchain-data.md)):**

> “Polymarket data that lands on the blockchain… is available through various on-chain analytics platforms… **Goldsky provides real-time streaming pipelines** for Polymarket on-chain activity (i.e. trades, balances, positions…) into your own database.”

No mention of Relayer for analytics.

---

## 5. What Discovery v3 Needs

From repo docs and code:

### 5.1 Data model

`discovery_activity_v3` (DuckDB) — one row per **wallet side** of each fill:

| Column | Purpose |
|--------|---------|
| `proxy_wallet`, `role` (`maker`/`taker`), `side` | Who traded |
| `tx_hash`, `log_index` | Dedup key (`UNIQUE`) |
| `ts_unix`, `block_number` | Time ordering / snapshots |
| `market_id`, `condition_id`, `event_id` | Market attribution |
| `price_yes`, `usd_notional`, `signed_size`, `abs_size` | Scoring inputs |

### 5.2 Pipeline (authoritative)

```
Historical: HuggingFace users.parquet → scripts/backfill/00–06 → discovery_activity_v3
Live:       Goldsky subgraph (~5 min) → goldskyListener.ts → discovery_activity_v3
Analytics:  buildSnapshotEmitSql() → discovery_feature_snapshots_v3 → tierScoring → SQLite → UI
```

See: `docs/discovery-v3-operations.md`, `docs/discovery-v3-architecture-notes.md`.

### 5.3 Live ingest implementation

| File | Role |
|------|------|
| `src/discovery/v3/goldskyListener.ts` | Poll Goldsky GraphQL; `normalizeOrderFilled()`; insert rows |
| `src/discovery/v3/workerIntegration.ts` | 5-min interval; opens DuckDB; starts refresh loop |
| `src/discovery/v3/refreshWorker.ts` | Hourly snapshot rebuild + SQLite publish |
| `src/discovery/v3/coverageContract.ts` | Exposes backfill cutoff + live cursor in `/health` |

**Cursor persistence:** SQLite table `pipeline_cursor` (`pipeline='live'`). Goldsky reuses `last_block` column to store **last timestamp** (not block number) because the subgraph paginates on `timestamp_gt`.

**Backfill boundary:** `DISCOVERY_V3_HISTORICAL_COVERAGE_MAX_TS` (default `1772668800` = 2026-03-05). Live ingest appends rows with `ts_unix > cursor`. Overlap deduped by `UNIQUE(tx_hash, log_index)`.

---

## 6. Gap Analysis: Relayer vs Discovery v3

| Requirement | Discovery v3 | Relayer API |
|-------------|--------------|-------------|
| See **all wallets** globally | Required | **Not supported** |
| `OrderFilled`-level granularity | Required (maker + taker rows) | **No** — only relayer tx metadata |
| Map to `(tx_hash, log_index)` | Required | **No** — relayer has `transactionHash` but not log index / maker-taker split |
| `condition_id` / `market_id` | Required for snapshots | **No** — would need decoding `data` calldata per tx |
| Millions of events/day | Yes | **No** — 25 submits/min; reads are per-user |
| Continuous with HF backfill | Same schema | **Different semantics** entirely |
| V1 + V2 OrderFilled | Needed post–Apr 2026 | **N/A** |

**Would Relayer data map to `NormalizedV3Row`?** Only in a tortured sense: you could decode redeem/merge calldata from **your** relayer txs into non-trade activity — but discovery scores **trades**, not your bot’s redemptions. Even then you’d see **one wallet**, not the ecosystem.

---

## 7. Codebase Audit: What’s Risky Today in Forward-Fill

### 7.1 Goldsky live path (`goldskyListener.ts`)

| Issue | Severity | Detail |
|-------|----------|--------|
| **Synthetic `log_index`** | Medium | Derived from `orderHash` hash, not chain log index — dedup with backfill works at boundary but differs from parquet rows |
| **Missing `condition_id`, `event_id`** | Medium | Set empty/null; `market_id` = token asset id only |
| **`block_number = 0`** | Low | Subgraph schema gap |
| **V2 compatibility unknown** | **High** | Subgraph still V1-shaped (`makerAssetId`/`takerAssetId`); [V1/V2 audit](docs/2026-04-28-v1-v2-activity-shape-audit.md) flags this |
| **5-minute poll interval** | Medium | Staleness vs chain listener’s 2–3s |
| **Row-by-row insert in live path** | Low | `insertNormalizedRows()` not batch; OK at live volume |
| **Gap-fill duplicate risk** | **High** (historical) | [Display accuracy doc](docs/plans/discovery-display-accuracy.md) — dupes inflated PnL; mitigations added but ops-sensitive |
| **ART index OOM** | Ops | `DISCOVERY_V3_SKIP_ACTIVITY_ART_INDEXES` disables dedup index on large DBs |

### 7.2 Legacy paths (not writing DuckDB v3)

| File | Behavior | Gap |
|------|----------|-----|
| `chainListener.ts` | Alchemy WS; **V1 + V2** decode → `TradeIngestion` | **Does not write `discovery_activity_v3`** |
| `apiPoller.ts` | Data API `/trades` per top markets → legacy discovery | Market-biased, not global, not v3 |
| `tradeIngestion.ts` | Batches to legacy SQLite discovery tables | Separate from v3 DuckDB |

### 7.3 Relayer usage today (`positionLifecycle.ts`)

- `RelayClient` at `https://relayer-v2.polymarket.com/`
- Used for **gasless redeem/merge** via Builder HMAC creds
- Confirms Relayer = **execution helper**, not data source

### 7.4 Validator / display (not forward-fill blockers but related)

- [Post-backfill validator triage](docs/2026-04-24-post-backfill-validator-triage.md) — fixed pagination/type filters; volume is valid comparison, not raw event counts
- Display accuracy — corrupted rows from gap-fill dupes, not ingest API choice

---

## 8. Alternative Comparison Matrix

**Legend:** ✅ Good · ⚠️ Partial · ❌ Poor

| Criterion | 1. Goldsky subgraph (current) | 2. Relayer API | 3. Data API poll | 4. Chain WS → DuckDB | 5. Goldsky Mirror | 6. Hybrid (Goldsky + Data API validation) |
|-----------|--------------------------------|----------------|------------------|----------------------|-------------------|------------------------------------------|
| **Global completeness** | ✅ | ❌ | ❌ (user/market scoped) | ✅ | ✅ | ✅ (ingest) + ⚠️ (validation sample) |
| **Latency / freshness** | ⚠️ 5 min poll | ❌ N/A | ⚠️ 30s+ per market | ✅ 2–3s | ✅ streaming | ⚠️ |
| **Historical + live continuity** | ✅ same OrderFilled semantics | ❌ | ❌ different grain | ✅ if normalized | ✅ | ✅ |
| **V1/V2 OrderFilled** | ⚠️ subgraph may lag V2 | ❌ | ⚠️ aggregated trades | ✅ decoder exists | ✅ (pipeline config) | ⚠️ |
| **Dedup `(tx_hash, log_index)`** | ⚠️ synthetic index | ❌ | ❌ different keys | ✅ real log index | ✅ | ⚠️ |
| **Rate limits at scale** | ✅ public GraphQL | ❌ 25/min submit | ⚠️ 200/10s `/trades` | ⚠️ RPC WS cost | ✅ managed | ✅ |
| **Auth / ops burden** | ✅ none | Builder/Relayer keys | ✅ none | RPC WS key | Goldsky contract | Low |
| **8GB DuckDB single server** | ✅ proven | ❌ | ❌ can’t fill table | ✅ moderate insert rate | ⚠️ needs sink tuning | ✅ |
| **Aligns with Polymarket guidance** | ✅ (subgraph) | ❌ | ⚠️ supplementary | ✅ on-chain | ✅ **recommended** | ✅ |

---

## 9. Recommended Architecture

```mermaid
flowchart TB
  subgraph historical [Historical - DONE]
    HF[HuggingFace users.parquet]
    BF[scripts/backfill 00-06]
    HF --> BF
  end

  subgraph live [Live Forward-Fill - KEEP + HARDEN]
    GS[Goldsky orderbook subgraph GraphQL]
    GL[goldskyListener.ts normalize + dedup]
    GS -->|poll 1-5 min| GL
  end

  subgraph optional [Optional Enhancements]
    CL[chainListener.ts V1+V2 WS]
    BRIDGE[v3 chain bridge module]
    CL --> BRIDGE
    VAL[Data API validator 06_validate]
  end

  subgraph store [Analytics Store]
    DUCK[(DuckDB discovery_activity_v3)]
    SNAP[discovery_feature_snapshots_v3]
    SQL[(SQLite read model)]
  end

  BF --> DUCK
  GL --> DUCK
  BRIDGE -.->|future| DUCK
  DUCK --> SNAP
  SNAP --> SQL
  VAL -.->|spot check| DUCK
  SQL --> UI[/discovery-v3/ UI]

  RELAY[Relayer API] -.->|redeem/merge ONLY| BOT[Copy-trade bot wallets]
  style RELAY fill:#fee,stroke:#c00
```

**Minimal change path (after backfill):**

1. Keep `DISCOVERY_V3=true` + discovery worker (`npm run start:discovery`).
2. Tune Goldsky poll interval (e.g. 1–2 min if stable).
3. Switch live insert to `insertNormalizedRowsBatch()` + `dedupeNormalizedRows()`.
4. Add V2-aware normalizer when subgraph exposes V2 fields (or bridge chain listener).

**Ideal long-term path:**

- Adopt **Goldsky Mirror** ([blockchain-data.md](https://docs.polymarket.com/resources/blockchain-data.md)) streaming `OrderFilled` into DuckDB/Postgres — same events, less custom polling code.
- Keep Data API validator for drift detection, not primary ingest.

---

## 10. If We Ignored This Advice (Relayer for Discovery)

**Risks:**

- Engineering weeks spent decoding calldata for **your** txs only  
- False confidence from “we integrated Polymarket’s shiny API”  
- Rate limit wall (25/min) if anyone tries polling submit/read creatively  
- Discovery UI shows **empty or bot-only** activity  

**Not recommended.** No GO integration design provided.

---

## 11. Action Items

### P0 — Ship reliable forward-fill on current stack

| # | Task | Est. | Why |
|---|------|------|-----|
| 1 | Reduce Goldsky poll interval + use batch insert in `pollGoldskyOnce` | 0.5 day | Fresher rankings, less CPU |
| 2 | V2 compatibility spike: compare subgraph vs chain WS for post-cutover fills | 1–2 days | Highest correctness risk |
| 3 | Enforce `dedupeNormalizedRows()` on every live batch | 0.5 day | Prevent display-accuracy recurrence |
| 4 | Run 24–48h soak (`npm run verify:soak`) after backfill cutover | ops | Already documented |

### P1 — Close architecture gaps

| # | Task | Est. | Why |
|---|------|------|-----|
| 5 | **chainListener → DuckDB v3 bridge** (reuse V2 decoder, map to `NormalizedV3Row`) | 3–5 days | Real log indices + V2 + low latency |
| 6 | Token→condition enrichment job for Goldsky rows missing `condition_id` | 2 days | Better market attribution in snapshots |
| 7 | Document “do not use Relayer for discovery” in ops runbook | 0.5 day | Prevent repeat confusion |

### P2 — Strategic

| # | Task | Est. | Why |
|---|------|------|-----|
| 8 | Goldsky Mirror POC → DuckDB sink | 1–2 weeks | Official scalable path |
| 9 | Evaluate subgraph freshness vs Mirror for V2 | 2 days | Informs build vs buy |

---

## 12. Appendix: Read-Path Endpoint Details & Rate Limits

### A. Data API ([get-activity.json](https://docs.polymarket.com/developers/open-api/get-activity.json), [get-trades.json](https://docs.polymarket.com/developers/open-api/get-trades.json))

| Endpoint | Key params | Limits (from [Rate Limits](https://docs.polymarket.com/api-reference/rate-limits.md)) |
|----------|------------|--------|
| `GET /activity` | `user` (required), `limit` max 500, `offset` max 10000, `type` filter | General 1000/10s |
| `GET /trades` | `user` or `market`, `limit` max 10000, `takerOnly` | **200 req / 10s** |

Activity includes TRADE, REDEEM, SPLIT, MERGE — not 1:1 with OrderFilled rows.

### B. WebSocket ([overview](https://docs.polymarket.com/market-data/websocket/overview.md))

| Channel | URL | Data |
|---------|-----|------|
| Market | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | Book, price changes, **last trade** per subscribed asset |
| User | [user-channel](https://docs.polymarket.com/market-data/websocket/user-channel.md) | Authenticated fills/orders |

Market channel `last_trade_price` events are per-market subscription — not a global firehose.

### C. Relayer (full)

See Section 3. Base: `https://relayer-v2.polymarket.com` ([OpenAPI](https://docs.polymarket.com/api-spec/relayer-openapi.yaml)).

### D. Research artifacts

Raw doc fetches (curl, 2026-05-31): `.firecrawl/discovery-relayer-research/` (gitignored).

---

## 13. Success Criteria Check

| Criterion | Met? |
|-----------|------|
| Owner knows whether to pursue Relayer for discovery | ✅ **No** |
| Owner knows what to use instead | ✅ **Goldsky (current) + hardening; Mirror long-term** |
| Owner knows next engineering work | ✅ **P0–P2 action items above** |

---

*This report is research-only. No code was changed except this document.*
