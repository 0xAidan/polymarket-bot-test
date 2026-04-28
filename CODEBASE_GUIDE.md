# Polymarket Bot: Zero-to-Mastery Guide

**Goal:** This document will take you from "I know TypeScript" to "I fully understand how this algorithmic trading bot works," including the underlying crypto/financial technologies.

---

## Polymarket CLOB V2 Migration (April 28, 2026)

Polymarket switched its CLOB API and on-chain Exchange contracts to V2 at ~11:00 UTC on **2026-04-28**. V1 stops accepting orders. There is **no backwards compatibility**: this codebase no longer talks to V1 at all. Key changes (read this before touching the trading path):

### What changed at the protocol level

- **SDK package**: `@polymarket/clob-client` (V1) → **`@polymarket/clob-client-v2`**.
- **Constructor**: positional args → **options object** (`{ host, chain, signer, creds, signatureType, funderAddress, builderConfig }`). Note: `chainId` was renamed to `chain`. `tickSizeTtlMs` is gone.
- **Builder auth**: HMAC creds (`POLYMARKET_BUILDER_API_KEY/SECRET/PASSPHRASE`) → **single `builderCode` string** read from `POLYMARKET_BUILDER_CODE`. The V2 backend ignores `POLY_BUILDER_*` HMAC headers entirely. Missing builderCode is **non-fatal in V2** — orders place fine, you just lose attribution.
- **Order body**: `feeRateBps`, `nonce`, and `taker` are removed. `builderCode` is added. Market BUY orders may include `userUSDCBalance` for fee-aware fill calc.
- **Collateral token**: USDC.e (`0x2791…84174`) → **pUSD** (`0xC011…2DFB`). Same 6 decimals. CTF redeem/merge calls now pass pUSD as `collateralToken`.
- **Exchange contracts**: New addresses on Polygon — `0xE111180000d2663C0091e4f400237545B87B996B` (CTF) and `0xe2222d279d744050d28e00520010520000310F59` (NegRisk).

### What this PR did (file-by-file summary)

- `package.json` — replaced `@polymarket/clob-client` + `@polymarket/builder-signing-sdk` with `@polymarket/clob-client-v2@1.0.2` (bumped from 1.0.0 to pick up post-GA hardening patches). Kept `@polymarket/builder-relayer-client` (still used for gasless redeem/merge).
- `src/types/clob-client.d.ts` — rewrote shim to declare `@polymarket/clob-client-v2`. Deleted `src/types/builder-signing-sdk.d.ts` (we no longer import it directly; the relayer brings its own types transitively).
- `src/clobClient.ts` — full rewrite of constructor to use the V2 options object. Replaced HMAC builder shape with `{ builderCode }`. Added `userUSDCBalance` plumbing on `createAndPostOrder`. Downgraded the missing-builder error to a warn.
- `src/clobClientFactory.ts` — dropped the HMAC builder-creds gate. Reads `POLYMARKET_BUILDER_CODE` (or per-tenant `TradingWallet.polymarketBuilderCode`), warns if missing instead of throwing. After init, calls `ensurePusdReady()` to silently auto-wrap USDC.e → pUSD on the EOA. Failures there are non-fatal.
- `src/pusdWrapper.ts` *(new)* — idempotent helper that approves and wraps any USDC.e ≥ $1 sitting on the EOA into pUSD via the CollateralOnramp (`0x9307…B8ee`). Deduped per-signer per-process. Never throws.
- `src/discovery/types.ts` — added `_V1` and `_V2` suffixed addresses, `ALL_EXCHANGE_ADDRESSES` list. The unsuffixed `CTF_EXCHANGE_ADDRESS` / `NEG_RISK_CTF_EXCHANGE_ADDRESS` now alias V2. Also added `ORDER_FILLED_TOPIC0_V1` / `ORDER_FILLED_TOPIC0_V2` plus separate `ORDER_FILLED_DATA_TYPES_V1` / `ORDER_FILLED_DATA_TYPES_V2` and an `OrderFilledEvent.version: 'v1' \| 'v2'` discriminator — V2 emits a structurally different event (`(uint8 side, uint256 tokenId, …, bytes32 builder, bytes32 metadata)`) under topic0 `0xd543adfd…`, V1 emits the original 5-uint256 form under `0xd0a08e8c…`.
- `src/discovery/chainListener.ts` — eth_subscribe now uses a nested-array OR filter on **both V1 and V2** topic0s across all four exchange contracts. The decoder dispatches on `log.topics[0]` and emits a normalized `DiscoveredTrade` regardless of source version. The pure decoder is exported as `parseOrderFilledLog` for unit testing — see `tests/orderFilledDecoder.test.ts`.
- `src/positionLifecycle.ts` — CTF `redeemPositions` / `mergePositions` collateralToken is now pUSD. Relayer client still uses HMAC creds (per docs the relayer auth path is unchanged).
- `src/balanceTracker.ts` — added a third on-chain balance source (pUSD) alongside native + bridged USDC. Total balance = native + bridged + pUSD.
- `src/polymarketApi.ts` — deleted `generateBuilderSignature` and `getBuilderAuthHeaders`. Stripped the HMAC validation from `placeOrder`. The `placeOrder` path is fallback-only; primary order placement goes through the V2 SDK.
- `src/tradeExecutor.ts` — `Side` import switched to V2; for BUY orders, now opportunistically forwards the wallet's pUSD balance as `userUSDCBalance` for fee-aware fill calc.
- `src/config.ts`, `ENV_EXAMPLE.txt` — added `POLYMARKET_BUILDER_CODE`. Old HMAC env vars retained — they're still used by the relayer.
- `src/types.ts` — `TradingWallet.polymarketBuilderCode?: string` for per-tenant override.

### New env var

```
POLYMARKET_BUILDER_CODE=your_builder_code_from_polymarket_settings_here
```

Get it from [polymarket.com/settings → Builder Profile](https://polymarket.com/settings). Optional (orders work without it) but strongly recommended.

### pUSD auto-wrap on first wallet init

`getClobClientForTradingWallet` in `clobClientFactory.ts` calls `ensurePusdReady(signer, funderAddress, log)` after the SDK initializes. That helper approves the CollateralOnramp and wraps any USDC.e ≥ $1 sitting on the EOA into pUSD. It's idempotent (per-signer Set), runs at most once per process per wallet, and **never throws** — failures are logged at warn and ignored, since users may have pUSD via another path.

### Old V1 references retained

`src/discovery/types.ts` still exports `CTF_EXCHANGE_ADDRESS_V1` and `NEG_RISK_CTF_EXCHANGE_ADDRESS_V1` — these are kept solely so we can backfill historical OrderFilled events from the V1 contracts during the cutover hour. The unsuffixed `CTF_EXCHANGE_ADDRESS` / `NEG_RISK_CTF_EXCHANGE_ADDRESS` aliases now point at V2.

### Dos and don'ts going forward

- ❌ **Do not** import `@polymarket/clob-client` (V1) anywhere — it's been removed from `package.json`.
- ❌ **Do not** pass `feeRateBps`, `nonce`, or `taker` on order bodies — V2 rejects them.
- ❌ **Do not** use `POLY_BUILDER_*` HMAC headers for order placement — V2 ignores them. They're still valid for the gasless relayer (redeem/merge).
- ✅ **Do** auto-wrap USDC.e → pUSD on first init (already wired up in `clobClientFactory.ts`).
- ✅ **Do** include `builderCode` on every order body when set, so attribution flows.
- ✅ **Do** keep both V1 and V2 exchange addresses in the chain listener filter for at least the cutover week.

### Cutover-day operations (Apr 28, 2026)

- **Maintenance window**: ~11:00 UTC → ~12:00 UTC (about 1 hour). Trading paused, all open order books cleared by Polymarket.
- **Pre-cutover hygiene**: cancel all open GTC orders before **07:00 UTC** to avoid mid-window cancel artifacts (per Polymarket's market-maker guidance). Polymarket also auto-clears the books at 11:00 UTC — so this is belt-and-suspenders, not strictly required.
- **Open positions carry over**: outstanding outcome tokens resolve normally on the V2 contracts. No special handling needed in `positionLifecycle.ts` for pre-cutover positions — redeem still works (just point `collateralToken` at pUSD, which this PR already does).
- **Deposit addresses are unchanged**: the Bridge / onramp deposit addresses keep working. No code changes needed for any deposit flow.
- **Hot-swap behavior**: the V2 SDK polls a version endpoint and refreshes itself when V2 goes live. As long as we're on `clob-client-v2`, no manual restart is required during the maintenance window.

### Fees in V2 (read before touching PnL code)

- Fees are **charged in USDC at match time** (not embedded in the signed order, not paid in shares).
- Fees appear in trade history per fill and on `last_trade_price` WS events as `fee_rate_bps`.
- **Nonce-related order failures are explicitly eliminated** in V2 — V2 uses millisecond timestamps for per-address uniqueness instead of a nonce counter. There is **no remaining nonce-tracking logic** in `tradeExecutor.ts`, `polymarketApi.ts`, or `clobClient.ts`; the subagent verified this during migration.
- **Follow-up audit needed (post-merge, separate PR)**: the following files compute cost-basis or PnL and may have V1-era assumptions about fees being deducted in shares rather than USDC. Audit and adjust before relying on dashboard PnL post-cutover:
  - `src/crossPlatformPnl.ts`
  - `src/performanceTracker.ts`
  - `src/tradeExecutionDiagnostics.ts`

  This is **not blocking the cutover** — trades will execute correctly. Only the reported PnL/cost-basis numbers might be slightly off until reviewed.

---

## Part 1: The Core Technologies (Prerequisites)

Before looking at the code, you need to understand the tools we are using.

### 1. What is Polymarket? (Under the Hood)
Polymarket is a **Prediction Market** built on the Polygon blockchain.
- **Binary Outcomes:** Every market typically has "YES" and "NO" tokens.
- **Pricing:** Prices range from $0.00 to $1.00. Buying "YES" at $0.60 means the market believes there is a 60% chance the event will happen.
- **Settlement:** If "YES" wins, the token becomes worth $1.00 (USDC). If it loses, it becomes $0.00.
- **CTF (Conditional Token Framework):** This is the smart contract standard used. It’s not a simple ERC-20 token; it's a specialized standard for splitting collateral into outcomes.

### 2. The APIs: CLOB vs. Data vs. Gamma
Polymarket isn't just one interaction point. We use three different APIs:

1.  **CLOB (Central Limit Order Book) API** (`clob.polymarket.com`):
    *   **What it is:** The actual exchange engine. This is where buyers match with sellers. It is fast, off-chain matching with on-chain settlement.
    *   **Our usage:** Placing orders, cancelling orders, checking our user balance.
    *   **Key Tech:** Requires **Cryptographic Signing** (authenticating with your private key).

2.  **Data API** (`data-api.polymarket.com`):
    *   **What it is:** A readable database of *past* events.
    *   **Our usage:** Seeing what other people (whales) traded, checking their current positions.
    *   **Key Tech:** Standard HTTP GET requests (REST).

3.  **Gamma API** (`gamma-api.polymarket.com`):
    *   **What it is:** Market metadata.
    *   **Our usage:** Translating a cryptic `tokenID` ("38472...") into a human name ("Will Trump win?").

### 3. Ethers.js (The Crypto Layer)
`ethers.js` is a library for interacting with the Ethereum/Polygon blockchain.
*   **Wallet:** An object that holds your Private Key. It can "Sign" messages.
*   **Signing:** The CLOB API doesn't use passwords. To prove you are you, you "sign" a message with your private key. The API checks the math to verify it came from you without ever seeing your key.
*   **In this bot:** We use `ethers` to create a `Wallet` from your private key, which the `CLOB Client` then uses to sign every trade you make.

### 4. WebSockets vs. Polling
*   **Polling (HTTP):** "Are we there yet? No. Are we there yet? No."
    *   We use this for **Wallet Monitor**. We ask the Data API every 10 seconds: "Did User X make a trade?"
*   **WebSockets (WS):** Opening a permanent phone line. "Call me if anything happens."
    *   We use this for **Order Updates**. The CLOB calls us instantly when *our* trade fills.
    *   *Note:* We cannot use WebSockets to watch *other* people's trades easily because Polymarket doesn't broadcast them publicly in real-time for free; hence, we Poll.

---

## Part 2: Architecture High-Level

The bot is a loop that connects "The Eyes" (Monitoring) to "The Hands" (Execution).

```mermaid
graph TD
    A[Target Wallet (Whale)] -->|Polls Positions| B(WalletMonitor)
    B -->|Detects Charge| C{CopyTrader}
    C -->|Calculates Trade| D(TradeExecutor)
    D -->|Signs & Sends| E[Polymarket CLOB]
    E -->|Confirms| F(Usage/Perf Check)
```

1.  **WalletMonitor:** Watches the target wallet.
2.  **CopyTrader:** The brain. Decides "Is this safe? Is it a dupe? How much do we buy?"
3.  **TradeExecutor:** Talks to the exchange to make it happen.

---

## Part 3: Codebase Mastery (File by File)

We will walk through the `src/` folder logically, not alphabetically.

### 1. The Entry Point: `index.ts` & `config.ts`
*   **`config.ts`**: Loads your `.env` file (private keys, API keys). It’s the settings menu.
*   **`index.ts`**: The "Power Button".
    *   It creates the `CopyTrader` instance.
    *   It starts the Express web server (for the dashboard).
    *   It keeps the process running.

### 2. The Eyes: `walletMonitor.ts`
This is where the magic starts. We need to know when our target trades.

*   **How it works:** It runs a loop (e.g., every 10s).
*   **Technique 1: Position Diffing.**
    *   Generic REST API Call: `GET /positions?user=0xTarget...`
    *   It saves the *previous* list of positions.
    *   It gets the *new* list.
    *   **Math:** `New Size - Old Size`. If > 0, they bought. If < 0, they sold.
*   **Technique 2: Activity Log.**
    *   API Call: `GET /activity?user=0xTarget...`
    *   This is a list of their recent fills.
    *   We check if there is a timestamp newer than the last time we checked.

### 3. The Brain: `copyTrader.ts`
This is the Controller. It receives signals from `walletMonitor` and decides what to do.

*   **Deduplication:** The biggest risk is buying the same thing 5 times because the polling cycle detected it 5 times. We use `processedTrades` (a Set of strings) to remember IDs of trades we've already done.
*   **Filtering:**
    *   *Value Filter:* "Don't copy trades worth less than $10."
    *   *Side Filter:* "Only copy BUYs, ignore SELLs."
*   **Sizing:** "The Whale bought $50,000. I only have $500." The bot calculates your order size based on your constants (e.g., "Always buy $10 worth").

### 4. The Hands: `tradeExecutor.ts` & `clobClient.ts`
This is the hardest part technically because of Authentication.

*   **`clobClient.ts`**: This wraps `@polymarket/clob-client-v2`.
    *   **L1 vs L2 Headers:** Polymarket Cloudflare blocks simple scripts. We use "L2 Headers" (Level 2). This involves using a standard `eoa` (Externally Owned Account) key to derive specific API credentials.
    *   **The Proxy Worker:** If running on a cloud (like Railway), our IP gets blocked. The code supports sending requests through a `cloudflare-worker` (a tiny script in the repo) to mask our IP.
*   **`tradeExecutor.ts`**:
    *   **Tick Size:** You can't buy at $0.5011112. You must round to the "tick" (e.g., $0.01 or $0.001). This file handles that math.
    *   **Slippage:** If price is $0.50, we might bid $0.51 to ensure we get it immediately (`IOC` - Immediate or Cancel).

### 5. Data Persistence: `storage.ts`
We don't use a SQL database (like Postgres) to keep it simple. We use **JSON files** in the `/data` folder.
*   `active_wallets.json`: Who are we tracking?
*   `history.json`: What have we bought?

---

## Part 4: Advanced Concepts Deep Dive

### The "Proxy Wallet" Concept
When you use Polymarket, you don't hold the tokens in your main wallet (EOA). Polymarket creates a Gnosis Safe (a smart contract wallet) for you. exact trades happens *proxy-to-proxy*.
*   **Why this matters:** When checking balances, `ethers.getBalance(myAddress)` returns 0 USDC. We must check the **Proxy's** balance or use the CLOB API helper `getBalanceAllowance()`.

### The Cloudflare Problem
Polymarket aggressively protects their API from bots.
*   **Builder API:** We use a special "Builder API Key". This is a white-gated key you get from Polymarket.
*   **Header Signing:** We sign the timestamp and URL path.
*   If we get a `403 Forbidden`, it usually means our "Builder Signature" is wrong or our IP is dirty.

### Handling "Nonce"
Every transaction on Ethereum needs a number (Nonce: 0, 1, 2...).
*   The CLOB is off-chain, so we don't pay gas for every order.
*   But we still sign messages. These messages have timestamps/nonces. If your system clock is wrong, the order fails.

---

## Part 5: The Life of a Trade (Walkthrough)

1.  **00:00:00** - `WalletMonitor` wakes up.
2.  **00:00:01** - Fetches "Whale's" positions. Finds entry: `{"outcome": "YES", "size": 1000}`.
3.  **00:00:01** - Logic: Last time we checked, size was 0. **+1000 Delta Detected.**
4.  **00:00:02** - `copyTrader` gets event.
    *   Checks `processedTrades`. New? Yes.
    *   Checks `isBuy`. Yes.
    *   Checks `Config`. Trade Size = $20.
5.  **00:00:03** - `tradeExecutor` calculates price.
    *   Current Market Price: $0.60.
    *   Slippage (2%): Limit Price = $0.612.
    *   Tick Rounding: Final Price = $0.61.
6.  **00:00:04** - `clobClient` creates order payload.
    *   Signs payload with Private Key.
    *   Attaches Builder API Key headers.
    *   POST `clob.polymarket.com/order`
7.  **00:00:05** - API responds: `{"orderID": "xyz", "status": "MATCHED"}`.
8.  **00:00:06** - Trade recorded in `storage.ts`. Dashboard updates.

---

## How to Read This Codebase
Start in this order:
1.  **`src/types.ts`**: See what a "Trade" looks like.
2.  **`src/config.ts`**: See what settings exist.
3.  **`src/walletMonitor.ts`**: See how we fetch data.
4.  **`src/clobClient.ts`**: The "hard" technical part interacting with the exchange.

---

## Part 12: Discovery Engine v3 (Tiered Wallet Discovery)

Discovery v3 is an additive rebuild that introduces analytical wallet tiering
(alpha / whale / specialist) with point-in-time-pure historical scoring. All v3
code lives under `src/discovery/v3/`, `scripts/backfill/`, and
`public/discovery-v3/` and is gated on `DISCOVERY_V3=true`.

### Key components
- `src/discovery/v3/featureFlag.ts` — `isDiscoveryV3Enabled()`, `getDuckDBPath()`
- `src/discovery/v3/duckdbClient.ts` — CJS-interop DuckDB wrapper (ESM-friendly)
- `src/discovery/v3/schema.ts`, `duckdbSchema.ts` — migrations
- `src/discovery/v3/eligibility.ts` — hard gates (span, markets, trades)
- `src/discovery/v3/backfillQueries.ts` — ingest + snapshot SQL
- `src/discovery/v3/tierScoring.ts` — z-score blends + per-tier percentile rank
- `src/discovery/v3/goldskyListener.ts` — live OrderFilled subscription
- `src/discovery/v3/refreshWorker.ts` — hourly re-scoring loop
- `src/discovery/v3/workerIntegration.ts` — bootstrap wired into `discoveryWorker.ts`
- `src/api/discoveryRoutesV3.ts` — 9 endpoints under `/api/discovery/v3/`
- `public/discovery-v3/` — standalone three-tier UI

### Running locally
```bash
export DISCOVERY_V3=true
npm run build
tsx scripts/backfill/01_init_duckdb.ts
tsx scripts/backfill/04_emit_snapshots.ts
tsx scripts/backfill/05_score_and_publish.ts
npm start
# Browse http://localhost:3000/discovery-v3/
```

See `docs/discovery-v3-operations.md` for the full runbook.

### Backfill: `02_load_events` ingest paths (read before changing!)

`scripts/backfill/02_load_events.ts` supports three modes via `--mode`:

- `legacy`  — single INSERT with ROW_NUMBER. OOMs on the real 927M-row
  `users.parquet`. Kept only for tiny test fixtures.
- `chunked` — N buckets of ROW_NUMBER ingest. Each bucket still materializes
  its full sort state; not safe on the production dataset.
- `parquet-direct` — loops 64 bucket sorts inside ONE node process and
  inserts each into `discovery_activity_v3`. Failed in production after 3
  successful buckets: DuckDB's buffer manager accumulated enough pinned
  pages across commits that bucket 4's commit hit `failed to pin block
  (7.4 GiB/7.4 GiB used)`. Deprecated in favour of the per-process flow.
- **Current production (FINAL rev2, 2026-04-22)**: **`02a_sort_bucket.ts`
  + `02c_merge_one_bucket.ts` + `02d_dedup_and_index.ts`** orchestrated by
  `scripts/backfill/finish_backfill.sh`. See
  `2026-04-22-discovery-backfill-final-fix-rev2.md` for the full write-up
  (supersedes the `final-fix.md` addendum).
    1. For each of `DUCKDB_SORT_BUCKETS` (default 64) hash buckets on
       `transaction_hash`, the launcher calls `02a_sort_bucket.ts` in a
       FRESH `tsx` process. Each process opens an in-memory DuckDB, sorts
       one bucket directly from `users.parquet` to
       `$SORTED_PARQUET_DIR/sorted_events_bucket_NNNN.parquet`, then exits.
       Buffer manager starts empty every bucket, so pin pressure can't
       accumulate.
    2. `02a` is idempotent: it skips buckets whose output parquet already
       exists (pass `--force` to overwrite). If a bucket fails, re-running
       the launcher resumes from that bucket.
    3. **Phase B1** — `finish_backfill.sh` invokes
       `runV3DuckDBMigrationsBackfillNoIndex` once (creates the
       `discovery_activity_v3` table with **NO indexes**), then loops over
       every bucket parquet running `02c_merge_one_bucket.ts` in a fresh
       `tsx` process. Each invocation does
       `INSERT INTO discovery_activity_v3 WITH raw AS (SELECT … FROM
       read_parquet(…)) SELECT … arg_min(…, ts_unix) … FROM raw GROUP BY
       tx_hash, log_index` (`buildSortedParquetToActivityDedupedSql`).
       Dedup happens **inside the SELECT against the parquet only**, so
       the SELECT side does an aggregate while the INSERT side writes into
       an index-free table — neither of the two DuckDB pipelines that
       combine dangerously at scale is triggered. Checkpoints, then
       deletes the bucket parquet.
    4. **Phase B2** — after all 64 buckets are loaded,
       `02d_dedup_and_index.ts` runs a defensive
       `SELECT ... GROUP BY tx_hash, log_index HAVING COUNT(*) > 1` scan
       (must return zero; if not, refuses to proceed), then builds the
       UNIQUE + auxiliary indexes on the already-deduped table via
       `buildActivityIndexSqlList`. No global CTAS dedup — the earlier rev
       tried that and exceeded the 75 GB temp-directory budget at 956M
       pre-dedup rows.
    5. **Why bucket-local dedup is correct.** `02a` bucketizes on
       `abs(hash(transaction_hash)) % N`, so every duplicate of a given
       `(tx_hash, log_index)` key lands in exactly ONE bucket. Per-bucket
       dedup is therefore mathematically equivalent to global dedup — the
       same invariant that justified the legacy `02b` per-bucket LAG
       dedup. Tested by the `bucketed path = single-sort path` assertion
       in `tests/v3-backfill-mapping.test.ts`.
    6. **Why we no longer do a global CTAS.** At 956M rows + 75 GB free
       temp, `CREATE TABLE _dedup AS SELECT … GROUP BY tx_hash, log_index
       FROM discovery_activity_v3` hit
       `failed to offload data block … max_temp_directory_size`. Per-bucket
       dedup bounds spill to ~14 M rows/bucket (a few GB of GROUP BY
       state) and fits inside the memory+temp envelope on the 8 GB box.
    7. **History of failed intermediate attempts.**
       - `02b_merge_buckets.ts` (legacy) INSERT with GROUP BY into an
         indexed table → DuckDB raised spurious Duplicate key errors
         (duckdb#11102 / #16520) on keys appearing exactly once.
       - First `final-fix`: raw insert per bucket + global CTAS dedup at
         the end → CTAS exceeded temp-directory budget at 956 M rows.
       - **Current**: dedup per bucket during insert into an index-less
         table, then build indexes on already-deduped data. Sidesteps
         both failure modes.
    8. Correctness unit-tested in `tests/v3-backfill-mapping.test.ts`
       (`runNoIndexLoadAndDedup` helper mirrors the production flow);
       scale-tested at 2M rows in
       `tests/v3-backfill-scale-integration.ts` (manual run).
    9. **`02b_merge_buckets.ts` and `buildSortedParquetToActivitySql` are
       DEPRECATED**; likewise `buildSortedParquetToActivityRawSql` and
       `buildActivityDedupCtasSql` + `ACTIVITY_DEDUP_SWAP_SQL` (the
       global-CTAS path). They compile for reference but must not be used
       for new backfill runs.
   10. **Live listener is unaffected.** `goldskyListener.ts` still calls
       `runV3DuckDBMigrations` which keeps the UNIQUE INDEX from day 1 —
       live writes are small and do not trigger the bulk-insert bug.
       **Never** point the live path at `…NoIndex`.
- `staging` — bucketed external sort with intermediate staging table:
    1. Phase A: stream parquet → `staging_events_v3` (bounded RAM).
    2. Phase B: for each of `DUCKDB_SORT_BUCKETS` (default 64) hash buckets on
       `transaction_hash`, `COPY (ORDER BY tx_hash, log_index, timestamp)` to
       a per-bucket parquet, then `INSERT` with LAG-dedup, then `rm` the
       bucket parquet.
    3. Drop staging + CHECKPOINT.

  Why bucketed: DuckDB's `max_temp_directory_size` defaults to 90% of FREE
  disk at spill time. With `users.parquet` (48 GB) + `staging_events_v3` (41
  GB) sharing the 93 GB volume, free disk at sort time is ~8 GB, so a single
  sort of 900M rows (needs ~100 GB spill) OOMs instantly. `abs(hash(tx_hash))
  % N` keeps all duplicates of a `(tx_hash, log_index)` key in the same
  bucket, so per-bucket dedup is provably equivalent to global dedup
  (tested in `tests/v3-backfill-mapping.test.ts`).

### Backfill: required env vars (`duckdbClient.ts`)

- `DUCKDB_MEMORY_LIMIT_GB` — cap DuckDB RAM (e.g. 8 on a 16 GB box).
- `DUCKDB_THREADS`         — cap parallelism (2 is stable).
- `DUCKDB_TEMP_DIR`        — spill directory; must be on a volume with
  plenty of free space.
- `DUCKDB_MAX_TEMP_DIR_GB`  — **must be set explicitly** for the backfill.
  Without it, DuckDB computes `max_temp_directory_size` = 90% of free disk
  at spill time, which is tiny when the volume is crowded.
- `DUCKDB_SORT_BUCKETS`    — bucketed-sort pass count for step 02 staging
  mode. Default 64. Raise if a bucket still OOMs.
- `SORTED_PARQUET_DIR`     — where step 02 writes bucket parquets. Defaults
  to `DUCKDB_TEMP_DIR`.

### Backfill: pitfalls that have bitten us

- **Never** do `COPY (SELECT ... ORDER BY ...) TO parquet` on the whole
  `staging_events_v3` table on this hardware. The sort state does not fit.
- **Never** rely on DuckDB's default `max_temp_directory_size`. Set
  `DUCKDB_MAX_TEMP_DIR_GB` explicitly.
- **Never** assume an empty `duckdb_tmp/` means spill isn't the problem —
  DuckDB deletes partial spill files when a query aborts.
- ROW_NUMBER OVER (PARTITION BY ...) across the full parquet materializes
  the whole sort state in temp and does not bucket cleanly. Use the
  bucketed external sort (`buildStagingSortBucketToParquetSql`) instead.
- **Never** combine `INSERT … GROUP BY` with a UNIQUE INDEX on the target
  at Hetzner scale. DuckDB's aggregate-insert + unique-index pipeline
  raises spurious Duplicate key faults (duckdb#11102 / #16520) on keys
  that appear exactly once in the source. Always load into an index-free
  table first (either raw or with inline GROUP BY), then create the
  UNIQUE INDEX afterward on already-deduped data.
- **Never** do a global `CREATE TABLE _dedup AS SELECT … GROUP BY tx_hash,
  log_index FROM discovery_activity_v3` at production scale. 956M rows
  blows the 75 GB temp-directory budget. Dedup per bucket during load
  (`buildSortedParquetToActivityDedupedSql` in
  `02c_merge_one_bucket.ts`). This is correct because `02a`'s hash
  bucketing keeps every duplicate key in a single bucket.
- **Never** create ART indexes on `discovery_activity_v3` during backfill
  on the Hetzner 8 GB box. DuckDB 1.4.x `CREATE INDEX` / `CREATE UNIQUE
  INDEX` require the entire index to fit in memory (duckdb.org docs,
  plus duckdb/duckdb #15420, #16229 — unresolved). For ~800M activity
  rows this is ~100GB of RAM; non-unique ART uses the same code path and
  does **not** help. See rev3 below.

### Backfill fix rev3 (2026-04-23) — skip activity indexes

1. `src/discovery/v3/duckdbSchema.ts` keeps `V3_ACTIVITY_INDEX_DDL` (used by
   live prod `goldskyListener.insertNormalizedRows`, which relies on the
   UNIQUE constraint to swallow overlap duplicates), but exports
   `runV3DuckDBMigrationsBackfillNoIndex` for backfill.
2. All backfill scripts (`03_load_markets`, `04_emit_snapshots`,
   `05_score_and_publish`) use `runV3DuckDBMigrationsBackfillNoIndex`, so
   opening the backfill DuckDB never triggers index creation on the
   populated activity table.
3. `02d_dedup_and_index.ts` is now a verify-and-CHECKPOINT step only —
   no index build. Uniqueness is proven by 02c's bucket-local GROUP BY
   and verified defensively by the 02d dupe scan.
4. Downstream 04 snapshot SQL is a full-table scan + hash join and does
   not need activity-table indexes; 05/06 only touch
   `discovery_feature_snapshots_v3` (native PRIMARY KEY).
5. The `v3-schema.test.ts` suite pins BOTH invariants: the live DDL still
   publishes 3 activity indexes (prod), and the no-index migration omits
   them (backfill).

Runbook:
```
DUCKDB_PATH=/mnt/HC_Volume_105468668/discovery_v3.duckdb \
DUCKDB_MEMORY_LIMIT_GB=6 DUCKDB_THREADS=2 \
DUCKDB_TEMP_DIR=/mnt/HC_Volume_105468668/duckdb_tmp \
DUCKDB_MAX_TEMP_DIR_GB=60 \
SORTED_PARQUET_DIR=/mnt/HC_Volume_105468668/bucket_parquets \
bash scripts/backfill/finish_backfill.sh
```

### Backfill fix rev4 (2026-04-23) — snapshot SQL rewrite for 04 OOM

**Problem:** After rev3 landed and 02c/02d/03 completed successfully on the
real 912M-row activity table, `04_emit_snapshots.ts` OOM'd **twice** with
two distinct signatures:

1. First run: temp-directory hit 55.8 GiB / 55.8 GiB, classic spill bound.
2. Second run (with `preserve_insertion_order=false`, bigger temp budget,
   no trailing ORDER BY): `failed to allocate data of size 16.0 GiB (0
   bytes/5.5 GiB used)` — a **single contiguous 16 GiB allocation**, not
   cumulative temp.

Root cause: the original `buildSnapshotEmitSql` used a self-join on
`discovery_activity_v3` with an inequality predicate
(`a.ts_unix < b.day_end_ts`) to compute cumulative features. On 912M
rows DuckDB plans this as a hash-join-plus-filter needing a contiguous
multibillion-row build side; on an 8 GB Hetzner box this cannot fit in
memory regardless of temp-directory budget. See duckdb#13325 and the
DuckDB query-planner docs on inequality joins.

**Fix:** Rewrite `buildSnapshotEmitSql` to a two-stage aggregate that
eliminates the inequality join entirely:

```
WITH daily_activity AS (        -- GROUP BY (wallet, day) on activity
  SELECT proxy_wallet, day,
         COUNT(*) trade_count_day,
         SUM(usd_notional) volume_day,
         APPROX_COUNT_DISTINCT(market_id) distinct_markets_day,
         MIN/MAX(ts_unix) …
  FROM discovery_activity_v3 GROUP BY wallet, day
),
daily_closed AS (               -- GROUP BY (wallet, end_date) on equality JOIN
  SELECT a.proxy_wallet, CAST(m.end_date AS DATE) day,
         APPROX_COUNT_DISTINCT(a.market_id) closed_positions_day,
         SUM(a.usd_notional*(a.price_yes-0.5)) realized_pnl_day
  FROM discovery_activity_v3 a JOIN markets_v3 m USING(market_id)
  WHERE m.end_date IS NOT NULL
    AND day(a) <= day(m.end_date)
  GROUP BY a.proxy_wallet, CAST(m.end_date AS DATE)
),
merged AS (FULL OUTER JOIN daily_activity + daily_closed ON wallet, day)
SELECT … FROM (
  SELECT wallet, day,
         SUM(trade_count_day) OVER w AS trade_count,
         SUM(volume_day)      OVER w AS volume_total,
         … cumulative window aggregates …
  FROM merged
  WINDOW w AS (PARTITION BY wallet ORDER BY day
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
) WHERE trade_count > 0
```

**Key properties preserved:**
- Invariant-4 (Snapshot Purity): each snapshot on day D still reflects
  all activity ≤ end_of_day_D. Covered by `v3-snapshot-purity.test.ts`
  which runs `buildSnapshotEmitSql()` against real in-memory fixtures.
- `trade_count`, `volume_total`, `realized_pnl`, `first_active_ts`,
  `last_active_ts`: exact (pure SUM/MIN/MAX windows).
- `distinct_markets`, `closed_positions`: `APPROX_COUNT_DISTINCT`
  (HyperLogLog, ≤1.6% relative error). Acceptable because
  `tierScoring.ts` does not threshold on exact counts — it uses these
  only as ratio and magnitude inputs.

**Runtime footprint:**
- Build side is `daily_activity` and `daily_closed` — both keyed by
  (wallet, day) so row counts are bounded by
  `uniqueWallets * avgActiveDays`, orders of magnitude smaller than 912M.
- No inequality join, no contiguous 16 GiB build; all memory-bound steps
  are streaming GROUP BY / window-over-partition which DuckDB spills
  cleanly.

**Syntax notes (DuckDB 1.4):**
- Standalone `WINDOW w AS (...)` clauses are NOT supported inside
  `INSERT … SELECT` in DuckDB 1.4.x — the OVER clauses must be inlined
  per column. The rewritten query does this.
- `QUALIFY` is replaced by wrapping in an outer subquery with `WHERE
  trade_count > 0` so the filter applies after the window aggregates
  compute.

**Operator note:** After rev4 lands, only `04_emit_snapshots.ts` needs
to be re-run on the Hetzner box. 02c/02d/03 data is already committed
in `discovery_v3.duckdb` (83 GB, 912,522,639 rows, 734,790 markets).
Follow with 05 and 06. Env flags unchanged from rev3.

### Backfill fix rev5 (2026-04-23) — scores table composite PK

**Problem:** After rev4, 04 succeeded (wrote 1,380 snapshots in 344s)
but 05 failed with `SqliteError: UNIQUE constraint failed:
discovery_wallet_scores_v3.proxy_wallet`.

Root cause: `src/discovery/v3/schema.ts` declared
`proxy_wallet TEXT PRIMARY KEY`, but `scoreTiers` in
`src/discovery/v3/tierScoring.ts` intentionally emits **three rows per
eligible wallet** (one per tier: alpha, whale, specialist). The API
(`/:tier`, `/wallet/:address`) reads multiple rows per wallet, so the
correct PK is **(proxy_wallet, tier)**. The wallet-only PK was a
latent bug that only tripped once 05 ran on real data.

**Fix:**
- `schema.ts`: change PK to `PRIMARY KEY (proxy_wallet, tier)`.
- `runV3SqliteMigrations`: detect the legacy schema via
  `sqlite_master.sql` regex and `DROP TABLE` before re-creating. Safe
  because `discovery_wallet_scores_v3` is a cache — 05 and
  `refreshWorker.ts` rebuild it from DuckDB snapshots on every run.
- New regression tests in `tests/v3-schema.test.ts`:
  - asserts one wallet can occupy all three tiers simultaneously
  - asserts duplicate `(wallet, tier)` is rejected
  - asserts legacy schema auto-upgrades

**Operator note:** Re-running 05 (after pulling rev5) is enough — the
migration drops and recreates the scores table automatically. 04 does
not need to re-run.

### Backfill fix rev6 (2026-04-23) — `"user"` keyword silent-fallback bug ⚠️ CRITICAL

**Problem:** After rev5, 05 ran and produced wallet scores — but only
for ONE wallet: `'duckdb'` (the string literal). Diagnostic query
showed all 912M rows in `discovery_activity_v3` had
`proxy_wallet = 'duckdb'`, and `COUNT(DISTINCT proxy_wallet) = 1`.

**Root cause:** The ingest SQL in `backfillQueries.ts` referenced a
column called `user` (both `"user"` quoted and bare `user`) from the
source parquet. But the REAL `users.parquet` schema (confirmed by
`DESCRIBE SELECT * FROM read_parquet('data/users.parquet') LIMIT 0`)
has:

```
timestamp UBIGINT, block_number UBIGINT, transaction_hash VARCHAR,
log_index UINTEGER, address VARCHAR, role VARCHAR, direction VARCHAR,
usd_amount DOUBLE, token_amount DOUBLE, price DOUBLE,
market_id VARCHAR, condition_id VARCHAR, event_id VARCHAR,
nonusdc_side VARCHAR
```

The column is **`address`**, not `user`. In DuckDB 1.4.4, when a query
references `"user"` or `user` and no such column exists, the parser
silently resolves it to the `CURRENT_USER` **reserved keyword**, which
returns the literal string `'duckdb'` on the Hetzner server. No error
is raised. Every row gets `proxy_wallet = 'duckdb'`, `side` was also
wrong (the old code derived BUY/SELL from `token_amount` sign; real
parquet has an explicit `direction` column with 'BUY'/'SELL').

**Fix — 15 SQL edits in `src/discovery/v3/backfillQueries.ts`:**

1. `staging_events_v3` DDL: `user VARCHAR` → `address VARCHAR`; added
   `direction VARCHAR` column.
2. `buildStagingIngestSql`: SELECT projects `address` and `direction`
   from the source parquet.
3. `buildSortBucketFromParquetToParquetSql`: passes through `address`
   and `direction`; added defensive `AND address IS NOT NULL` filter.
4. All `"user" AS proxy_wallet` and bare `user AS proxy_wallet` (5
   places) → `address AS proxy_wallet`.
5. `arg_min("user", timestamp)` (2 places) → `arg_min(address, timestamp)`.
6. `CASE WHEN token_amount > 0 THEN 'BUY' ELSE 'SELL' END AS side`
   (5 places) → `UPPER(direction) AS side` — uses the authoritative
   direction column directly, no sign inference.

**Defensive schema guard added (NEW):**

`02_load_events.ts` and `02a_sort_bucket.ts` now run a `DESCRIBE
SELECT * FROM read_parquet('...') LIMIT 0` at startup and throw a
fatal error if any of `address, direction, role, timestamp,
transaction_hash, log_index, market_id, usd_amount, token_amount,
price` is missing. Any future column rename fails loudly on second 1,
not silently after 3 hours.

**Regression tests updated:**

`tests/v3-backfill-mapping.test.ts` fixtures rewritten to use the
production schema (`address` + `direction`), proving the pipeline
against the real shape of the data. Previously the test fixtures used
`user VARCHAR` and inferred side from `token_amount` sign, which is
why the bug slipped past tests.

**End-to-end verification script:**

`scripts/verify-rev6-fix.ts` builds a synthetic parquet matching the
EXACT production schema, runs every backfill SQL path
(`buildEventIngestSqlAntiJoin`, `buildEventIngestSqlAntiJoinChunked`,
`buildStagingIngestSql`, `buildStagingSortBucketToParquetSql`,
`buildSortBucketFromParquetToParquetSql`), and asserts:

- `COUNT(DISTINCT proxy_wallet)` equals the real number of wallets
- zero rows have `proxy_wallet = 'duckdb'`
- all `proxy_wallet` values are valid 0x-prefixed 42-char addresses
- `side` contains both `BUY` and `SELL`
- `activity ⋈ markets_dim` join returns rows (snapshots will work)

Run with: `npx tsx scripts/verify-rev6-fix.ts`

**Operator note:** The 83 GB `discovery_v3.duckdb` and the previous
912M rows of `discovery_activity_v3` are **garbage** — every row has
`proxy_wallet='duckdb'`. The database must be wiped and the full
pipeline re-run from 02a. The raw `users.parquet` (51.5 GB) is
**intact** — this is only a derived-data rebuild, not a re-fetch.

Full recovery command block (Hetzner):

```bash
cd /mnt/HC_Volume_105468668/repo-v3
git pull --ff-only origin discovery-v3-rebuild
rm -f /mnt/HC_Volume_105468668/discovery_v3.duckdb
rm -f /mnt/HC_Volume_105468668/bucket_parquets/*.parquet
export DUCKDB_PATH=/mnt/HC_Volume_105468668/discovery_v3.duckdb
export DUCKDB_MEMORY_LIMIT_GB=6 DUCKDB_THREADS=2
export DUCKDB_TEMP_DIR=/mnt/HC_Volume_105468668/duckdb_tmp
export DUCKDB_MAX_TEMP_DIR_GB=60
export SORTED_PARQUET_DIR=/mnt/HC_Volume_105468668/bucket_parquets
export LOG=/tmp/v3-rev6-$(date +%Y%m%dT%H%M%S).log
bash scripts/backfill/finish_backfill.sh 2>&1 | tee -a "$LOG"
```

## Part 13: Post-backfill cutover status (2026-04-24)

**Current state:** Backfill finished end-to-end on the Hetzner box ~05:30
UTC on 2026-04-24. Scripts 03 (markets) → 04 (snapshots) → 05 (score &
publish) all completed cleanly. `05` reported **335,826 / 2,486,208
wallets eligible** (13.5%) and wrote 1,500 tier-ranked rows to the
SQLite hot read model.

**Cutover is paused pending validator rerun.** The initial `06_validate.ts`
run reported 3/20 PASS — a validator bug, not a backfill bug. Diagnosis
and fix are in `docs/2026-04-24-post-backfill-validator-triage.md`.
Summary of the bug:

1. `dataApiValidator.ts` did not paginate `/v1/activity` — for any
   wallet with >500 lifetime events the API was silently capped at 500
   rows, producing guaranteed FAILs with ~99% volume delta.
2. The validator did not filter events to `type=TRADE`, so REDEEM /
   SPLIT / MERGE activity inflated the API-side volume on wallets with
   redemption history.
3. Comparing `trade_count` directly was fundamentally wrong: our
   derived count is `OrderFilled` events (maker + taker row per fill)
   while the API reports user-initiated trades (one row per order).
   Volume is fill-level-invariant; trade_count is not.

**Fix in branch `fix/validator-pagination-and-trade-type`:**
- Rewrote `src/discovery/v3/dataApiValidator.ts` to paginate with
  offset, filter to TRADE only, gate PASS/FAIL on volume delta (5%
  tolerance), and handle deep-offset 500s as end-of-pagination.
- Added 10 unit tests in `tests/v3-data-api-validator.test.ts`.
- Updated `scripts/backfill/06_validate.ts` to surface
  `[api-capped]` marker and count it separately in the summary.

**Known residual issues (NOT blocking cutover):**
- `trade_count` is events not trades → eligibility gate
  (`MIN_TRADE_COUNT=20`) is weaker than intended. File as follow-up
  after cutover.
- Mega-wallets (>100k events) cannot be fully paginated against API
  (deep-offset 500 from Polymarket). Validator treats this as lower
  bound. Tier rankings are volume-driven so this doesn't affect
  output correctness.

**Next steps (post-rerun, only if 18+/20 PASS):**
1. Deploy `discovery-v3-rebuild` branch to staging at
   `/opt/polymarket-bot-staging` via `scripts/deploy-staging.sh`.
2. Set `DISCOVERY_V3=true` in the staging `.env` only.
3. Smoke test all nine `/api/discovery/v3/*` endpoints + the UI at
   `staging.ditto.jungle.win/discovery-v3/`.
4. Soak 24–48h, then deploy to prod via `scripts/deploy-production.sh`
   after merging PR #88 into main.

**Never (learned from this session):**
- Never trust a single-call API comparison against full-lifetime
  derived totals. Always paginate OR compare sum-of-values (which
  converge regardless of pagination if you paginate the API).
- Never count mixed-type activity against event-specific derivations.
  `/v1/activity` is NOT the same shape as `discovery_activity_v3`.
- Never gate correctness on `trade_count` when fill-level vs
  trade-level granularity differ between sources. Volume in USDC is
  the invariant.

### Rev 7 (2026-04-24): staging UI `Too many requests` crash fix

**Symptom.** After login, `staging.ditto.jungle.win/discovery-v3/`
crashed with `Fetch failed: Unexpected token 'T', "Too many r"... is
not valid JSON`. Anonymous curl still returned JSON
`{"success":false,"error":"Authentication required"}` — so the 429
only fired when an authenticated session was present and only against
`/api/discovery/v3/*`.

**Root cause.** `src/server.ts` mounts `express-rate-limit` at
`app.use('/api', apiLimiter, requireOidcAuth, ...)` with
`max: 1200 / 15 min` (≈80 req/min per IP). Discovery v3 is a
read-heavy dashboard (tier refresh, per-wallet drill-ins, polling)
and trivially exceeds that. The default `express-rate-limit`
handler responds with plain text `"Too many requests, please try
again later."`, so the UI's `res.json()` threw immediately and blanked
the wallet list.

**Fix (both sides):**
- `src/server.ts`: add a JSON `handler` that returns
  `{ success: false, error: "rate_limited", message, retryAfterSec }`
  with `Content-Type: application/json` and a `Retry-After` header.
  Add a `skip` predicate that exempts `/discovery/v3/*` paths from the
  global limiter (read-only, authenticated dashboard surface — abuse
  is already bounded by session auth). Raise the non-v3 limit from
  1200 → 3000 per 15 min for general dashboard ergonomics.
- `public/discovery-v3/app.js`: new `safeFetch` wrapper inspects
  `res.status` and `content-type` before calling `res.json()`, returns
  a discriminated result. On 429, the UI shows a non-blocking
  "Rate-limited, retrying in Ns…" banner, auto-retries with the
  server-provided `retryAfterSec`, and **keeps previously-loaded
  wallets visible** so the UI never goes blank.
- `tests/apiRateLimiter.test.ts`: three tests — 429 returns JSON,
  `/api/discovery/v3/*` is exempt, v3 traffic does not burn the
  non-v3 quota.

**Deploy.** Checkout `discovery-v3-rebuild` at
`/opt/polymarket-bot-staging` (detached HEAD — repo-v3 at
`/mnt/HC_Volume_105468668/repo-v3` holds the worktree lock), rebuild,
and restart `polymarket-app-staging` +
`polymarket-discovery-worker-staging`.

**Invariant going forward.** Any new API limiter / middleware MUST
respond with JSON, not plain text — the frontend's fetch wrappers
assume JSON and will crash on HTML or text bodies. If a reverse proxy
(Caddy / nginx) ever gets a rate-limit rule added, set its error
response to return JSON too.

### Rev 8 (2026-04-24): staging `HTTP 401: Authentication required` fix

**Symptom.** Anyone opening `staging.ditto.jungle.win/discovery-v3/`
*without* an Auth0 session — i.e. everyone the link is shared with —
saw a blocking red banner:

```
HTTP 401: {"success":false,"error":"Authentication required"}
```

The page rendered the header (Alpha/Whale/Specialist tabs) but every
tier fetch failed. Reported verbatim as "still not working, everyone
I send it to sees garbage."

**Root cause.** `src/server.ts` mounts the global OIDC gate with

```ts
app.use('/api', apiLimiter, requireOidcAuth, …);
```

and then mounts the v3 router behind it:

```ts
app.use('/api/discovery/v3', createDiscoveryV3Router(…));
```

So every `/api/discovery/v3/*` request — including anonymous GETs that
have no session yet — hit `requireOidcAuth` and returned 401 with
`"Authentication required"`. The Rev 7 fix skipped v3 only from the
*rate limiter*, not from the *auth gate*. The v3 page's `safeFetch`
surfaced the 401 body as a generic HTTP error ("HTTP 401: {...}") and
never redirected to `/auth/login`.

**Fix.**
- `src/api/discoveryRoutesV3.ts`: export `requireAuthForMutations`.
  It returns 401 JSON with `loginUrl: '/auth/login'` when
  `req.oidc?.isAuthenticated()` is false, and falls through when
  `req.oidc` is absent (legacy / open-dev / already-gated upstream).
  Apply it as per-route middleware on the four mutators only:
  `POST /track`, `POST /watchlist`, `DELETE /watchlist/:addr`,
  `POST /dismiss`. Read endpoints (`/tier/:tier`, `/wallet/:address`,
  `/compare`, `/health`, `/cutover-status`) have NO auth middleware.
- `src/server.ts`: mount the v3 router **before** the global
  `requireOidcAuth` in all three auth modes (OIDC / legacy-secret /
  open-dev) via a new `mountDiscoveryV3Public()` helper. The v3 mount
  sits **after** the Auth0 middleware in OIDC mode so `req.oidc` is
  populated and the per-route gate can distinguish logged-in vs
  anonymous. A belt-and-suspenders early-return skips the tenant
  resolver for any `/discovery/v3/*` path that slips through the
  outer matcher.
- `public/discovery-v3/app.js`:
  - `safeFetch` now passes `credentials: 'same-origin'` so the Auth0
    session cookie reaches the server on mutations.
  - 401 responses are surfaced as a structured
    `{ kind: 'auth_required', loginUrl }` result — never as "HTTP 401"
    red banner text.
  - `refreshAuthStatus()` calls `/api/auth/me` at boot to determine
    `state.authed`, then renders an auth bar in the header:
    "Viewing as guest — sign in to copy trade" + **Sign in** button
    when anonymous; "Signed in" + **Log out** when authed.
  - Copy-trade CTA relabels to **"Sign in to Copy"** for guests and
    redirects to `/auth/login?returnTo=…` on click instead of firing
    a mutation that will 401.
- `tests/discoveryV3PublicAuth.test.ts`: four tests —
  1. anonymous GETs on all five read endpoints return 200 JSON;
  2. anonymous POSTs/DELETEs on all four mutators return 401 JSON
     with `loginUrl`;
  3. mutators succeed when `req.oidc.isAuthenticated()` is true;
  4. `requireAuthForMutations` lets requests through when
     `req.oidc` is absent (legacy / dev fallthrough).

**Deploy.** Checkout `fix/discovery-v3-public-read` (PR opened,
**NOT merged** — awaiting manual merge per Space instructions) at
`/opt/polymarket-bot-staging`, rebuild, restart
`polymarket-app-staging`. v3 worker does not need restart (no
discovery-worker changes).

**Invariants going forward.**
1. The v3 read surface (`/tier`, `/wallet`, `/compare`, `/health`,
   `/cutover-status`) is **public**. Do not add auth middleware to
   it. If you need a private read endpoint, add a new path under
   a different mount point — do not quietly gate an existing v3 read.
2. Every v3 **mutation** route MUST include `requireAuthForMutations`
   as per-route middleware. Do not rely on global `requireOidcAuth`
   because the v3 router is mounted above it.
3. The v3 frontend must always set `credentials: 'same-origin'` so
   Auth0 cookies reach mutators. Never show the raw 401 body — route
   the user to `/auth/login?returnTo=…` instead.
