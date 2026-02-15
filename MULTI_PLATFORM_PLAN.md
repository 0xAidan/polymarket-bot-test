# Multi-Platform Prediction Market Bot — Expansion Plan v2.0

**Version:** 2.0  
**Date:** February 15, 2026  
**Status:** Active — Ready for implementation  
**Branch:** `feature/advanced-trade-filters` (current working branch)  
**Audience:** Engineering team, collaborators

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Lessons Learned from v1 Attempt](#2-lessons-learned-from-v1-attempt)
3. [Non-Negotiable Rules](#3-non-negotiable-rules)
4. [Current System Snapshot](#4-current-system-snapshot)
5. [Dome API — What It Is and What We Use](#5-dome-api--what-it-is-and-what-we-use)
6. [Phase 0: Infrastructure Hardening](#6-phase-0-infrastructure-hardening)
7. [Phase 1: Dome Integration + WebSocket Real-Time](#7-phase-1-dome-integration--websocket-real-time)
8. [Phase 2: Cross-Platform Data + Arbitrage Detection](#8-phase-2-cross-platform-data--arbitrage-detection)
9. [Phase 3: Wallet Entity Linking + Hedge Detection](#9-phase-3-wallet-entity-linking--hedge-detection)
10. [Phase 4: One-Click Hedge + Auto-Execute Arbitrage](#10-phase-4-one-click-hedge--auto-execute-arbitrage)
11. [Phase 5: Ladder Exit Strategy + Smart Stop-Loss](#11-phase-5-ladder-exit-strategy--smart-stop-loss)
12. [UI Change Summary — What Changes, What Doesn't](#12-ui-change-summary--what-changes-what-doesnt)
13. [Full Dashboard Mockups](#13-full-dashboard-mockups)
14. [Master Timeline](#14-master-timeline)
15. [Technical Reference](#15-technical-reference)
16. [Risk Register](#16-risk-register)
17. [Open Decisions](#17-open-decisions)

---

## 1. Executive Summary

We are extending our working Polymarket copy-trading bot to:
- **Monitor trades in real-time** via Dome WebSocket (replacing 5-second polling)
- **See cross-platform data** from Polymarket + Kalshi via Dome API
- **Detect arbitrage opportunities** when the same event has different prices across platforms
- **Auto-execute arbitrage trades** when spread exceeds a configurable threshold
- **Link wallets into entities** to see if the same person is hedging across platforms
- **One-click hedge** any position across platforms
- **Automated ladder exits** for profit-taking at multiple price levels
- **Smart stop-loss** with recovery-based calculations and trailing stops

### Design Principles

1. **Additive, not destructive.** Every feature is added alongside existing code. Nothing that works today should break.
2. **Paper mode first.** Any feature that touches real money launches in paper/simulation mode and must be explicitly enabled for live trading.
3. **One PR per phase.** Each phase is a standalone PR that can be reviewed, tested, and merged independently.
4. **No silent regressions.** Every PR must pass `npm run build`. Every changed behavior must be intentional and documented.

---

## 2. Lessons Learned from v1 Attempt

A previous attempt at Phase 0 (SQLite migration, branch `feature/sqlite-storage`) was stopped due to several issues. These are documented here so they are not repeated.

### What Went Wrong

| Issue | What Happened | Rule Going Forward |
|---|---|---|
| **Deleted working code** | `booleanParsing.ts` was deleted, breaking config parsing | NEVER delete existing utility files unless their callers are also updated in the same PR |
| **Removed diagnostics** | `getUsageStopLossStatus()` was flattened to a simple boolean, removing the detailed status object the API returns | NEVER simplify a public API method's return type — if it returns rich data, keep it |
| **Moved dedup timing** | Trade dedup marking was moved to before execution (from after filters), meaning rejected trades would be marked as "processed" | NEVER change the order of operations in `copyTrader.ts` trade processing without explicit approval |
| **No JSON fallback** | Config flag `storageBackend` was added but never wired — SQLite was the only path | Feature flags MUST be functional from the first commit |
| **Tests failed** | Data directory wasn't created before SQLite tried to init | Every new module must work with `ensureDataDir()` called first |
| **Scope creep in routes.ts** | Stop-loss conflict detection was silently removed from config validation endpoint | Routes changes must be explicitly listed and justified in PR description |

### Salvageable Work

The `database.ts` schema design from clawd's branch is reasonable. The table structure can be reused:

```sql
-- Good schema from previous attempt:
CREATE TABLE tracked_wallets (
  address TEXT PRIMARY KEY,
  added_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  label TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE bot_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

CREATE TABLE executed_positions (
  market_id TEXT NOT NULL,
  side TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  wallet_address TEXT NOT NULL,
  PRIMARY KEY (market_id, side)
);
```

The serialization/deserialization helpers (`serializeWallet`, `deserializeWalletRow`) were also well-done and can be reused.

---

## 3. Non-Negotiable Rules

These apply to every phase and every PR:

### Code Safety
- `npm run build` must pass before any PR is opened
- Existing tests must pass (or pre-existing failures must be documented)
- No file deletions without updating all callers
- No changes to the order of operations in `copyTrader.ts` trade processing pipeline
- No changes to `clobClient.ts` authentication flow
- No changes to `.env` format that would break existing setups (new vars are additive only)

### Review Process
- Every phase = one draft PR
- PR description must list: files changed, new files, deleted files, behavior changes, new env vars
- No PR merges without Aidan's explicit approval
- PRs should be mergeable independently (no cross-PR dependencies)

### Feature Safety
- Any feature that places real trades must launch in **paper mode** first
- Paper mode = log what we WOULD do, without actually doing it
- Explicit user opt-in to switch from paper → live
- All automated trading features (auto-arb, ladder exits, smart stop-loss) default to OFF

### What Must Never Change (Without Explicit Approval)
- The `CopyTrader` → `TradeExecutor` execution pipeline
- The Polymarket CLOB client authentication flow
- The existing wallet add/remove/configure UI behavior
- The `DetectedTrade` → dedup → filter → execute order of operations
- Per-wallet config fields and their defaults

---

## 4. Current System Snapshot

### Architecture
```
┌───────────────────────────────────────────────────────────┐
│                    CURRENT ARCHITECTURE                     │
│                                                             │
│  Monitoring          Orchestration         Execution        │
│  ┌──────────────┐    ┌───────────────┐    ┌─────────────┐  │
│  │ WalletMonitor │───▶│  CopyTrader   │───▶│ Trade       │  │
│  │ (5s polling)  │    │  (filters,    │    │ Executor    │  │
│  └──────────────┘    │   dedup,      │    │ (CLOB SDK)  │  │
│                      │   sizing)     │    └─────────────┘  │
│  ┌──────────────┐    └───────────────┘                     │
│  │ WebSocket    │                                          │
│  │ (own trades  │    Storage           UI                  │
│  │  only)       │    ┌───────────┐    ┌─────────────┐      │
│  └──────────────┘    │ JSON files │    │ Express +   │      │
│                      │ (flat)     │    │ Vanilla JS  │      │
│                      └───────────┘    └─────────────┘      │
└───────────────────────────────────────────────────────────┘
```

### Key Stats
- **Platform:** Polymarket only
- **Detection latency:** ~5 seconds (polling)
- **Storage:** JSON files (`tracked_wallets.json`, `bot_config.json`, `executed_positions.json`)
- **UI tabs:** Dashboard, Wallets, Settings, Diagnostics
- **Trade sizing:** Fixed, proportional, or global default (per-wallet)
- **Risk controls:** Price limits, rate limiting, value filters, no-repeat trades, usage stop-loss

### Key Source Files

| File | Lines | Purpose |
|---|---|---|
| `src/copyTrader.ts` | ~1,360 | Main orchestrator — DO NOT modify order of operations |
| `src/walletMonitor.ts` | ~300 | Polling-based trade detection |
| `src/tradeExecutor.ts` | ~200 | Polymarket CLOB trade execution |
| `src/storage.ts` | ~675 | JSON file-based persistence |
| `src/api/routes.ts` | ~2,000 | REST API endpoints |
| `src/polymarketApi.ts` | ~400 | Polymarket API client |
| `src/config.ts` | ~73 | Environment config |
| `src/types.ts` | ~333 | TypeScript type definitions |
| `public/index.html` | ~587 | Dashboard UI |
| `public/js/app.js` | ~800 | Frontend logic |
| `public/styles.css` | ~1,565 | Styling |

### Current Dependencies (package.json)
```
@polymarket/clob-client, @polymarket/builder-signing-sdk,
ethers, axios, express, ws, chart.js, date-fns, dotenv, cors
```

---

## 5. Dome API — What It Is and What We Use

### Overview

[Dome API](https://docs.domeapi.io/) is a prediction market aggregator. It provides a unified API for data from Polymarket and Kalshi, plus real-time WebSocket feeds and an order router.

### What Dome Gives Us

| Capability | Dome Endpoint | What We Use It For |
|---|---|---|
| **Polymarket market data** | `GET /polymarket/markets` | Market search/display |
| **Polymarket positions** | `GET /polymarket/positions/wallet/{addr}` | Cross-reference wallet holdings |
| **Polymarket wallet PnL** | `GET /polymarket/wallet/pnl/{addr}` | Track entity-level performance |
| **Polymarket wallet info** | `GET /polymarket/wallet` | Resolve EOA ↔ proxy mapping |
| **Polymarket market price** | `GET /polymarket/market-price` | Live prices for arb detection |
| **Kalshi markets** | `GET /kalshi/markets` | Browse Kalshi markets |
| **Kalshi market price** | `GET /kalshi/market-price` | Live prices for arb detection |
| **Kalshi trade history** | `GET /kalshi/trades` | Kalshi trade data |
| **Matching Markets** | `GET /matching-markets/sports` | Find same event across platforms |
| **WebSocket** | `wss://ws.domeapi.io/<key>` | Real-time order events for ANY wallet |
| **Order Router** | `POST /polymarket/placeOrder` | Server-side Polymarket execution |

### Dome WebSocket — Key Details

The WebSocket is the most impactful feature for us. Unlike our current Polymarket WebSocket (which only monitors our own authenticated wallet), Dome's WebSocket can monitor **any wallet address**.

**Connection:** `wss://ws.domeapi.io/<API_KEY>`

**Subscribe to wallets:**
```json
{
  "action": "subscribe",
  "platform": "polymarket",
  "version": 1,
  "type": "orders",
  "filters": {
    "users": ["0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d"]
  }
}
```

**Event received when tracked wallet trades:**
```json
{
  "type": "event",
  "subscription_id": "sub_gq5c3resmrq",
  "data": {
    "token_id": "80311845198420617...",
    "token_label": "No",
    "side": "BUY",
    "market_slug": "btc-updown-15m-1762479900",
    "condition_id": "0x5853a47d...",
    "shares": 9000000,
    "shares_normalized": 9,
    "price": 0.56,
    "tx_hash": "0xaccc1246d7bc...",
    "title": "Bitcoin Up or Down - November 6",
    "timestamp": 1762480391,
    "order_hash": "0xc2b8ee7c9d...",
    "user": "0x6031b6eed1c97e..."
  }
}
```

### Dome Order Router — Key Details

The Order Router lets us place Polymarket orders server-side with builder attribution. Orders are signed locally and executed via Dome's infrastructure.

```typescript
const router = new PolymarketRouter({
  chainId: 137,
  apiKey: process.env.DOME_API_KEY,
});

// One-time: link user
const credentials = await router.linkUser({ userId: 'user-123', signer });

// Place order (no wallet popup needed after link)
const order = await router.placeOrder({
  userId: 'user-123',
  marketId: '10417355721474...',
  side: 'buy',
  size: 100,
  price: 0.50,
  orderType: 'FOK', // Fill or Kill for instant fills
  signer,
}, credentials);
```

### Tier Requirements

| Feature | Min Tier | Limits |
|---|---|---|
| REST API (market data) | Free | 1 QPS, 10/10s |
| WebSocket (wallet monitoring) | **Dev** | 500 subscriptions, 500 wallets/sub |
| Order Router | Dev | Included |
| High-frequency arb scanning | **Dev** | 100 QPS needed |

**Action required:** Sign up at https://dashboard.domeapi.io/ and get a Dev tier API key.

---

## 6. Phase 0: Infrastructure Hardening

**Goal:** Migrate from JSON files to SQLite for data integrity. Add structured logging. Validate environment config. This is the foundation everything else builds on.

**Branch:** `feature/phase0-sqlite-infra`  
**Estimated effort:** 20 hours  
**Depends on:** Nothing (starts from current `feature/advanced-trade-filters`)

### Why This Comes First

- JSON files have no transactional safety — a crash mid-write corrupts state
- New features (arb history, ladder state, entity links) need queryable storage
- The previous SQLite attempt proved the migration path works but needs guard rails
- Structured logging is required before we add complex async features (WS, arb scanner)

### 0.1 — SQLite Persistence Layer

**New file: `src/database.ts`**

```typescript
// Responsibilities:
// 1. Initialize SQLite database (bot.sqlite in data/ dir)
// 2. Create schema tables
// 3. Migrate legacy JSON files → SQLite (one-time, on first run)
// 4. Archive (rename) JSON files after migration (don't delete)
// 5. Export getDatabase() singleton

// Schema (same tables as before, plus new ones for future phases):
// - tracked_wallets (address PK, added_at, active, last_seen, label, settings_json)
// - bot_config (id=1 singleton, data JSON)
// - executed_positions (market_id + side PK, timestamp, wallet_address)
// - trade_metrics (id auto, timestamp, wallet, market, side, amount, status, latency, etc.)
// - system_issues (id auto, timestamp, type, message, resolved)
```

**Modified file: `src/storage.ts`**

```typescript
// Changes:
// 1. Add import of getDatabase from database.ts
// 2. Add storageBackend check: if config.storageBackend === 'sqlite', use DB; else use JSON
// 3. ALL existing method signatures stay identical
// 4. ALL existing return types stay identical
// 5. JSON fallback path is the EXISTING code, unchanged
// 6. SQLite path calls database.ts prepared statements

// Example pattern:
static async loadTrackedWallets(): Promise<TrackedWallet[]> {
  if (config.storageBackend === 'sqlite') {
    return this._loadTrackedWalletsSqlite();
  }
  return this._loadTrackedWalletsJson(); // existing code, moved to private method
}
```

**Modified file: `src/config.ts`**

```typescript
// Add ONE line:
storageBackend: (process.env.STORAGE_BACKEND || 'json').toLowerCase(),
// NOTE: defaults to 'json' not 'sqlite' — opt-in only
// User sets STORAGE_BACKEND=sqlite in .env to enable
```

**New dependency: `better-sqlite3`**

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

### 0.2 — JSON Fallback (Feature Flag)

The `STORAGE_BACKEND` env var controls which path is used:
- `json` (default) — existing behavior, zero risk
- `sqlite` — new SQLite path

If `sqlite` is set but initialization fails, we log a warning and fall back to `json` automatically.

### 0.3 — Legacy Migration

When SQLite initializes for the first time:
1. Check if `tracked_wallets.json` exists → import rows → rename to `tracked_wallets.legacy.json`
2. Check if `bot_config.json` exists → import row → rename to `bot_config.legacy.json`
3. Check if `executed_positions.json` exists → import rows → rename to `executed_positions.legacy.json`

Legacy files are NEVER deleted, only renamed.

### 0.4 — Structured Logging (Optional, Recommended)

**New dependency: `pino`** (fast JSON logger)

Replace `console.log` / `console.error` / `console.warn` with structured logger in new files only. Existing files keep their console calls for now (retrofit in a later pass).

### Acceptance Criteria

- [ ] `npm run build` passes
- [ ] `npm run test` passes (existing tests)
- [ ] Bot starts and works identically with `STORAGE_BACKEND=json` (default)
- [ ] Bot starts and works identically with `STORAGE_BACKEND=sqlite`
- [ ] Legacy JSON files are migrated and renamed on first SQLite run
- [ ] If SQLite init fails, bot falls back to JSON and logs a warning
- [ ] `getUsageStopLossStatus()` still returns the full status object (NOT simplified)
- [ ] `booleanParsing.ts` still exists and is still used
- [ ] No changes to `copyTrader.ts` trade processing order
- [ ] PR description lists every file changed with a one-line justification

### Files Changed

| File | Change |
|---|---|
| `src/database.ts` | **NEW** — SQLite schema, init, migration |
| `src/storage.ts` | **MODIFIED** — Add SQLite path alongside existing JSON path |
| `src/config.ts` | **MODIFIED** — Add `storageBackend` field (1 line) |
| `package.json` | **MODIFIED** — Add `better-sqlite3` dependency |
| `tests/storage.test.ts` | **NEW** — Test both JSON and SQLite paths |

### Files NOT Changed

| File | Why |
|---|---|
| `src/copyTrader.ts` | No storage changes affect trade logic |
| `src/api/routes.ts` | Storage interface is unchanged, routes don't care |
| `src/utils/booleanParsing.ts` | Stays as-is |
| `public/*` | No UI changes |

---

## 7. Phase 1: Dome Integration + WebSocket Real-Time

**Goal:** Replace 5-second polling with Dome WebSocket for sub-second trade detection. Keep polling as automatic fallback.

**Branch:** `feature/phase1-dome-websocket`  
**Estimated effort:** 20 hours  
**Depends on:** Phase 0 merged (for structured storage of WS state)

### Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                   PHASE 1: MONITORING UPGRADE                  │
│                                                                │
│  PRIMARY: Dome WebSocket                                       │
│  ┌─────────────────────┐                                       │
│  │ DomeWebSocketMonitor│◀── wss://ws.domeapi.io/<API_KEY>      │
│  │                     │                                       │
│  │ - Subscribe to all  │    On event:                          │
│  │   tracked wallets   │    ┌─────────────────────┐            │
│  │ - Auto-reconnect    │───▶│ Map Dome event      │            │
│  │ - Heartbeat check   │    │ → DetectedTrade     │            │
│  └─────────────────────┘    └──────────┬──────────┘            │
│                                        │                       │
│  FALLBACK: Existing Polling            │                       │
│  ┌─────────────────────┐               ▼                       │
│  │ WalletMonitor       │    ┌─────────────────────┐            │
│  │ (5s polling)        │───▶│ CopyTrader          │ UNCHANGED  │
│  │ (activates if WS    │    │ (dedup, filter, exec)│           │
│  │  disconnects)       │    └─────────────────────┘            │
│  └─────────────────────┘                                       │
└───────────────────────────────────────────────────────────────┘
```

### New Files

**`src/domeClient.ts`** — Shared Dome REST API wrapper
```typescript
// Thin wrapper around @dome-api/sdk
// Configured via DOME_API_KEY env var
// Methods:
//   getPolymarketMarketPrice(tokenId)
//   getKalshiMarketPrice(ticker)
//   getMatchingMarkets(slugs)
//   getWalletPositions(address)
//   getWalletPnL(address, granularity)
// All methods have retry logic + rate limit awareness
```

**`src/domeWebSocket.ts`** — WebSocket connection manager
```typescript
// Manages the Dome WebSocket connection lifecycle
// 
// Constructor: DomeWebSocketMonitor(apiKey, onTrade callback)
//
// Key methods:
//   start(walletAddresses[]) — connect + subscribe
//   stop() — clean disconnect
//   addWallet(address) — subscribe to new wallet (live update)
//   removeWallet(address) — unsubscribe from wallet
//   getStatus() — { connected, uptime, subscriptionId, lastEventAt, walletCount }
//
// Internal:
//   Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
//   Heartbeat ping every 30s to detect dead connections
//   On disconnect: emit 'disconnected' event → CopyTrader activates polling fallback
//   On reconnect: emit 'reconnected' event → CopyTrader deactivates polling
//
// Event mapping:
//   Dome event.data → DetectedTrade:
//     walletAddress = event.data.user
//     marketId = event.data.condition_id
//     outcome = event.data.token_label (YES/NO)
//     side = event.data.side (BUY/SELL)
//     price = event.data.price.toString()
//     amount = event.data.shares_normalized.toString()
//     timestamp = new Date(event.data.timestamp * 1000)
//     transactionHash = event.data.tx_hash
//     tokenId = event.data.token_id
//     marketSlug = event.data.market_slug
//     marketTitle = event.data.title
```

### Modified Files

**`src/copyTrader.ts`** — Minimal changes only:
```typescript
// ADD: Import DomeWebSocketMonitor
// ADD: In start(), if DOME_API_KEY is set:
//   1. Create DomeWebSocketMonitor instance
//   2. Pass wallet addresses from tracked wallets
//   3. Set onTrade callback → this.handleDetectedTrade() (existing method)
//   4. Set onDisconnect → activate walletMonitor polling
//   5. Set onReconnect → deactivate walletMonitor polling
// ADD: In stop(), call domeWsMonitor.stop()
// ADD: When wallet added/removed, call domeWsMonitor.addWallet/removeWallet
//
// DO NOT change: handleDetectedTrade, dedup logic, filter logic, sizing logic
```

**`src/config.ts`**:
```typescript
// ADD:
domeApiKey: process.env.DOME_API_KEY || '',
```

**`src/api/routes.ts`**:
```typescript
// ADD: GET /api/dome/status — returns Dome WS connection status
// ADD: Include monitoring mode (ws/polling) in GET /api/status response
```

**`public/index.html`**:
```
// ADD: "Monitoring: 🟢 WebSocket (Dome)" or "Monitoring: 🟡 Polling (5s)"
//      in the Trading Wallet card on Dashboard tab
// ADD: "Dome API Health" section in Diagnostics tab
```

### Acceptance Criteria

- [ ] `npm run build` passes
- [ ] With no `DOME_API_KEY`, bot works exactly as before (polling only)
- [ ] With `DOME_API_KEY` set, bot connects to Dome WebSocket and receives trade events
- [ ] Trade events from Dome WS are correctly mapped to `DetectedTrade` and processed by existing pipeline
- [ ] If Dome WS disconnects, polling automatically resumes within 5 seconds
- [ ] If Dome WS reconnects, polling automatically stops
- [ ] Dashboard shows current monitoring mode (WS or Polling)
- [ ] Diagnostics tab shows Dome API health
- [ ] No changes to CopyTrader dedup/filter/sizing logic

---

## 8. Phase 2: Cross-Platform Data + Arbitrage Detection

**Goal:** Surface arbitrage opportunities between Polymarket and Kalshi. Detection only — no execution yet.

**Branch:** `feature/phase2-arb-detection`  
**Estimated effort:** 25 hours  
**Depends on:** Phase 1 merged (for `domeClient.ts`)

### Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                   ARB SCANNER (read-only)                       │
│                                                                │
│  Periodic loop (every 30–60s):                                 │
│                                                                │
│  1. GET /matching-markets/sports → list of cross-platform pairs│
│  2. For each pair:                                             │
│     GET /polymarket/market-price → Poly price                  │
│     GET /kalshi/market-price → Kalshi price                    │
│  3. Calculate spread = |YES_poly + YES_kalshi - 1|             │
│     (if YES_poly + YES_kalshi < 1 → arb exists)               │
│  4. If spread > min_threshold → store as ArbOpportunity        │
│  5. Push to dashboard via API                                  │
│                                                                │
│  NO TRADES PLACED. Display only.                               │
└───────────────────────────────────────────────────────────────┘
```

### Arbitrage Math

```
Same event on two platforms:
  Polymarket: "Chiefs win" YES = $0.52, NO = $0.48
  Kalshi:     "Chiefs win" YES = $0.48, NO = $0.52

Arb play: Buy YES on Kalshi ($0.48) + Buy NO on Polymarket ($0.48)
  Total cost: $0.96
  Guaranteed payout: $1.00 (one side always wins)
  Profit: $0.04 per pair (4.2% return)
  
  At $500 deployed: ~$20.83 profit

Fee-adjusted:
  Polymarket fee: ~2% of profit
  Kalshi fee: varies by market
  Must show NET profit after fees
```

### New Files

**`src/arbScanner.ts`**
```typescript
// ArbScanner class
// 
// Constructor: ArbScanner(domeClient, storage)
// 
// Methods:
//   start() — begin periodic scanning
//   stop() — stop scanning
//   getOpportunities() — return current list
//   getStatus() — { running, lastScanAt, marketsScanned, opportunitiesFound }
//
// ArbOpportunity type:
// {
//   id: string,
//   matchKey: string (e.g., "nfl-ari-den-2025-08-16"),
//   polymarketSlug: string,
//   kalshiTicker: string,
//   title: string,
//   polyYesPrice: number,
//   kalshiYesPrice: number,
//   spread: number (percentage),
//   direction: 'buy_poly_no_kalshi_yes' | 'buy_poly_yes_kalshi_no',
//   estimatedProfit: number (per $100),
//   estimatedProfitAfterFees: number,
//   detectedAt: Date,
//   lastSeenAt: Date,
//   status: 'active' | 'expired'
// }
```

### New Settings (added to bot_config)

```json
{
  "arbScanner": {
    "enabled": false,
    "scanIntervalSeconds": 60,
    "minSpreadPercent": 3,
    "maxOpportunitiesToShow": 20
  }
}
```

### UI Changes

**Dashboard tab** — New "Arbitrage Opportunities" card below Recent Trades:

```
┌─ Arbitrage Opportunities ──────────────────── 🔴 LIVE ─────┐
│                                                              │
│ Market             Polymarket  Kalshi  Spread  Est. Profit   │
│ ──────────────────────────────────────────────────────────── │
│ Chiefs SB YES      $0.52       $0.48   4.0%    $4.17/100    │
│ BTC>100k YES       $0.61       $0.58   3.1%    $3.23/100    │
│ NYC Mayor DEM      $0.89       $0.86   3.0%    $3.09/100    │
│                                                              │
│ Scanning 24 matched markets • Last scan: 45s ago             │
│ Min spread: 3% • Auto-execute: OFF                           │
└──────────────────────────────────────────────────────────────┘
```

**Settings tab** — New "Arbitrage Scanner" section:

```
┌─ Arbitrage Scanner ──────────────────────────────────────────┐
│                                                               │
│ ☑ Enable Arbitrage Scanner                                    │
│                                                               │
│ Scan Interval:     [ 60 ] seconds                             │
│ Min Spread:        [ 3  ] %                                   │
│ Show Top:          [ 20 ] opportunities                       │
│                                                               │
│ ☐ Auto-Execute (Phase 4 — not yet available)                  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Acceptance Criteria

- [ ] Arb scanner runs periodically and finds matching markets via Dome API
- [ ] Spread is calculated correctly including fee estimates
- [ ] Opportunities display on dashboard with live prices
- [ ] Scanner can be enabled/disabled from Settings
- [ ] No trades are placed (display only)
- [ ] Scanner gracefully handles Dome API errors and rate limits
- [ ] With `DOME_API_KEY` missing, arb scanner section shows "Configure Dome API to enable"

---

## 9. Phase 3: Wallet Entity Linking + Hedge Detection

**Goal:** Let users group wallets into entities and detect when an entity is hedging across platforms or wallets.

**Branch:** `feature/phase3-entity-linking`  
**Estimated effort:** 24 hours  
**Depends on:** Phase 1 merged (for `domeClient.ts`)

### Data Model

```typescript
interface WalletEntity {
  id: string;                    // e.g., "entity_001"
  label: string;                 // e.g., "Whale 42"
  wallets: EntityWallet[];
  notes?: string;
  createdAt: Date;
}

interface EntityWallet {
  address: string;               // Wallet address (Polymarket) or username (Kalshi)
  platform: 'polymarket' | 'kalshi';
  label?: string;                // e.g., "Main wallet"
  active: boolean;
}

interface EntityExposure {
  entityId: string;
  markets: MarketExposure[];     // Net position per matched market
  totalValue: number;
  hedgeAlerts: HedgeAlert[];
}

interface HedgeAlert {
  matchKey: string;              // Dome matching market key
  title: string;
  polymarketPosition: { side: string; shares: number; value: number };
  kalshiPosition: { side: string; contracts: number; value: number };
  type: 'hedging' | 'doubling_down' | 'reducing';
}
```

### How Hedge Detection Works

```
For each entity with wallets on multiple platforms:

1. Fetch Polymarket positions for each Poly wallet
   → via Dome GET /polymarket/positions/wallet/{addr}

2. For each position, check if there's a matching Kalshi market
   → via Dome GET /matching-markets/sports?polymarket_market_slug=X

3. If matched, compare:
   - Entity holds YES on Polymarket AND YES on Kalshi → DOUBLING DOWN
   - Entity holds YES on Polymarket AND NO on Kalshi  → HEDGING
   - Same entity, two Poly wallets, opposite sides     → REDUCING EXPOSURE

4. Generate HedgeAlerts for the UI
```

### Storage

New SQLite table (if Phase 0 SQLite is active):
```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  wallets_json TEXT NOT NULL DEFAULT '[]'
);
```

JSON fallback: `data/entities.json`

### UI Changes

**Wallets tab** — New "Entity Groups" section at TOP of page:

```
┌─ Entity Groups ─────────────────────────── [+ New Group] ───┐
│                                                              │
│ ┌ Whale 42 ──────────────────────────── [Edit] [Delete] ──┐ │
│ │ Wallets: 0xABC.. (Main), 0xDEF.. (Alt)                  │ │
│ │ Combined Value: $2,847 across 2 wallets                  │ │
│ │ Net Exposure: +$2,400 YES on BTC>100k                    │ │
│ │ ⚠ HEDGE DETECTED: Opposing positions on Kalshi           │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ ┌ Sports Bettor ─────────────────────── [Edit] [Delete] ──┐ │
│ │ Wallets: 0x123.. (NFL focus)                             │ │
│ │ Combined Value: $1,200                                   │ │
│ │ Active in 3 NFL markets • No hedging detected            │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘

── Tracked Wallets ─────────────────────── [+ Add Wallet] ────
(existing wallet list, unchanged)
Each wallet card gets: [Assign to Group ▼] dropdown
```

### API Endpoints

```
GET    /api/entities                    — List all entities
POST   /api/entities                    — Create entity
PUT    /api/entities/:id                — Update entity (label, notes, wallets)
DELETE /api/entities/:id                — Delete entity
GET    /api/entities/:id/exposure       — Get net exposure + hedge alerts
POST   /api/entities/:id/wallets       — Add wallet to entity
DELETE /api/entities/:id/wallets/:addr  — Remove wallet from entity
```

### Acceptance Criteria

- [ ] Users can create/edit/delete entity groups
- [ ] Users can assign existing tracked wallets to entities
- [ ] Entity cards show combined position value
- [ ] Hedge detection correctly identifies opposing positions across platforms
- [ ] Entity section appears above existing wallet list (wallet list unchanged)
- [ ] Entities persist across bot restarts (JSON or SQLite)
- [ ] With no Dome API key, entities still work for grouping Polymarket-only wallets

---

## 10. Phase 4: One-Click Hedge + Auto-Execute Arbitrage

**Goal:** Enable actual trade execution for hedging and arbitrage. Both launch in **paper mode** first.

**Branch:** `feature/phase4-hedge-and-autoarb`  
**Estimated effort:** 30 hours  
**Depends on:** Phase 2 (arb scanner) and Phase 3 (entity linking) merged

### 4A: Auto-Execute Arbitrage

Extends the arb scanner from Phase 2 with execution capability.

**Paper mode (default):**
```
Arb opportunity detected: Chiefs SB, spread 4.0%
PAPER TRADE: Would buy NO on Polymarket @ $0.48, 100 shares ($48)
PAPER TRADE: Would buy YES on Kalshi @ $0.48, 100 contracts ($48)
Total cost: $96 → Guaranteed payout: $100 → Profit: $4
[Logged to trade history with tag "ARB_PAPER"]
```

**Live mode (opt-in, requires explicit toggle):**
- Polymarket side: executed via existing CLOB client OR Dome Order Router
- Kalshi side: **alert only** (no Kalshi execution API yet) with link/instructions

**New settings:**
```json
{
  "arbScanner": {
    "autoExecute": false,
    "autoExecuteMode": "paper",
    "maxPositionSizeUSDC": 100,
    "executionSide": "polymarket_only"
  }
}
```

### 4B: One-Click Hedge Execution

**New file: `src/hedgeCalculator.ts`**

When user clicks [Hedge] on a position, a modal shows:

```
┌─ HEDGE PREVIEW ──────────────────────────────────────────────┐
│                                                               │
│ Position: 100 shares YES on "Chiefs SB" @ $0.52 (Polymarket) │
│ Exposure: $52.00                                              │
│                                                               │
│ Hedge Option              Cost     Max Loss   Guaranteed      │
│ ──────────────────────────────────────────────────────────── │
│ ○ Full Hedge (100%)                                          │
│   Buy 100 NO on Kalshi    $51.00   $3.00      $-3 to +$48   │
│                                                               │
│ ○ Partial Hedge (50%)                                        │
│   Buy 50 NO on Kalshi     $25.50   —          Reduced exp.   │
│                                                               │
│ ○ Same-Platform Reduce                                       │
│   Sell 50 YES on Poly     +$26.00  —          50% exposure   │
│                                                               │
│ ⚠ Kalshi execution not yet supported.                        │
│   Instructions will be shown after Polymarket side executes.  │
│                                                               │
│ [Cancel]                              [Execute] [Paper Only]  │
└───────────────────────────────────────────────────────────────┘
```

**Execution flow:**
1. Polymarket side → existing `TradeExecutor` (already works)
2. Kalshi side → show manual instructions with pre-filled details
3. Log both sides as linked hedge pair in trade history

### UI Changes

**Recent Trades table** — Add [H] (Hedge) button on active BUY positions:
```
Time    Wallet    Market          Side   Amt    Health  Action
14:32   0xABC..   Chiefs SB YES   BUY    $52    🟢     [H]
14:28   0xDEF..   BTC>100k YES    BUY    $120   🟡     [H]
```

**Trades from arb/hedge get tagged:**
```
14:02   [ARB]     Chiefs SB NO    BUY    $48    —      —
13:55   [HEDGE]   BTC>100k NO     BUY    $60    —      —
```

### Acceptance Criteria

- [ ] Arb auto-execute defaults to paper mode (logs only, no real trades)
- [ ] Paper mode trades appear in trade history tagged as `ARB_PAPER`
- [ ] Live arb execution only triggers after explicit Settings toggle
- [ ] One-click hedge modal shows accurate cost/profit calculations
- [ ] Hedge execution on Polymarket works via existing CLOB client
- [ ] Kalshi instructions shown clearly when cross-platform hedge selected
- [ ] Hedge pairs are linked in trade history
- [ ] All execution features respect existing rate limits and stop-loss

---

## 11. Phase 5: Ladder Exit Strategy + Smart Stop-Loss

**Goal:** Automated position management. Both features launch in paper mode.

**Branch:** `feature/phase5-position-management`  
**Estimated effort:** 40 hours  
**Depends on:** Phase 1 merged (for Dome price monitoring)

### 5A: Ladder Exit Strategy

**New file: `src/ladderExitManager.ts`**

```
Position: 100 shares YES @ $0.50

Ladder (Even Split preset):
  Level 1: Sell 25 @ $0.60 (20% gain) → $2.50 profit
  Level 2: Sell 25 @ $0.70 (40% gain) → $5.00 profit
  Level 3: Sell 25 @ $0.80 (60% gain) → $7.50 profit
  Level 4: Sell 25 @ $0.90 (80% gain) → $10.00 profit

Total expected profit if all levels hit: $25.00 (50% return)
```

**Price monitoring:** Shared infrastructure — polls Dome Market Price API every 10 seconds for all positions with active ladders or stop-losses. One loop, not per-position.

**Paper mode:** Logs "LADDER_PAPER: Would sell 25 shares @ $0.60" without placing orders.

**UI — Ladder setup modal** (click on a position):

```
┌─ EXIT LADDER ─── Chiefs SB YES (100 shares @ $0.50) ────────┐
│                                                               │
│ ☑ Enable Ladder Exit                                         │
│                                                               │
│ Preset: [ Even Split (4 levels) ▼ ]                          │
│                                                               │
│ Level   Trigger    Shares    Est. Profit   Status             │
│ ──────────────────────────────────────────────────────────── │
│ 1       [ $0.60 ]  [ 25 ]   $2.50         ⏳ Waiting         │
│ 2       [ $0.70 ]  [ 25 ]   $5.00         ⏳ Waiting         │
│ 3       [ $0.80 ]  [ 25 ]   $7.50         ⏳ Waiting         │
│ 4       [ $0.90 ]  [ 25 ]   $10.00        ⏳ Waiting         │
│                              [+ Add Level]                    │
│                                                               │
│ Total: 100/100 shares • Expected avg exit: $0.75             │
│ Expected total profit: $25.00 (50% return)                   │
│                                                               │
│ Mode: ( ○ Paper  ● Live )                                    │
│                                                               │
│ [Cancel]                              [Activate Ladder]       │
└───────────────────────────────────────────────────────────────┘
```

**Presets:**
| Preset | Levels | Description |
|---|---|---|
| Even Split (4) | +20%, +40%, +60%, +80% | Equal portions at each level |
| Aggressive (2) | +30%, +60% | Quick profit-taking |
| Conservative (6) | +10% through +60% | Gradual exits |
| Custom | User-defined | Full manual control |

### 5B: Smart Stop-Loss

**New file: `src/smartStopLoss.ts`**

```
Recovery-based calculation:

  entry = $0.50, current = $0.42
  loss = (0.50 - 0.42) / 0.50 = 16%
  recovery_needed = 0.16 / (1 - 0.16) = 19%
  
  If recovery_needed > 50% → TRIGGER STOP (unlikely to recover)

Trailing stop:
  Position hits +20% profit → stop moves to break-even
  Position hits +40% profit → stop moves to +20%
  Position hits +60% profit → stop moves to +40%
  
  Stop trails 10% below peak price
```

**Settings (new section in Settings tab):**
```
┌─ Smart Stop-Loss ────────────────────────────────────────────┐
│                                                               │
│ ☑ Enable Smart Stop-Loss         Mode: ( ○ Paper  ● Live )   │
│                                                               │
│ Scope: ( ○ Global  ● Per-Position )                           │
│                                                               │
│ Max Recovery Threshold:    [ 50 ] %                           │
│ (Stop if this much gain needed to break even)                 │
│                                                               │
│ ☑ Trailing Stop                                               │
│   Activation:   [ 20 ] % profit from entry                    │
│   Trail:        [ 10 ] % below peak price                     │
│                                                               │
│ ☑ Lock-In Levels                                              │
│   +20% profit → lock break-even                               │
│   +40% profit → lock +20%                                     │
│   +60% profit → lock +40%                                     │
│                                                               │
│ Daily Loss Limit: [ $100 ] (pause ALL trading if exceeded)    │
└───────────────────────────────────────────────────────────────┘
```

**Dashboard — Health indicators on positions:**
```
Time    Market          Side   Entry  Current  Health   Stop
14:32   Chiefs SB YES   BUY    $0.52  $0.58    🟢 +12%  $0.52
14:28   BTC>100k YES    BUY    $0.61  $0.55    🟡 -10%  $0.48
14:15   NYC Mayor DEM   BUY    $0.88  $0.71    🔴 -19%  $0.65

🟢 = In profit or <10% loss
🟡 = 10-25% recovery needed
🔴 = >25% recovery needed
```

### Shared Price Monitor

Both ladder exits and smart stop-loss need current prices. Rather than duplicate:

**New file: `src/priceMonitor.ts`**
```typescript
// Polls Dome Market Price API every 10s for all active positions
// Shares results with both LadderExitManager and SmartStopLoss
// Single API call per token, deduplicated across consumers
```

### Acceptance Criteria

- [ ] Ladder exits default to paper mode (log only)
- [ ] Smart stop-loss defaults to paper mode (log only)
- [ ] Paper mode trades tagged `LADDER_PAPER` / `STOP_PAPER` in history
- [ ] Explicit toggle to switch each feature to live mode
- [ ] Price monitor runs ONE shared loop, not per-feature
- [ ] Health indicators appear on Dashboard positions table
- [ ] Ladder levels can be configured with presets or custom values
- [ ] Trailing stop correctly tracks peak price and adjusts stop level
- [ ] Daily loss limit pauses all trading (not just stop-loss positions)
- [ ] All position management respects existing rate limits

---

## 12. UI Change Summary — What Changes, What Doesn't

### UNCHANGED (Do Not Touch)

| Element | Location |
|---|---|
| Header layout (title, status badge, start/stop) | Header |
| Tab names and order (Dashboard, Wallets, Settings, Diagnostics) | Nav |
| Wallet Balance Card design | Dashboard |
| Metrics Grid (6 cards) | Dashboard |
| Existing wallet list and per-wallet config UI | Wallets |
| General Settings form (trade size, interval, slippage) | Settings |
| Existing diagnostics (API, RPC, config validation) | Diagnostics |

### ADDED (Appended to Existing Tabs)

| Element | Location | Phase |
|---|---|---|
| "Monitoring: WS/Polling" indicator | Dashboard → Wallet Card | 1 |
| "Dome API Health" section | Diagnostics tab | 1 |
| "Arbitrage Opportunities" card | Dashboard → below Recent Trades | 2 |
| "Arbitrage Scanner" settings | Settings tab → new section | 2 |
| "Entity Groups" section | Wallets tab → above wallet list | 3 |
| [Assign to Group] dropdown on wallet cards | Wallets tab → each wallet | 3 |
| [Hedge] button on positions | Dashboard → Recent Trades table | 4 |
| Hedge preview modal | Dashboard → modal overlay | 4 |
| Trade tags (ARB, HEDGE, LADDER, STOP) | Dashboard → Recent Trades table | 4-5 |
| "Active Ladders" card | Dashboard → below Arb Opportunities | 5 |
| Health indicators (🟢🟡🔴) | Dashboard → Recent Trades table | 5 |
| Ladder setup modal | Dashboard → modal overlay | 5 |
| "Smart Stop-Loss" settings | Settings tab → new section | 5 |
| "Ladder Defaults" settings | Settings tab → new section | 5 |
| "Active Managers" section | Diagnostics tab | 5 |

---

## 13. Full Dashboard Mockups

### Dashboard Tab (All Phases Complete)

```
┌──────────────────────────────────────────────────────────────┐
│  Polymarket Copytrade Bot              [● Running] [Stop Bot]│
├──────────────────────────────────────────────────────────────┤
│  Dashboard | Wallets | Settings | Diagnostics                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ Trading Wallet ──────────────────────────────────────┐   │
│  │  0x2D43...3010                                        │   │
│  │  USDC Balance: $1,247.53        +$23.41 (24h)         │   │
│  │  Monitoring: 🟢 WebSocket (Dome)  Latency: <100ms     │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐            │
│  │98% │  │ 47 │  │82ms│  │ 5  │  │ 46 │  │ 1  │            │
│  │Succ│  │Trd │  │Lat │  │Wlt │  │Pass│  │Fail│            │
│  └────┘  └────┘  └────┘  └────┘  └────┘  └────┘            │
│                                                              │
│  ┌─ Recent Trades ───────────────────────────────────────┐   │
│  │ Time   Source   Market        Side  Amt   Hlth   Act  │   │
│  │ 14:32  0xABC..  Chiefs YES    BUY   $52   🟢+12% [H]  │   │
│  │ 14:28  0xDEF..  BTC>100k     BUY   $120  🟡-10% [H]  │   │
│  │ 14:15  0xABC..  NYC Mayor    SELL  $30   —      —    │   │
│  │ 14:02  [ARB]    Chiefs NO    BUY   $48   —      —    │   │
│  │ 13:55  [LADDER] BTC>80k     SELL  $25   —      —    │   │
│  │ 13:41  [STOP]   ETH>5k     SELL  $80   —      —    │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Arbitrage Opportunities ────────── 🔴 LIVE ──────────┐   │
│  │ Market           Poly    Kalshi  Spread  Profit/100   │   │
│  │ Chiefs SB YES    $0.52   $0.48   4.0%    $4.17        │   │
│  │ BTC>100k YES     $0.61   $0.58   3.1%    $3.23        │   │
│  │ NYC Mayor DEM    $0.89   $0.86   3.0%    $3.09        │   │
│  │                                                       │   │
│  │ 24 markets scanned • Last: 12s ago                    │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Active Ladders ──────────────────────────────────────┐   │
│  │ Position         Entry  Current  Next Level     Prog  │   │
│  │ BTC>100k YES     $0.50  $0.67    $0.70 (L3)    ██░░  │   │
│  │ Chiefs SB YES    $0.40  $0.52    $0.55 (L2)    █░░░  │   │
│  │                                                       │   │
│  │ 2 active ladders • 5 levels filled today              │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Performance Chart ───────────────────────────────────┐   │
│  │ (existing Chart.js chart — unchanged)                 │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### Wallets Tab

```
┌──────────────────────────────────────────────────────────────┐
│  Dashboard | Wallets | Settings | Diagnostics                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ Entity Groups ──────────────────── [+ New Group] ────┐   │
│  │                                                        │  │
│  │  ┌ Whale 42 ─────────────────── [Edit] [Delete] ────┐ │  │
│  │  │ Wallets: 0xABC.. (Main), 0xDEF.. (Alt)           │ │  │
│  │  │ Combined: $2,847 • 5 active positions             │ │  │
│  │  │ ⚠ HEDGE: Opposing Kalshi position on BTC>100k     │ │  │
│  │  └───────────────────────────────────────────────────┘ │  │
│  │                                                        │  │
│  │  ┌ Sports Bettor ───────────── [Edit] [Delete] ────┐  │  │
│  │  │ Wallets: 0x123.. (NFL focus)                     │  │  │
│  │  │ Combined: $1,200 • 3 NFL markets                 │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ── Tracked Wallets ───────────────── [+ Add Wallet] ────── │
│                                                              │
│  (existing wallet list — completely unchanged)               │
│  Each card gains: [Assign to Group ▼]                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Settings Tab

```
┌──────────────────────────────────────────────────────────────┐
│  Dashboard | Wallets | Settings | Diagnostics                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ General Settings ────────────────────────────────────┐   │
│  │ (existing — unchanged)                                │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Dome API ────────────────────────────────────────────┐   │
│  │ API Key: [••••••••••]            Status: 🟢 Connected  │   │
│  │ Tier: Dev (100 QPS) • WS: Connected • Subs: 5/500    │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Arbitrage Scanner ───────────────────────────────────┐   │
│  │ ☑ Enable Scanner    Interval: [60]s    Spread: [3]%   │   │
│  │ ☐ Auto-Execute  Mode: (○ Paper  ○ Live)  Max: [$100]  │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Smart Stop-Loss ────────────────────────────────────┐   │
│  │ ☐ Enable    Mode: (○ Paper  ○ Live)                   │   │
│  │ Max Recovery: [50]%  |  ☑ Trailing: [10]% below peak  │   │
│  │ Daily Loss Limit: [$100]                              │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Ladder Defaults ────────────────────────────────────┐   │
│  │ ☐ Auto-create on copied trades                        │   │
│  │ Default: [Even Split (4 levels) ▼]  Mode: (○P  ○L)    │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Diagnostics Tab

```
┌──────────────────────────────────────────────────────────────┐
│  Dashboard | Wallets | Settings | Diagnostics                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  (existing diagnostics sections — unchanged)                 │
│                                                              │
│  ┌─ Dome API Health ────────────────────────────────────┐   │
│  │ REST:      🟢 Connected (45ms latency)                │   │
│  │ WebSocket: 🟢 Connected (uptime 4h 32m)               │   │
│  │ Subs: 5/500 • QPS: 23/100 • Last event: 2s ago       │   │
│  │ Order Router: 🟢 Available                             │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Feature Status ─────────────────────────────────────┐   │
│  │ Arb Scanner:  🟢 Running • 24 markets • 3 opps found  │   │
│  │ Ladder Mgr:   🟢 2 active ladders                     │   │
│  │ Smart Stop:   🟢 Monitoring 5 positions                │   │
│  │ Price Monitor: Next check in 3s                       │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 14. Master Timeline

```
WEEK  1  │  2  │  3  │  4  │  5  │  6  │  7  │  8  │  9  │ 10
──────────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼────
Phase 0   █████│     │     │     │     │     │     │     │     │
SQLite    ░░░░░│     │     │     │     │     │     │     │     │
(20 hrs)       │     │     │     │     │     │     │     │     │
               │     │     │     │     │     │     │     │     │
Phase 1        █████│█████│     │     │     │     │     │     │
Dome + WS      ░░░░░│░░░░░│     │     │     │     │     │     │
(20 hrs)             │     │     │     │     │     │     │     │
                     │     │     │     │     │     │     │     │
Phase 2              │█████│█████│     │     │     │     │     │
Arb Detect           │░░░░░│░░░░░│     │     │     │     │     │
(25 hrs)             │     │     │     │     │     │     │     │
                     │     │     │     │     │     │     │     │
Phase 3              │     │█████│█████│     │     │     │     │
Entities             │     │░░░░░│░░░░░│     │     │     │     │
(24 hrs)             │     │     │     │     │     │     │     │
                     │     │     │     │     │     │     │     │
Phase 4              │     │     │     │█████│█████│     │     │
Hedge+Arb Exec       │     │     │     │░░░░░│░░░░░│     │     │
(30 hrs)             │     │     │     │     │     │     │     │
                     │     │     │     │     │     │     │     │
Phase 5              │     │     │     │     │     │█████│█████│█████
Ladder+Stop          │     │     │     │     │     │░░░░░│░░░░░│░░░░░
(40 hrs)             │     │     │     │     │     │     │     │
```

### Phase Summary

| Phase | Name | Hours | Key Deliverable | Depends On |
|---|---|---|---|---|
| **0** | Infrastructure Hardening | 20 | SQLite + JSON fallback, env validation | Nothing |
| **1** | Dome + WebSocket | 20 | Sub-second trade detection, Dome health in UI | Phase 0 |
| **2** | Arb Detection | 25 | Cross-platform price comparison, arb dashboard card | Phase 1 |
| **3** | Entity Linking | 24 | Wallet grouping, hedge detection alerts | Phase 1 |
| **4** | Hedge + Auto-Arb | 30 | One-click hedging, auto-arb (paper → live) | Phases 2+3 |
| **5** | Ladder + Stop-Loss | 40 | Automated exits, trailing stops (paper → live) | Phase 1 |
| **TOTAL** | | **~159 hrs** | | ~10 weeks |

### Notes on Parallelism
- Phases 2 and 3 can run in parallel (different people or staggered starts) since they both depend only on Phase 1
- Phase 5 only depends on Phase 1 (price monitoring via Dome) so it could theoretically start earlier, but it's safer to have the arb/hedge execution patterns established first

---

## 15. Technical Reference

### New NPM Dependencies

| Package | Version | Purpose | Phase |
|---|---|---|---|
| `better-sqlite3` | latest | SQLite persistence | 0 |
| `@types/better-sqlite3` | latest | TypeScript types | 0 |
| `@dome-api/sdk` | latest | Dome REST API + Order Router | 1 |
| `pino` | latest | Structured logging (optional) | 0 |

### New Source Files (by Phase)

```
Phase 0:
  src/database.ts              — SQLite schema, init, migration
  tests/storage.test.ts        — Storage tests for both backends

Phase 1:
  src/domeClient.ts            — Shared Dome REST API wrapper
  src/domeWebSocket.ts         — Dome WebSocket connection manager

Phase 2:
  src/arbScanner.ts            — Cross-platform arbitrage scanner

Phase 3:
  src/entityManager.ts         — Wallet entity CRUD + hedge detection

Phase 4:
  src/hedgeCalculator.ts       — Hedge cost/profit calculation + execution

Phase 5:
  src/ladderExitManager.ts     — Ladder exit strategy engine
  src/smartStopLoss.ts         — Recovery-based stop-loss engine
  src/priceMonitor.ts          — Shared price polling for ladders + stops
```

### Modified Files (by Phase)

| Phase | File | Change Summary |
|---|---|---|
| 0 | `src/storage.ts` | Add SQLite path alongside JSON (dual-backend) |
| 0 | `src/config.ts` | Add `storageBackend` env var |
| 0 | `package.json` | Add `better-sqlite3` |
| 1 | `src/config.ts` | Add `domeApiKey` env var |
| 1 | `src/copyTrader.ts` | Wire DomeWSMonitor as primary (minimal change) |
| 1 | `src/api/routes.ts` | Add `/api/dome/status` endpoint |
| 1 | `public/index.html` | Monitoring indicator, Dome diagnostics |
| 2 | `src/api/routes.ts` | Add arb endpoints |
| 2 | `public/index.html` | Arb opportunities card, arb settings |
| 3 | `src/api/routes.ts` | Add entity endpoints |
| 3 | `public/index.html` | Entity groups section on Wallets tab |
| 4 | `src/api/routes.ts` | Add hedge endpoints |
| 4 | `public/index.html` | Hedge modal, trade tags, [H] button |
| 5 | `src/api/routes.ts` | Add ladder + stop-loss endpoints |
| 5 | `public/index.html` | Ladder modal, health indicators, active ladders card |

### New API Endpoints (by Phase)

```
Phase 1:
  GET  /api/dome/status                      — Dome WS + REST health

Phase 2:
  GET  /api/arb/opportunities                — Current arb list
  GET  /api/arb/status                       — Scanner status
  PUT  /api/arb/settings                     — Update arb config

Phase 3:
  GET  /api/entities                         — List entities
  POST /api/entities                         — Create entity
  PUT  /api/entities/:id                     — Update entity
  DEL  /api/entities/:id                     — Delete entity
  GET  /api/entities/:id/exposure            — Net exposure + alerts

Phase 4:
  POST /api/hedge/preview                    — Calculate hedge options
  POST /api/hedge/execute                    — Execute hedge trade
  POST /api/arb/execute                      — Manually trigger arb trade

Phase 5:
  GET  /api/ladders                          — Active ladders
  POST /api/ladders                          — Create ladder for position
  DEL  /api/ladders/:id                      — Cancel ladder
  PUT  /api/stoploss/settings                — Update stop-loss config
  GET  /api/positions/health                 — Position health indicators
```

### New Environment Variables

```env
# Phase 0
STORAGE_BACKEND=json              # 'json' (default) or 'sqlite'

# Phase 1
DOME_API_KEY=your_dome_api_key    # Required for all Dome features
```

---

## 16. Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | SQLite migration corrupts data | HIGH | Low | JSON fallback always available. Legacy files preserved. |
| R2 | Dome API downtime | Medium | Medium | Polling fallback auto-activates. All Dome features degrade gracefully. |
| R3 | Dome tier costs prohibitive | Medium | Low | Free tier supports basic market data. Evaluate Dev tier before Phase 1. |
| R4 | Arb spreads too thin after fees | Low | Medium | Show fee-adjusted profits. Configurable min spread. Paper mode first. |
| R5 | Matching Markets limited to sports | Medium | High | Sports only for now. Note in UI. Build custom matching later if needed. |
| R6 | Ladder/stop-loss triggers wrong price | HIGH | Low | Paper mode first. Conservative defaults. Shared price monitor for consistency. |
| R7 | Auto-execute places unintended trades | HIGH | Low | Paper mode default. Explicit opt-in. Rate limits apply. |
| R8 | WebSocket volume overwhelms bot | Medium | Low | Dev tier has 500 sub limit. Event handler is async with queue. |
| R9 | Kalshi execution not available via Dome | Medium | High | Alert-only for Kalshi. Show manual instructions. Plan for Kalshi API later. |
| R10 | Regression in copy-trading pipeline | HIGH | Medium | Non-negotiable rules. No changes to CopyTrader order of operations. |

---

## 17. Open Decisions

These need answers before or during implementation:

| # | Question | Who Decides | Needed By |
|---|---|---|---|
| D1 | Dome API tier pricing — is Dev tier affordable? | Aidan | Before Phase 1 |
| D2 | Should we add structured logging (pino) in Phase 0 or defer? | Team | Phase 0 |
| D3 | Matching markets beyond sports — wait for Dome or build custom? | Aidan | Phase 2 |
| D4 | Kalshi direct API integration — separate Phase 6 or fold into Phase 4? | Team | Phase 4 |
| D5 | Notifications (Telegram/Discord/webhook) for arb/stop alerts? | Aidan | Phase 2+ |
| D6 | Should paper mode trades be visible in main trade history or separate tab? | Team | Phase 4 |
| D7 | Multi-user support — is this on the roadmap? Entity linking implies it. | Aidan | Phase 3 |

---

## Appendix A: Dome API Quick Reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/polymarket/markets` | GET | Search Polymarket markets |
| `/polymarket/positions/wallet/{addr}` | GET | Wallet positions |
| `/polymarket/wallet/pnl/{addr}` | GET | Wallet PnL |
| `/polymarket/market-price` | GET | Current market price |
| `/polymarket/trade-history` | GET | Trade history |
| `/polymarket/candlestick` | GET | OHLC data |
| `/polymarket/wallet` | GET | Wallet info (EOA/proxy) |
| `/kalshi/markets` | GET | Search Kalshi markets |
| `/kalshi/market-price` | GET | Kalshi market price |
| `/kalshi/trades` | GET | Kalshi trade history |
| `/matching-markets/sports` | GET | Cross-platform matching |
| `/polymarket/placeOrder` | POST | Order Router execution |
| `wss://ws.domeapi.io/<key>` | WS | Real-time order events |

## Appendix B: Glossary

| Term | Definition |
|---|---|
| **EOA** | Externally Owned Account (MetaMask/Rabby address) |
| **Proxy Wallet** | Polymarket smart contract wallet per user |
| **Entity** | Group of wallets believed to be same person/org |
| **Arbitrage** | Exploiting price differences across platforms |
| **Hedge** | Opposing position to reduce risk |
| **Ladder Exit** | Selling in increments at ascending price levels |
| **Recovery-Based Stop** | Stop-loss based on gain needed to break even |
| **Trailing Stop** | Stop that moves up as price increases |
| **Paper Mode** | Simulation — logs what would happen without real trades |
| **Dome** | Third-party API aggregating Polymarket + Kalshi |
| **CLOB** | Central Limit Order Book (Polymarket's system) |
| **Matching Markets** | Same event listed on multiple platforms |
