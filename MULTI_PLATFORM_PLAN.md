# Multi-Platform Prediction Market Bot — Feature Expansion Plan

**Version:** 1.0  
**Date:** February 2026  
**Status:** Proposal / Planning  
**Audience:** Engineering team, stakeholders

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current System Overview](#2-current-system-overview)
3. [Dome API Integration Strategy](#3-dome-api-integration-strategy)
4. [Feature 1: WebSocket Real-Time Monitoring](#4-feature-1-websocket-real-time-monitoring)
5. [Feature 2: Wallet Entity Linking](#5-feature-2-wallet-entity-linking)
6. [Feature 3: Cross-Platform Arbitrage Detection & Auto-Execute](#6-feature-3-cross-platform-arbitrage-detection--auto-execute)
7. [Feature 4: One-Click Hedge Execution](#7-feature-4-one-click-hedge-execution)
8. [Feature 5: Ladder Exit Strategy](#8-feature-5-ladder-exit-strategy)
9. [Feature 6: Smart Stop-Loss](#9-feature-6-smart-stop-loss)
10. [UI Mockups](#10-ui-mockups)
11. [Implementation Phases & Timeline](#11-implementation-phases--timeline)
12. [Technical Dependencies](#12-technical-dependencies)
13. [Risk Assessment](#13-risk-assessment)
14. [Open Questions](#14-open-questions)

---

## 1. Executive Summary

We are expanding our Polymarket Copytrade Bot to support **multiple prediction market platforms** (starting with Polymarket + Kalshi) using the **Dome API** as our unified data layer. The existing UI, core copy-trading engine, and wallet management system stay intact — we are adding capabilities on top of what already works.

**Key additions:**
- Real-time WebSocket monitoring via Dome (replacing our 5-second polling)
- Cross-platform arbitrage detection with optional auto-execution
- One-click hedge execution across Polymarket and Kalshi
- Wallet entity linking to detect when the same person operates across platforms
- Automated ladder exit strategies for profit-taking
- Recovery-based smart stop-loss calculations

**What is NOT changing:**
- The existing dashboard layout and tab structure
- Core copy-trading logic (walletMonitor → copyTrader → tradeExecutor)
- Per-wallet configuration system
- JSON file-based storage (migration to DB is a separate future initiative)
- The existing Polymarket CLOB authentication flow

---

## 2. Current System Overview

```
┌─────────────────────────────────────────────────────────┐
│                    CURRENT ARCHITECTURE                   │
│                                                           │
│  ┌──────────────┐    ┌───────────────┐    ┌───────────┐  │
│  │ WalletMonitor│───▶│  CopyTrader   │───▶│  Trade    │  │
│  │ (5s polling) │    │  (orchestrator)│    │  Executor │  │
│  └──────────────┘    └───────────────┘    └───────────┘  │
│         │                    │                    │        │
│         ▼                    ▼                    ▼        │
│  Polymarket Data API   Per-wallet filters   Polymarket    │
│  (positions endpoint)  Rate limiting        CLOB API      │
│                        Deduplication                      │
│                                                           │
│  ┌──────────────┐    ┌───────────────┐                   │
│  │   Express     │    │  JSON Storage │                   │
│  │   Dashboard   │    │  (file-based) │                   │
│  └──────────────┘    └───────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

**Platforms supported:** Polymarket only  
**Monitoring method:** Polling every 5 seconds via Polymarket Data API  
**Execution method:** Polymarket CLOB Client SDK  
**UI:** Vanilla JS dashboard with 4 tabs (Dashboard, Wallets, Settings, Diagnostics)

---

## 3. Dome API Integration Strategy

### What is Dome?

Dome API is a prediction market aggregator providing unified access to **Polymarket** and **Kalshi** data through a single API. It offers:

| Capability | What it gives us |
|---|---|
| **REST API** | Markets, positions, trade history, wallet PnL for both platforms |
| **WebSocket** | Real-time order events for any wallet on Polymarket (not just our own) |
| **Order Router** | Server-side order execution on Polymarket with builder attribution |
| **Matching Markets** | Cross-platform market matching (same event on Poly + Kalshi) |
| **Wallet Analytics** | Wallet info, PnL, positions lookup |

### Integration Approach: Additive, Not Replacement

We are **not** ripping out the Polymarket CLOB client. Instead:

1. **Dome REST API** supplements our existing data layer — adds Kalshi data and cross-platform matching
2. **Dome WebSocket** replaces our polling-based `walletMonitor.ts` — faster detection for tracked wallets
3. **Dome Order Router** becomes an alternative execution path alongside our existing `tradeExecutor.ts`
4. **Existing CLOB client** remains the primary trade execution path (already working, battle-tested)

### Dome API Tier Requirements

| Feature | Min Tier | Why |
|---|---|---|
| Basic market data | Free (1 QPS) | Sufficient for UI display |
| WebSocket monitoring | **Dev ($?)** | Need >2 subscriptions, >5 wallets |
| Arbitrage scanning | **Dev** | Need 100 QPS for cross-platform price checks |
| Order Router | Dev | For server-side execution |

**Action item:** Sign up at https://dashboard.domeapi.io/ and evaluate Dev tier pricing.

### New Environment Variables Required

```env
# Dome API
DOME_API_KEY=your_dome_api_key

# Kalshi (if direct API access needed later)
KALSHI_API_KEY=optional_for_future
```

---

## 4. Feature 1: WebSocket Real-Time Monitoring

### Problem
Our current `walletMonitor.ts` polls the Polymarket positions API every 5 seconds. This means:
- Up to 5 seconds of latency before we detect a trade
- Wasted API calls when no trades happen
- Can miss rapid trades within the same polling window

### Solution
Replace polling with **Dome WebSocket** (`wss://ws.domeapi.io/<API_KEY>`), which pushes order events in real-time for any wallet address.

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                     NEW MONITORING FLOW                       │
│                                                               │
│  Dome WebSocket Server                                        │
│  wss://ws.domeapi.io/<key>                                    │
│         │                                                     │
│         │  subscribe: { users: [wallet1, wallet2, ...] }      │
│         │                                                     │
│         ▼                                                     │
│  ┌─────────────────┐                                          │
│  │ DomeWSMonitor   │  ◀── NEW file: src/domeWebSocket.ts      │
│  │ (event-driven)  │                                          │
│  └────────┬────────┘                                          │
│           │                                                   │
│           │  on trade event: { token_id, side, price,         │
│           │    shares, user, tx_hash, market_slug, ... }      │
│           │                                                   │
│           ▼                                                   │
│  ┌─────────────────┐                                          │
│  │   CopyTrader    │  ◀── existing, unchanged                 │
│  │  (orchestrator) │                                          │
│  └─────────────────┘                                          │
│                                                               │
│  ┌─────────────────┐                                          │
│  │ WalletMonitor   │  ◀── kept as FALLBACK (polling)          │
│  │ (5s polling)    │      activates if WS disconnects         │
│  └─────────────────┘                                          │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Decisions
- **Polling stays as fallback.** If the WebSocket disconnects, we auto-switch back to polling and log a warning.
- **Subscription management.** When wallets are added/removed in the UI, we send subscribe/unsubscribe messages to update the live connection.
- **Deduplication still applies.** The existing tx_hash + compound key dedup logic in `copyTrader.ts` prevents double-execution.

### Dome WebSocket Event Format (what we receive)
```json
{
  "type": "event",
  "subscription_id": "sub_gq5c3resmrq",
  "data": {
    "token_id": "80311845198...",
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

### Actionable Steps

| # | Task | Effort | Owner |
|---|---|---|---|
| 1.1 | Install `@dome-api/sdk` and `ws` dependency (ws already installed) | 1 hr | — |
| 1.2 | Create `src/domeWebSocket.ts` — WebSocket connection manager with auto-reconnect | 4 hrs | — |
| 1.3 | Map Dome event format → existing `DetectedTrade` type | 2 hrs | — |
| 1.4 | Wire `domeWebSocket.ts` into `copyTrader.ts` as primary monitor | 3 hrs | — |
| 1.5 | Add fallback logic: WS disconnect → activate polling, WS reconnect → deactivate polling | 2 hrs | — |
| 1.6 | Add "Monitoring Mode" indicator to Dashboard (WS vs Polling) | 1 hr | — |
| 1.7 | Update wallet add/remove to send subscribe/unsubscribe messages | 2 hrs | — |
| 1.8 | Add WS connection health to Diagnostics tab | 1 hr | — |

**Total estimate:** ~16 hours  
**Goal:** Reduce trade detection latency from ~5 seconds to **<500ms**.

---

## 5. Feature 2: Wallet Entity Linking

### Problem
A sophisticated trader may operate multiple wallets across Polymarket and even hold positions on Kalshi. Currently, we track each Polymarket wallet independently with no awareness that:
- `0xABC...` and `0xDEF...` might be the same person
- That person might also be active on Kalshi
- They might be hedging across platforms (buying YES on Polymarket, NO on Kalshi for the same event)

### Solution
Introduce an **Entity** concept that groups wallets under a single identity.

### Data Model

```
┌─────────────────────────────────────────────────────────┐
│                    ENTITY MODEL                          │
│                                                          │
│  Entity: "Whale_42"                                      │
│  ├── Polymarket Wallet: 0xABC... (label: "Main")        │
│  ├── Polymarket Wallet: 0xDEF... (label: "Alt")         │
│  └── Kalshi Username: "bigtrader99" (read-only/observe)  │
│                                                          │
│  Aggregated view:                                        │
│  - Combined positions across all wallets                 │
│  - Net exposure per market (are they hedging?)           │
│  - Total portfolio value across platforms                │
│  - Cross-platform activity timeline                      │
└─────────────────────────────────────────────────────────┘
```

### Storage (extends `tracked_wallets.json`)

```json
{
  "entities": [
    {
      "id": "entity_001",
      "label": "Whale 42",
      "wallets": [
        {
          "address": "0xABC...",
          "platform": "polymarket",
          "active": true,
          "label": "Main wallet"
        },
        {
          "address": "0xDEF...",
          "platform": "polymarket",
          "active": true,
          "label": "Alt wallet"
        }
      ],
      "notes": "Suspected same entity — similar trading patterns on BTC markets"
    }
  ]
}
```

### Hedge Detection Logic

```
For each entity:
  1. Fetch all positions across all linked wallets
     - Polymarket: via Dome GET /polymarket/positions/wallet/{addr}
     - Kalshi: manual observation (no wallet-level position API yet)

  2. Use Dome Matching Markets API to find cross-platform equivalents
     - GET /matching-markets/sports?polymarket_market_slug=X
     - Returns Kalshi event_ticker for the same event

  3. Compare positions:
     - If Entity holds YES on Polymarket AND NO on Kalshi for same event → HEDGING
     - If Entity holds YES on both → DOUBLING DOWN
     - If Entity holds opposing sides on same platform → REDUCING EXPOSURE

  4. Display net exposure in the UI per entity
```

### UI Changes (Wallets Tab Extension)

The existing Wallets tab gets a new section at the top: **Entity Groups**. Individual wallets that aren't assigned to an entity continue to appear in the existing wallet list below, unchanged.

```
┌──────────────────────────────────────────────────────┐
│  WALLETS TAB                                          │
│                                                       │
│  ┌────────────────────────────────────────────────┐   │
│  │  Entity Groups                    [+ New Group] │  │
│  │                                                 │  │
│  │  ┌─────────────────────────────────────────┐    │  │
│  │  │ 👤 Whale 42              ▼ expand       │    │  │
│  │  │  Wallets: 0xABC..(Main), 0xDEF..(Alt)  │    │  │
│  │  │  Net Exposure: +$2,400 YES on BTC>100k  │    │  │
│  │  │  Hedge Alert: ⚠ Opposing position on    │    │  │
│  │  │               Kalshi KXBTC-100K         │    │  │
│  │  └─────────────────────────────────────────┘    │  │
│  │                                                 │  │
│  │  ┌─────────────────────────────────────────┐    │  │
│  │  │ 👤 Sports Bettor         ▼ expand       │    │  │
│  │  │  Wallets: 0x123..(NFL focus)            │    │  │
│  │  │  Net Exposure: $800 across 3 NFL games  │    │  │
│  │  └─────────────────────────────────────────┘    │  │
│  └────────────────────────────────────────────────┘   │
│                                                       │
│  ── Ungrouped Wallets ──────────────────────────────  │
│  (existing wallet list, unchanged)                    │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Actionable Steps

| # | Task | Effort | Owner |
|---|---|---|---|
| 2.1 | Design entity data model, extend `types.ts` | 2 hrs | — |
| 2.2 | Add entity CRUD to `storage.ts` (new file: `data/entities.json`) | 3 hrs | — |
| 2.3 | Build entity API endpoints (CRUD + "link wallet to entity") | 4 hrs | — |
| 2.4 | Integrate Dome Matching Markets API for cross-platform lookups | 3 hrs | — |
| 2.5 | Build hedge detection logic (compare positions across entity wallets) | 4 hrs | — |
| 2.6 | Add Entity Groups section to Wallets tab UI | 4 hrs | — |
| 2.7 | Add "assign to entity" option on each individual wallet card | 1 hr | — |
| 2.8 | Display net exposure and hedge alerts per entity | 3 hrs | — |

**Total estimate:** ~24 hours  
**Goal:** Identify when tracked wallets are the same person and detect cross-platform hedging.

---

## 6. Feature 3: Cross-Platform Arbitrage Detection & Auto-Execute

### Problem
The same event can have different prices on Polymarket vs Kalshi. For example:
- "Chiefs win Super Bowl" — YES at $0.52 on Polymarket, YES at $0.48 on Kalshi
- That's a 4-cent spread — a potential arbitrage opportunity

Currently, we have no way to detect or act on these opportunities.

### Solution
A background scanner that:
1. Uses **Dome Matching Markets** to find equivalent events across platforms
2. Compares prices using **Dome Market Price** endpoints for both platforms
3. Calculates arbitrage opportunity (spread, potential profit, risk level)
4. Optionally **auto-executes** when spread exceeds a configurable threshold

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   ARBITRAGE ENGINE                            │
│                                                               │
│  ┌──────────────────┐     ┌───────────────────┐              │
│  │ ArbScanner        │────▶│ Dome Matching     │              │
│  │ (runs every 30s)  │     │ Markets API       │              │
│  └──────┬───────────┘     └───────────────────┘              │
│         │                                                     │
│         │ For each matched pair:                              │
│         │                                                     │
│         ▼                                                     │
│  ┌──────────────────┐     ┌───────────────────┐              │
│  │ Price Comparator  │────▶│ Dome Price APIs   │              │
│  │                   │     │ Polymarket + Kalshi│             │
│  └──────┬───────────┘     └───────────────────┘              │
│         │                                                     │
│         │ If spread > threshold:                              │
│         │                                                     │
│         ▼                                                     │
│  ┌──────────────────┐                                         │
│  │ ArbOpportunity   │──▶ Dashboard notification               │
│  │ {                │──▶ Auto-execute (if enabled)             │
│  │  market, polyPx, │                                         │
│  │  kalshiPx, spread│                                         │
│  │  direction, size │                                         │
│  │ }                │                                         │
│  └──────────────────┘                                         │
└─────────────────────────────────────────────────────────────┘
```

### Arbitrage Calculation

```
Example: "Chiefs win Super Bowl"
  Polymarket YES: $0.52
  Kalshi YES:     $0.48 (= 48 cents per contract)

  Arbitrage play:
    Buy YES on Kalshi @ $0.48
    Buy NO on Polymarket @ $0.48 (= 1 - 0.52)

  Cost: $0.48 + $0.48 = $0.96 per contract pair
  Guaranteed payout: $1.00 (one side always wins)
  Profit: $0.04 per contract (4.2% return)

  At 100 contracts: $4.00 profit, $96 cost
```

### Settings (added to Settings tab)

```
┌──────────────────────────────────────────────────────┐
│  ARBITRAGE SETTINGS (new section in Settings tab)     │
│                                                       │
│  ☑ Enable Arbitrage Scanner                           │
│                                                       │
│  Scan Interval:        [ 30 ] seconds                 │
│  Min Spread Threshold: [ 3  ] %                       │
│  Max Position Size:    [ 500 ] USDC                   │
│                                                       │
│  ☐ Auto-Execute Trades (when spread > threshold)      │
│    └─ Requires Kalshi API credentials                 │
│                                                       │
│  Notification: ☑ Dashboard Alert  ☐ Webhook           │
└──────────────────────────────────────────────────────┘
```

### Important Limitation: Kalshi Execution

Dome's Order Router currently supports **Polymarket only**. For Kalshi, execution options are:

| Option | Status |
|---|---|
| Dome Order Router (Polymarket side) | Available now |
| Kalshi Direct API | Requires separate Kalshi API integration |
| Manual execution with alert | Available now (alert only) |

**Recommendation for Phase 1:** Alert-only for Kalshi side. Auto-execute on Polymarket side only via Dome Order Router or existing CLOB client. Add Kalshi execution in a later phase.

### Dashboard UI — New "Arbitrage" Panel

Added as a card on the existing Dashboard tab, below the metrics grid:

```
┌──────────────────────────────────────────────────────┐
│  DASHBOARD TAB (existing layout)                      │
│                                                       │
│  [Wallet Balance Card]                                │
│  [Metrics Grid - 6 cards]                             │
│  [Recent Trades Table]                                │
│                                                       │
│  ── NEW: Arbitrage Opportunities ────────────────── ▼ │
│                                                       │
│  ┌────────────────────────────────────────────────┐   │
│  │  🔴 LIVE  Scanning 24 matched markets          │   │
│  │                                                 │  │
│  │  Market           Poly   Kalshi  Spread  Action │  │
│  │  ─────────────────────────────────────────────  │  │
│  │  Chiefs SB YES    $0.52  $0.48   4.0%   [Arb]  │  │
│  │  BTC>100k YES     $0.61  $0.58   3.1%   [Arb]  │  │
│  │  NYC Mayor DEM    $0.89  $0.86   3.0%   [Arb]  │  │
│  │                                                 │  │
│  │  Showing opportunities with spread > 3%         │  │
│  └────────────────────────────────────────────────┘   │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Actionable Steps

| # | Task | Effort | Owner |
|---|---|---|---|
| 3.1 | Create `src/arbScanner.ts` — periodic cross-platform price scanner | 6 hrs | — |
| 3.2 | Integrate Dome Matching Markets + Market Price APIs | 4 hrs | — |
| 3.3 | Build arbitrage calculation engine (spread, direction, profit) | 4 hrs | — |
| 3.4 | Add arb opportunity storage (`data/arb_opportunities.json`) | 2 hrs | — |
| 3.5 | Create API endpoints for arb data + settings | 3 hrs | — |
| 3.6 | Build Arbitrage Opportunities card on Dashboard | 4 hrs | — |
| 3.7 | Add Arbitrage Settings section to Settings tab | 2 hrs | — |
| 3.8 | Implement auto-execute for Polymarket side (via existing CLOB or Dome Router) | 6 hrs | — |
| 3.9 | Add arb execution history to trade log | 2 hrs | — |

**Total estimate:** ~33 hours  
**Goal:** Surface arbitrage opportunities between Polymarket and Kalshi, with optional one-click or auto-execution on Polymarket side.

---

## 7. Feature 4: One-Click Hedge Execution

### Problem
When a tracked wallet takes a large position, we may want to hedge our risk by simultaneously taking the opposite position on another platform. Currently this requires manually going to another platform and placing a trade.

### Solution
A **"Hedge This"** button that appears on any active position, which:
1. Finds the equivalent market on the other platform (via Dome Matching Markets)
2. Shows the hedge price and cost
3. Executes trades on BOTH platforms with a single click

### How It Works

```
User sees position: YES on "Chiefs SB" @ $0.52 (100 shares) on Polymarket
                            ↓
Clicks [Hedge] button
                            ↓
┌───────────────────────────────────────────────┐
│  HEDGE PREVIEW MODAL                           │
│                                                │
│  Current Position:                             │
│    Polymarket: 100 shares YES @ $0.52          │
│    Exposure: $52.00                            │
│                                                │
│  Hedge Options:                                │
│  ┌───────────────────────────────────────────┐ │
│  │ ○ Full Hedge (100%)                       │ │
│  │   Buy 100 NO on Kalshi @ $0.51            │ │
│  │   Cost: $51.00  |  Max Loss: $3.00        │ │
│  │   Guaranteed Profit: $-3 to +$48          │ │
│  ├───────────────────────────────────────────┤ │
│  │ ○ Partial Hedge (50%)                     │ │
│  │   Buy 50 NO on Kalshi @ $0.51             │ │
│  │   Cost: $25.50  |  Reduced exposure       │ │
│  ├───────────────────────────────────────────┤ │
│  │ ○ Cross-Platform Hedge                    │ │
│  │   Sell 50 YES on Polymarket @ $0.52       │ │
│  │   Buy 50 NO on Kalshi @ $0.51             │ │
│  │   Net cost: ~$0.50                        │ │
│  └───────────────────────────────────────────┘ │
│                                                │
│  [Cancel]                    [Execute Hedge]   │
└───────────────────────────────────────────────┘
```

### Execution Flow

```
User clicks [Execute Hedge]
        │
        ├──▶ Polymarket trade (if needed): via existing CLOB client
        │    or Dome Order Router
        │
        └──▶ Kalshi trade: via Kalshi API (Phase 2)
             or alert user to place manually (Phase 1)

Both trades fire in parallel where possible.
Result shown in trade log with "HEDGE" tag.
```

### Where It Appears in the UI

The Hedge button shows up in two places (no new tabs needed):

1. **Recent Trades table** — a small [Hedge] button in the Action column for active positions
2. **Position Mirror preview** — alongside the existing mirror functionality

```
  Recent Trades
  ──────────────────────────────────────────────────────────
  Time     Wallet     Market          Side   Amount  Status   Action
  14:32    0xABC..    Chiefs SB YES   BUY    $52     ✓ Done   [Hedge]
  14:28    0xDEF..    BTC>100k YES    BUY    $120    ✓ Done   [Hedge]
  14:15    0xABC..    NYC Mayor       SELL   $30     ✓ Done   —
```

### Actionable Steps

| # | Task | Effort | Owner |
|---|---|---|---|
| 4.1 | Build hedge calculation engine (`src/hedgeCalculator.ts`) | 4 hrs | — |
| 4.2 | Integrate Dome Matching Markets for finding equivalent markets | 2 hrs | — |
| 4.3 | Build hedge preview API endpoint (`POST /api/hedge/preview`) | 3 hrs | — |
| 4.4 | Build hedge execution API endpoint (`POST /api/hedge/execute`) | 4 hrs | — |
| 4.5 | Create hedge preview modal in UI (vanilla JS modal) | 4 hrs | — |
| 4.6 | Add [Hedge] button to recent trades table + position mirror | 2 hrs | — |
| 4.7 | Track hedge pairs in storage (link original trade to hedge trade) | 2 hrs | — |
| 4.8 | Add "HEDGE" tag to trade log entries | 1 hr | — |

**Total estimate:** ~22 hours  
**Goal:** Allow users to hedge any position across platforms with a single click, seeing full cost/profit breakdown before executing.

---

## 8. Feature 5: Ladder Exit Strategy

### Problem
When a copied position moves into profit, there's no automated way to take profits at multiple price levels. The user has to manually monitor and sell. This leads to either selling too early or riding profits back down.

### Solution
An automated **ladder exit** system that places sell orders at ascending price levels.

### How It Works

```
Example: Bought 100 shares YES @ $0.50

Ladder Configuration:
  Level 1: Sell 25 shares when price hits $0.60 (20% gain)
  Level 2: Sell 25 shares when price hits $0.70 (40% gain)  
  Level 3: Sell 25 shares when price hits $0.80 (60% gain)
  Level 4: Sell 25 shares when price hits $0.90 (80% gain)

As each price level is reached, the system automatically places a sell order.
```

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   LADDER EXIT MANAGER                     │
│                                                           │
│  ┌──────────────┐                                         │
│  │ Price Monitor │  ◀── Uses Dome Market Price API        │
│  │ (every 10s)  │      or Dome WebSocket price feed       │
│  └──────┬───────┘                                         │
│         │                                                 │
│         │ Check each active ladder:                       │
│         │   current_price >= level_N_trigger?             │
│         │                                                 │
│         ▼                                                 │
│  ┌──────────────┐     ┌──────────────┐                    │
│  │ Level Hit!   │────▶│ Trade        │                    │
│  │ Sell X shares│     │ Executor     │                    │
│  └──────────────┘     └──────────────┘                    │
│                                                           │
│  Status tracking per ladder:                              │
│    Level 1: ✓ FILLED @ $0.60 — sold 25, profit $2.50     │
│    Level 2: ✓ FILLED @ $0.70 — sold 25, profit $5.00     │
│    Level 3: ⏳ WAITING (current: $0.67)                   │
│    Level 4: ⏳ WAITING                                    │
└──────────────────────────────────────────────────────────┘
```

### UI — Ladder Setup (appears on each position)

When the user clicks on an active position in the trades table, they can configure an exit ladder:

```
┌──────────────────────────────────────────────────────┐
│  EXIT LADDER — Chiefs SB YES (100 shares @ $0.50)     │
│                                                       │
│  ☑ Enable Ladder Exit                                 │
│                                                       │
│  Preset: [ Even Split (4 levels) ▼ ]                  │
│                                                       │
│  Level   Trigger Price   Shares to Sell   Status      │
│  ─────────────────────────────────────────────────    │
│  1       [ $0.60 ]       [ 25 ]           ⏳ Waiting  │
│  2       [ $0.70 ]       [ 25 ]           ⏳ Waiting  │
│  3       [ $0.80 ]       [ 25 ]           ⏳ Waiting  │
│  4       [ $0.90 ]       [ 25 ]           ⏳ Waiting  │
│                                   [+ Add Level]       │
│                                                       │
│  Total shares in ladder: 100/100                      │
│  Expected avg exit price: $0.75                       │
│  Expected profit: $25.00 (50% return)                 │
│                                                       │
│  [Cancel]                         [Activate Ladder]   │
└──────────────────────────────────────────────────────┘
```

### Presets

| Preset | Description |
|---|---|
| Even Split (4 levels) | Equal shares at +20%, +40%, +60%, +80% from entry |
| Aggressive (2 levels) | 50% at +30%, 50% at +60% |
| Conservative (6 levels) | Small sells every +10% from entry |
| Custom | User defines all levels manually |

### Actionable Steps

| # | Task | Effort | Owner |
|---|---|---|---|
| 5.1 | Create `src/ladderExitManager.ts` — core ladder logic | 6 hrs | — |
| 5.2 | Build price monitoring loop using Dome Market Price API | 3 hrs | — |
| 5.3 | Connect ladder trigger to existing trade executor for sell orders | 3 hrs | — |
| 5.4 | Add ladder storage (`data/active_ladders.json`) | 2 hrs | — |
| 5.5 | Create API endpoints for ladder CRUD | 3 hrs | — |
| 5.6 | Build ladder setup UI (modal on position click) | 5 hrs | — |
| 5.7 | Add ladder status indicators to trades table | 2 hrs | — |
| 5.8 | Implement preset configurations | 2 hrs | — |
| 5.9 | Add ladder execution events to trade log with "LADDER" tag | 1 hr | — |

**Total estimate:** ~27 hours  
**Goal:** Automated profit-taking at configurable price levels, reducing the need for manual position monitoring.

---

## 9. Feature 6: Smart Stop-Loss

### Problem
The current stop-loss is a simple "max USDC committed" check — it blocks new trades when too much capital is deployed. It doesn't:
- Adapt based on position performance
- Calculate optimal exit points based on entry price and market conditions
- Allow per-position stop-losses (only global)

### Solution
A **recovery-based smart stop-loss** that calculates dynamic stop levels per position based on entry price, current price, and configurable recovery parameters.

### How It Works

```
Traditional stop-loss: "Sell if price drops below $X"

Smart stop-loss: "Sell if my expected recovery drops below threshold"

Calculation:
  entry_price = $0.50
  current_price = $0.42
  loss_so_far = ($0.50 - $0.42) / $0.50 = 16%
  
  recovery_needed = loss / (1 - loss) = 0.16 / 0.84 = 19%
  (need 19% gain from current price to break even)
  
  If recovery_needed > max_recovery_threshold (e.g., 25%):
    → Allow, position is still recoverable
  
  If recovery_needed > critical_threshold (e.g., 50%):
    → TRIGGER STOP LOSS — recovery is unlikely

Dynamic trailing:
  If position reaches +20% profit from entry:
    → Move stop-loss to break-even (lock in entry price)
  If position reaches +40% profit:
    → Move stop-loss to +20% (lock in partial profit)
```

### Configuration (per-wallet or global)

```
┌──────────────────────────────────────────────────────┐
│  SMART STOP-LOSS (new section in Settings tab)        │
│                                                       │
│  ☑ Enable Smart Stop-Loss                             │
│                                                       │
│  Mode: ( ○ Global  ● Per-Position )                   │
│                                                       │
│  Max Recovery Threshold: [ 50 ] %                     │
│  (trigger stop if recovery needed exceeds this)       │
│                                                       │
│  ☑ Enable Trailing Stop                               │
│    Activation:  [ 20 ] % profit from entry            │
│    Trail Size:  [ 10 ] % below peak                   │
│                                                       │
│  ☑ Lock-In Levels                                     │
│    At +20% profit → stop moves to break-even          │
│    At +40% profit → stop moves to +20%                │
│    At +60% profit → stop moves to +40%                │
│                                                       │
│  Daily Loss Limit: [ 100 ] USDC                       │
│  (pause all trading if daily losses exceed this)      │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Dashboard — Position Health Indicators

Each position in the trades table gets a small visual indicator:

```
  Recent Trades
  ──────────────────────────────────────────────────────────────
  Time     Market          Side   Entry  Current  Health   Stop
  14:32    Chiefs SB YES   BUY    $0.52  $0.58    🟢 +12%  $0.52
  14:28    BTC>100k YES    BUY    $0.61  $0.55    🟡 -10%  $0.48
  14:15    NYC Mayor DEM   BUY    $0.88  $0.71    🔴 -19%  $0.65
```

- 🟢 Green: In profit or within 10% of entry
- 🟡 Yellow: 10-25% recovery needed
- 🔴 Red: >25% recovery needed, approaching stop trigger

### Actionable Steps

| # | Task | Effort | Owner |
|---|---|---|---|
| 6.1 | Create `src/smartStopLoss.ts` — recovery-based stop calculation engine | 5 hrs | — |
| 6.2 | Build trailing stop logic (track peak price per position) | 3 hrs | — |
| 6.3 | Build lock-in level manager (move stops up as profit grows) | 3 hrs | — |
| 6.4 | Integrate with price monitoring (shared with ladder exit) | 2 hrs | — |
| 6.5 | Add stop-loss trigger → sell execution path | 3 hrs | — |
| 6.6 | Add per-position stop data to storage | 2 hrs | — |
| 6.7 | Build Smart Stop-Loss settings UI section | 3 hrs | — |
| 6.8 | Add health indicators to trades table | 2 hrs | — |
| 6.9 | Add daily loss limit with auto-pause | 2 hrs | — |
| 6.10 | Add stop-loss events to trade log with "STOP" tag | 1 hr | — |

**Total estimate:** ~26 hours  
**Goal:** Dynamic, intelligent stop-loss that adapts to position performance instead of using static limits.

---

## 10. UI Mockups

### 10.1 Updated Dashboard Tab

The dashboard keeps its existing layout. New elements are appended below the existing content.

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
│  │  Monitoring: 🟢 WebSocket (Dome)  Latency: <100ms     │   │ ◀── NEW
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐  ┌────┐            │
│  │98% │  │ 47 │  │82ms│  │ 5  │  │ 46 │  │ 1  │            │
│  │Succ│  │Trd │  │Lat │  │Wlt │  │Pass│  │Fail│            │
│  └────┘  └────┘  └────┘  └────┘  └────┘  └────┘            │
│                                                              │
│  ┌─ Recent Trades ───────────────────────────────────────┐   │
│  │ Time   Wallet   Market        Side  Amt    Hlth  Act  │   │
│  │ 14:32  0xABC..  Chiefs YES    BUY   $52    🟢    [H]  │   │ ◀── Health + Hedge btn
│  │ 14:28  0xDEF..  BTC>100k YES  BUY   $120   🟡    [H]  │   │
│  │ 14:15  0xABC..  NYC Mayor     SELL  $30    —     —    │   │
│  │ 14:02  [ARB]    Chiefs YES    BUY   $96    —     —    │   │ ◀── Arb trade tagged
│  │ 13:55  [LADDER] BTC>80k YES   SELL  $25    —     —    │   │ ◀── Ladder exit tagged
│  │ 13:41  [STOP]   ETH>5k YES   SELL  $80    —     —    │   │ ◀── Stop-loss tagged
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Arbitrage Opportunities ──────────────── 🔴 LIVE ────┐   │ ◀── NEW section
│  │ Market           Polymarket  Kalshi  Spread  Action    │   │
│  │ Chiefs SB YES    $0.52       $0.48   4.0%    [Arb]     │   │
│  │ BTC>100k YES     $0.61       $0.58   3.1%    [Arb]     │   │
│  │ NYC Mayor DEM    $0.89       $0.86   3.0%    [Arb]     │   │
│  │                                                        │   │
│  │ Scanning 24 matched markets • Last scan: 12s ago       │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Active Ladders ──────────────────────────────────────┐   │ ◀── NEW section
│  │ Position           Entry   Current  Next Level  Prog  │   │
│  │ BTC>100k YES       $0.50   $0.67    $0.70 (L3)  ██░  │   │
│  │ Chiefs SB YES      $0.40   $0.52    $0.55 (L2)  █░░  │   │
│  │                                                       │   │
│  │ 2 active ladders • 5 levels filled today              │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Performance Chart ───────────────────────────────────┐   │
│  │ (existing Chart.js chart, unchanged)                  │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 10.2 Updated Wallets Tab

```
┌──────────────────────────────────────────────────────────────┐
│  Dashboard | Wallets | Settings | Diagnostics                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ Entity Groups ───────────────────── [+ New Group] ───┐   │ ◀── NEW section
│  │                                                        │   │
│  │  ┌ 👤 Whale 42 ──────────────────── [Edit] [Delete] ┐ │   │
│  │  │ Wallets: 0xABC.. (Main), 0xDEF.. (Alt)            │ │   │
│  │  │ Combined Value: $2,847                             │ │   │
│  │  │ Net Exposure: +$2,400 YES on BTC>100k              │ │   │
│  │  │ ⚠ HEDGE DETECTED: Opposing position on Kalshi      │ │   │
│  │  │   Kalshi KXBTC-100K-YES vs Poly BTC>100k-NO       │ │   │
│  │  └────────────────────────────────────────────────────┘ │   │
│  │                                                        │   │
│  │  ┌ 👤 Sports Bettor ──────────────── [Edit] [Delete] ┐ │   │
│  │  │ Wallets: 0x123.. (NFL focus)                       │ │   │
│  │  │ Combined Value: $1,200                             │ │   │
│  │  │ Active in 3 NFL markets                            │ │   │
│  │  └────────────────────────────────────────────────────┘ │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
│  ── Tracked Wallets ──────────────────── [+ Add Wallet] ──   │
│                                                              │
│  (existing wallet list, completely unchanged)                 │
│  Each wallet card now has: [Assign to Group ▼] option        │ ◀── Small addition
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 10.3 Updated Settings Tab

```
┌──────────────────────────────────────────────────────────────┐
│  Dashboard | Wallets | Settings | Diagnostics                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ General Settings ────────────────────────────────────┐   │
│  │ (existing: trade size, interval, slippage, etc.)      │   │
│  │ (UNCHANGED)                                           │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Dome API ────────────────────────────────────────────┐   │ ◀── NEW
│  │ API Key: [••••••••••••••••]          Status: 🟢 Active │   │
│  │ Tier: Dev (100 QPS)                                   │   │
│  │ WebSocket: [● Connected]  Subscriptions: 5/500        │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Arbitrage Settings ──────────────────────────────────┐   │ ◀── NEW
│  │ ☑ Enable Arbitrage Scanner                            │   │
│  │ Scan Interval: [30]s  |  Min Spread: [3]%            │   │
│  │ Max Position: [$500]  |  ☐ Auto-Execute               │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Smart Stop-Loss ────────────────────────────────────┐   │ ◀── NEW
│  │ ☑ Enable Smart Stop-Loss                              │   │
│  │ Mode: (○ Global  ● Per-Position)                      │   │
│  │ Max Recovery: [50]%  |  ☑ Trailing Stop               │   │
│  │ Trail Activation: [20]% profit                        │   │
│  │ Trail Size: [10]% below peak                          │   │
│  │ Daily Loss Limit: [$100]                              │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Ladder Defaults ────────────────────────────────────┐   │ ◀── NEW
│  │ ☐ Auto-create ladder on every copied trade            │   │
│  │ Default Preset: [Even Split (4 levels) ▼]             │   │
│  │ Default first level: [+20]% from entry                │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 10.4 Updated Diagnostics Tab

```
┌──────────────────────────────────────────────────────────────┐
│  Dashboard | Wallets | Settings | Diagnostics                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  (existing diagnostics: API status, RPC, config, rate limit) │
│  (UNCHANGED)                                                 │
│                                                              │
│  ┌─ Dome API Health ────────────────────────────────────┐   │ ◀── NEW
│  │ REST API:    🟢 Connected  (latency: 45ms)            │   │
│  │ WebSocket:   🟢 Connected  (uptime: 4h 32m)           │   │
│  │ Subscriptions: 5 active / 500 limit                   │   │
│  │ QPS Used:    23 / 100 limit                           │   │
│  │ Last Event:  2 seconds ago                            │   │
│  │                                                       │   │
│  │ Order Router: 🟢 Available                             │   │
│  │ Matching Markets Cache: 24 pairs (updated 2m ago)     │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Arb Scanner Status ─────────────────────────────────┐   │ ◀── NEW
│  │ Status: 🟢 Running  |  Last Scan: 12s ago             │   │
│  │ Markets Scanned: 24  |  Opportunities Found: 3        │   │
│  │ Auto-Execute: Disabled                                │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Active Managers ────────────────────────────────────┐   │ ◀── NEW
│  │ Ladder Exit Manager: 🟢 2 active ladders              │   │
│  │ Smart Stop-Loss: 🟢 Monitoring 5 positions            │   │
│  │ Next price check: 3s                                  │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 11. Implementation Phases & Timeline

### Phase 1: Foundation (Weeks 1-2)
**Goal:** Get Dome integrated and real-time monitoring working.

| Task | Feature | Est. Hours |
|---|---|---|
| Set up Dome API account and SDK | All | 2 |
| Create `src/domeClient.ts` — shared Dome API wrapper | All | 4 |
| Feature 1: WebSocket Real-Time Monitoring | WS | 16 |
| **Phase 1 Total** | | **22 hrs** |

**Deliverable:** Bot uses Dome WebSocket for sub-second trade detection. Polling is fallback. Dome API health visible in Diagnostics.

---

### Phase 2: Intelligence (Weeks 3-4)
**Goal:** Cross-platform awareness and entity linking.

| Task | Feature | Est. Hours |
|---|---|---|
| Feature 2: Wallet Entity Linking | Entity | 24 |
| Feature 3: Arb Scanner (detection only, no auto-exec) | Arb | 20 |
| **Phase 2 Total** | | **44 hrs** |

**Deliverable:** Users can group wallets into entities. Arbitrage opportunities between Polymarket and Kalshi surface on the dashboard. Hedge alerts appear when entity wallets take opposing positions.

---

### Phase 3: Execution (Weeks 5-6)
**Goal:** Automated trading features.

| Task | Feature | Est. Hours |
|---|---|---|
| Feature 3 continued: Auto-execute arbitrage | Arb | 13 |
| Feature 4: One-Click Hedge Execution | Hedge | 22 |
| **Phase 3 Total** | | **35 hrs** |

**Deliverable:** One-click hedging works for Polymarket side. Arb trades can auto-execute on Polymarket. Kalshi side shows manual instructions (Kalshi API integration is Phase 4+).

---

### Phase 4: Position Management (Weeks 7-8)
**Goal:** Automated exit strategies and risk management.

| Task | Feature | Est. Hours |
|---|---|---|
| Feature 5: Ladder Exit Strategy | Ladder | 27 |
| Feature 6: Smart Stop-Loss | Stop-Loss | 26 |
| Shared price monitoring infrastructure | Both | 4 |
| **Phase 4 Total** | | **57 hrs** |

**Deliverable:** Full position lifecycle management — from copy trade entry, through ladder profit-taking, to smart stop-loss exit.

---

### Summary

| Phase | Duration | Hours | Features |
|---|---|---|---|
| Phase 1: Foundation | Weeks 1-2 | 22 hrs | Dome integration, WebSocket monitoring |
| Phase 2: Intelligence | Weeks 3-4 | 44 hrs | Entity linking, arb detection |
| Phase 3: Execution | Weeks 5-6 | 35 hrs | Auto-arb, one-click hedge |
| Phase 4: Position Mgmt | Weeks 7-8 | 57 hrs | Ladder exits, smart stop-loss |
| **TOTAL** | **~8 weeks** | **~158 hrs** | All 6 features |

---

## 12. Technical Dependencies

### New NPM Packages

| Package | Purpose | Status |
|---|---|---|
| `@dome-api/sdk` | Dome REST API + Order Router | Install needed |
| `ws` | WebSocket client | Already installed |

### External Services

| Service | Purpose | Action Required |
|---|---|---|
| Dome API (Dev tier) | All cross-platform features | Sign up, get API key, evaluate pricing |
| Kalshi API | Direct Kalshi execution (Phase 4+) | Future investigation |

### New Source Files

```
src/
├── domeClient.ts           ◀── Shared Dome API wrapper (REST)
├── domeWebSocket.ts        ◀── Dome WebSocket connection manager
├── arbScanner.ts           ◀── Cross-platform arbitrage scanner
├── hedgeCalculator.ts      ◀── Hedge calculation and execution
├── ladderExitManager.ts    ◀── Ladder exit strategy manager
├── smartStopLoss.ts        ◀── Recovery-based stop-loss engine
└── entityManager.ts        ◀── Wallet entity linking logic

data/
├── entities.json           ◀── Entity groups
├── arb_opportunities.json  ◀── Current arb opportunities
├── active_ladders.json     ◀── Active exit ladders
└── stop_loss_config.json   ◀── Per-position stop-loss state
```

### Modified Existing Files

| File | Changes |
|---|---|
| `src/types.ts` | New types: Entity, ArbOpportunity, LadderConfig, StopLossConfig |
| `src/copyTrader.ts` | Wire in DomeWSMonitor as primary, auto-create ladders if configured |
| `src/api/routes.ts` | New endpoints for entities, arb, hedge, ladder, stop-loss |
| `src/config.ts` | New config fields for Dome, arb, ladder, stop-loss settings |
| `src/storage.ts` | Entity CRUD, ladder/stop-loss persistence |
| `public/index.html` | New dashboard sections, hedge modal, ladder modal |
| `public/js/app.js` | New UI logic for all features |
| `public/styles.css` | Styling for new components |
| `.env` | DOME_API_KEY |

---

## 13. Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Dome API goes down | WS monitoring fails | Medium | Polling fallback (existing walletMonitor) |
| Dome API tier costs too high | Feature gating | Low | Free tier works for basic features, only WS + arb need Dev |
| Kalshi API changes or access restricted | Can't execute on Kalshi | Medium | Phase 1-3 are Polymarket-only execution. Kalshi is read-only initially |
| Arbitrage spreads too thin after fees | Arb not profitable | Medium | Min spread threshold is configurable. Show fee-adjusted profits |
| Matching Markets coverage incomplete | Some events not matched | Medium | Matching Markets API currently supports sports. Non-sports matching may need manual mapping |
| Smart stop-loss triggers too aggressively | Premature exits | Low | Conservative defaults. Per-position overrides. Easy to disable |
| WebSocket message volume too high | Performance issues | Low | Dome Dev tier limits (500 subscriptions). Message batching in our handler |

---

## 14. Open Questions

1. **Dome API Pricing:** What does the Dev tier cost? Need this before committing to WebSocket and arb features.

2. **Kalshi Direct Execution:** Dome Order Router only supports Polymarket currently. When will Kalshi support be added? Do we integrate Kalshi's API directly in the meantime?

3. **Matching Markets Beyond Sports:** The Dome matching markets API currently covers sports. How do we match political, crypto, and other markets? Options:
   - Wait for Dome to expand matching
   - Build our own matching logic (string similarity on market titles)
   - Manual mapping by users

4. **Database Migration:** JSON files will struggle with arb opportunity history and ladder state at scale. Should we plan a SQLite migration alongside this work?

5. **Multi-User Support:** Current system is single-user. Entity linking and hedge execution imply richer state. Is multi-user support on the roadmap?

6. **Notification System:** Should arb alerts and stop-loss triggers send notifications beyond the dashboard? (Telegram, Discord, email, webhook?)

---

## Appendix A: Dome API Endpoint Reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/polymarket/markets` | GET | Search/list Polymarket markets |
| `/polymarket/positions/wallet/{addr}` | GET | Get wallet positions |
| `/polymarket/wallet/pnl/{addr}` | GET | Wallet profit and loss |
| `/polymarket/market-price` | GET | Current market price |
| `/polymarket/trade-history` | GET | Historical trades |
| `/polymarket/candlestick` | GET | OHLC candlestick data |
| `/polymarket/activity` | GET | Market activity feed |
| `/polymarket/orderbook-history` | GET | Orderbook snapshots |
| `/polymarket/wallet` | GET | Wallet info (EOA, proxy, handle) |
| `/polymarket/events` | GET | Event listings |
| `/kalshi/markets` | GET | Search/list Kalshi markets |
| `/kalshi/trades` | GET | Kalshi trade history |
| `/kalshi/market-price` | GET | Kalshi market price |
| `/kalshi/orderbook-history` | GET | Kalshi orderbook |
| `/matching-markets/sports` | GET | Cross-platform market matching |
| `/matching-markets/sports/{sport}` | GET | Match by sport and date |
| `/polymarket/placeOrder` | POST | Execute order via Order Router |
| `wss://ws.domeapi.io/<key>` | WS | Real-time order events |

## Appendix B: Glossary

| Term | Definition |
|---|---|
| **EOA** | Externally Owned Account — your MetaMask/Rabby wallet address |
| **Proxy Wallet** | Polymarket's smart contract wallet created for each user |
| **Entity** | A group of wallets believed to belong to the same person/org |
| **Arbitrage (Arb)** | Exploiting price differences for the same event across platforms |
| **Hedge** | Taking an opposing position to reduce risk on an existing position |
| **Ladder Exit** | Selling shares in increments at ascending price levels |
| **Recovery-Based Stop** | Stop-loss calculated on how much gain is needed to recover losses |
| **Trailing Stop** | Stop-loss that moves up as price increases, locking in profits |
| **Dome** | Third-party API aggregating Polymarket + Kalshi data |
| **CLOB** | Central Limit Order Book — Polymarket's order matching system |
| **Matching Markets** | Same real-world event listed on multiple prediction platforms |
