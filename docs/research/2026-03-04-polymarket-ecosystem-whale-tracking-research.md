# Polymarket Ecosystem & Whale Tracking Research

**Date:** March 4, 2026  
**Purpose:** Exhaustive research on open-source Polymarket projects, whale tracking solutions, DeFi analytics platforms, and copy trading discovery mechanisms.

---

## Table of Contents

1. [Polymarket Official APIs & Infrastructure](#1-polymarket-official-apis--infrastructure)
2. [Open-Source Polymarket Projects on GitHub](#2-open-source-polymarket-projects-on-github)
3. [Commercial Whale Tracking Platforms](#3-commercial-whale-tracking-platforms)
4. [DeFi Whale Tracking Approaches (Nansen, Arkham, etc.)](#4-defi-whale-tracking-approaches)
5. [Portfolio Trackers (DeBank, Zerion)](#5-portfolio-trackers)
6. [Copy Trading Discovery Algorithms (eToro, 3Commas)](#6-copy-trading-discovery-algorithms)
7. [Key Takeaways for Building Our System](#7-key-takeaways-for-building-our-system)

---

## 1. Polymarket Official APIs & Infrastructure

### API Layers

Polymarket provides **four** API layers:

| API | Base URL | Auth Required | Purpose |
|-----|----------|---------------|---------|
| **CLOB API** | `clob.polymarket.com` | Yes (HMAC-SHA256) | Trading, order management |
| **Gamma API** | `gamma-api.polymarket.com` | No | Market metadata, events, profiles |
| **Data API** | `data-api.polymarket.com` | No | Positions, activity, leaderboard |
| **WebSocket API** | `ws-subscriptions-clob.polymarket.com` | No | Real-time price/orderbook streams |

### Key Public Endpoints (No Auth Required)

These are the endpoints most relevant for whale tracking:

**Wallet Activity & Positions:**
- `GET /positions?user={address}` — Current positions for any wallet
- `GET /closed-positions?user={address}` — Historical closed positions
- `GET /activity?user={address}` — On-chain activity feed (trades, redeems, splits, merges)
- `GET /value?user={address}` — Total portfolio value
- `GET /trades?user={address}` — Trade history with size, price, side, timestamp

**Market Intelligence:**
- `GET /holders?market={id}` — Top holders of a market
- `GET /oi?market={id}` — Open interest data
- `GET /v1/leaderboard` — Trader rankings by PNL or volume (filterable by category, time period)

**Profile:**
- `GET /public-profile?address={address}` — Username, bio, X handle, verified status

**Activity Feed Parameters:**
- `limit` (0-500), `offset` (0-10000)
- Filter by `market`, `eventId`, `type` (TRADE, REDEEM, MERGE, SPLIT, REWARD)
- Filter by `side` (BUY/SELL), `start`/`end` timestamps

### On-Chain Data via The Graph

Polymarket publishes **open-source subgraphs** for on-chain data:

- **GitHub:** [Polymarket/polymarket-subgraph](https://github.com/Polymarket/polymarket-subgraph) (188 stars)
- **Hosted by:** Goldsky (GraphQL endpoints)
- **Subgraph Types:**
  - Positions (user token balances)
  - Orders (order book and trade events)
  - Activity (splits, merges, redemptions)
  - Open Interest (market and global)
  - PNL (user profit & loss)
- **Free Access:** 100k queries/month via The Graph Studio API key
- **Docs:** https://thegraph.com/docs/sv/subgraphs/guides/polymarket/

### Official Python Client

- **GitHub:** [Polymarket/py-clob-client](https://github.com/Polymarket/py-clob-client) (837 stars)
- Full CLOB interaction: place/cancel orders, fetch markets, stream prices

---

## 2. Open-Source Polymarket Projects on GitHub

### A. Data Collection & Pipelines

#### poly_data (593 stars)
- **URL:** https://github.com/warproxxx/poly_data
- **Language:** Python
- **What it does:** Fetches, processes, and structures Polymarket data including markets, order events, and trades
- **Key value:** Most popular general-purpose data retrieval library; good foundation for any analytics pipeline

#### polymarket_data (6 stars)
- **URL:** https://github.com/amirharati/polymarket_data
- **What it does:** Master pipeline script (`run_all.py`) for downloading historical market, event, and price data with resume capability and comprehensive logging

#### polymarket-data-collector (8 stars)
- **URL:** https://github.com/harrodyuan/polymarket-data-collector
- **What it does:** Python pipeline handling 30,000+ markets (~45 sec runtime) with automatic pagination and open-market filtering

### B. Insider/Whale Detection

#### polymarket-insider-tracker (40 stars) ⭐ MOST RELEVANT
- **URL:** https://github.com/pselamy/polymarket-insider-tracker
- **Language:** Python
- **What it does:** Detects potential insider trading by monitoring suspicious wallet behavior patterns
- **Detection Methods:**
  - Fresh wallet detection (new wallets making large trades)
  - Unusual trade sizing relative to market depth
  - Niche market activity (low-volume, specific-outcome markets)
  - Funding chain analysis to link related wallets
- **Approach:** ML + heuristics-based anomaly detection
- **Alerts:** Discord, Telegram, email

### C. Copy Trading Bots

#### polymarket-copy-trading-bot (1,100 stars, 526 forks) — Most Popular
- **URL:** https://github.com/vladmeer/polymarket-copy-trading-bot
- **What it does:** Mirrors positions from a target wallet to your account
- **How it gets data:** Polls Polymarket activity API for target wallet changes

#### polymarket-copytrading-bot (227 stars)
- **URL:** https://github.com/AtlasAlperen/polymarket-copytrading-bot
- **Language:** TypeScript/Node.js
- **How it works:** Polls Polymarket's activity API, mirrors buys/sells scaled to your balance, 5% slippage cap, fill-or-kill orders

#### polymarket-copy-trading-bot-version-3
- **URL:** https://github.com/Trust412/polymarket-copy-trading-bot-version-3
- **What it does:** Continuously monitors a specified wallet and replicates positions with customizable risk management

#### polymarket-trading-bot (191 stars)
- **URL:** https://github.com/rjykgafi/polymarket-trading-bot
- **What it does:** Automated whale tracking with proportional position sizing and auto take-profit

### D. Market Making & Arbitrage

#### poly-maker (914 stars)
- **URL:** https://github.com/warproxxx/poly-maker
- **Language:** Python
- **What it does:** Automated market making — maintains liquidity on both sides of the order book
- **Config:** Via Google Sheets; real-time WebSocket monitoring
- **Note:** Creator warns it's no longer profitable given current competition

#### LastTick (3 stars)
- **URL:** https://github.com/achiko/LastTick
- **Language:** TypeScript
- **What it does:** "Endgame arbitrage" — buys near-certain outcomes (98-99%+) at $0.98-$0.99, claims at $1.00 after resolution
- **Stack:** PostgreSQL storage, analytics queries

#### polymarket-arbitrage-bot
- **URL:** https://github.com/runesatsdev/polymarket-trading-bot
- **What it does:** Detects risk-free arb when YES + NO prices sum < $1.00; live trading with dashboard

### E. AI Agents

#### Polymarket/agents (2,378 stars) — Official
- **URL:** https://github.com/Polymarket/agents
- **Language:** Python
- **Architecture:**
  - Gamma API integration for market/event metadata
  - CLOB client for order execution
  - Chroma vector database for RAG (news + API data vectorization)
  - Pydantic data models for trades, markets, events
  - Data sourcing from betting services, news providers, web search
  - LLM tools for prompt engineering and autonomous decision-making

#### polymarket-ai-resolution (31 stars)
- **URL:** https://github.com/x1xhlol/polymarket-ai-resolution
- **Language:** TypeScript
- **What it does:** AI-driven market resolution replacing UMA oracle voting with evidence-based AI reasoning

### F. SDKs & Clients

#### PolyBrainZ_Polymarket
- **URL:** https://github.com/mayankjanmejay/PolybrainZ_Polymarket
- **Language:** Dart
- **What it does:** Comprehensive SDK with live trading, real-time WebSocket, wallet management

#### polymarket-cli (1,533 stars)
- **URL:** Official Polymarket CLI in Rust

---

## 3. Commercial Whale Tracking Platforms

### SightWhale
- **URL:** https://sightwhale.com/
- **Volume tracked:** $1.4B+ in Polymarket activity
- **Core Innovation:** Whale Score™ (0-100 rating)
  - Filters "Dumb Large Money" from elite 1% of traders
  - Scoring factors: PnL history, timing precision, position hold duration, capital size
  - Only surfaces wallets scoring 70+
- **Architecture:** Ingests real-time trade + orderbook data → identifies abnormal capital movements → scores against historical accuracy → delivers signals
- **Data Sources:** On-chain clusters and exchange orderbook direct feeds
- **Delivery:** Dashboard, Telegram, email
- **Performance:** 72% win rate, +18.4% avg ROI, 1,240+ signals (90-day window)

### PredictAlpha
- **URL:** https://www.predict-alpha.com/
- **Positioning:** "Bloomberg Terminal for prediction markets"
- **Coverage:** Polymarket AND Kalshi
- **Whale Tracking:**
  - 500+ whale wallets with $1M+ positions monitored
  - Automated whale discovery (algorithmic, not manual curation)
  - Real-time position tracking with historical performance data
  - Instant alerts on large trader moves
- **Additional Features:** Arbitrage detection, AI sentiment analysis, backtesting, portfolio dashboard

### Polywhaler
- **URL:** https://www.polywhaler.com/
- **Features:**
  - Deep trade analysis with pattern breakdown
  - Insider detection signals
  - Impact classification (high/medium/low)
  - Historical data access
- **Model:** Freemium (basic tracking free, Pro unlocks advanced features)

### PolyTrack
- **URL:** https://www.polytrackhq.app/
- **Data Sources:**
  - py-clob-client for trade execution/data
  - gamma-api.polymarket.com/events for market data
  - Direct blockchain monitoring of wallet transactions
- **Features:** Real-time whale monitoring, trade alerts, copy trading, win rate/volume data

### Polytrackerbot
- **What it is:** Automated Twitter/X bot
- **Focus:** High-conviction whale activity and profitable wallet trades
- **Filters:** Excludes sports betting, focuses on political/economic markets
- **Analytics:** P&L calculations, trader performance metrics, buy-side emphasis

### PolySniperX
- **URL:** http://polysniperx.com/
- **Three Strategies Combined:**
  1. Event sniping (<100ms execution on market creation)
  2. Atomic arbitrage between binary and scalar markets
  3. Whale copy trading
- **Architecture:** Open-source, runs locally, AES-256 encrypted keys, non-custodial

---

## 4. DeFi Whale Tracking Approaches

### Nansen

**Architecture & Methodology:**
- Processes raw blockchain data: transaction details, smart contract interactions, token transfers
- **Entity labeling engine** — classifies wallets as smart money, exchanges, treasuries, funds
- Labels include: Fund, Smart Trader, 30D/90D/180D Smart Trader, Smart HL Perps Trader

**How Whale Detection Works:**
1. Identifies largest token holders using labeled wallets
2. Analyzes whale wallet transaction patterns and token flow directions
3. Monitors broader token flow trends beyond individual addresses
4. Interprets activity within market context (not just raw transactions)

**Key Metrics Tracked:**
- Exchange inflows/outflows (sell vs hold signals)
- Transaction volume and frequency
- Token holdings distribution among top holders
- Smart contract interactions (staking, lending, yield farming)
- Cross-chain transfers via bridges
- Token vesting events

**API Endpoints:**
- Smart Money: netflows, holdings, DEX trades, perp trades, DCA strategies
- Profiler: balances, transactions, counterparties, PnL
- Token God Mode: holders, flows, screener
- **Related Wallets** endpoint — identifies wallet clusters (crucial for deanonymization)
- Address labels for classification

**Pricing:** Pro Plan $49-69/mo. Label endpoints cost 500 credits each (expensive). Smart Money endpoints 5 credits. 1M credits/month on Professional plan.

**Chain Coverage:** 19+ chains including Ethereum, Solana, Base, Arbitrum, Polygon

### Arkham Intelligence

**Core Technology — "Ultra" AI Engine:**
- Proprietary AI-powered algorithmic address matching
- Systematically links blockchain addresses to real-world entities at scale
- Synthesizes **both on-chain and off-chain data** from multiple sources
- Contains **300 million+ labels** and **150,000+ entity pages**

**Key Capabilities:**
- Transaction tracking across multiple wallets and blockchain networks
- **Visualizer** — customizable network analysis of entities and counterparties
- **Alerts** — transaction notifications based on size, entity, blockchain, token
- Portfolio analysis: holdings, balance history, P&L, exchange usage
- API access to Ultra for custom queries

**Scale:** 3 million+ registered users. Used by trading firms, exchanges, government entities.

**Key Differentiator:** Off-chain data integration. Not just blockchain indexing — they incorporate external data sources to build entity profiles.

### General On-Chain Whale Detection Techniques

**RPC Node Approach:**
- Direct blockchain queries via RPC clients
- Process block-level data, extract transactions exceeding thresholds
- Event log monitoring for specific contract interactions

**Key Detection Signals:**
- Transaction volume/size exceeding thresholds (e.g., $1M+)
- Exchange inflows/outflows (selling vs accumulating)
- Gas fee spikes (urgency indicator)
- Transaction clustering by timestamp
- Token type differentiation

**Advanced Pattern Recognition:**
- Accumulation pattern detection (strategic buying over time)
- Distribution phase analysis (gradual selling)
- Stealth movement detection (order splitting, multiple wallets)

**Critical Limitation:** Raw whale alerts have poor signal-to-noise ratio. Large transactions can be routine operations (OTC trades, custodian transfers, exchange internal movements). **Sustained directional flow patterns** are more predictive than individual transactions.

---

## 5. Portfolio Trackers

### DeBank

**API Architecture:**
- Five main endpoint groups: User, Wallet, Chain, Protocol, Token
- **PortfolioItemObject** captures: pool info, token details, position types, USD valuations, timestamps
- Position types: Yield, Staked, Farming, Lending, Liquidity Pool, NFT, Perpetuals
- Batch operations: up to 100 tokens per request
- Token price history, top holder rankings, protocol-specific data

**How They Get Data:**
- Multi-chain indexing infrastructure
- Smart contract interaction parsing
- Protocol-specific adapters for 8,000+ DeFi protocols
- Real-time balance aggregation across chains

### Zerion

**Architecture:**
- Indexes and normalizes on-chain data across 40+ EVM chains + Solana
- Provides **interpreted financial data** (not raw blockchain data) — values, types, relationships, metadata in human-readable format
- Data updates within **milliseconds of new blocks**

**API Capabilities:**
- Single API call returns wallet data across 38+ blockchains
- Transaction history with type classification, fiat values at transaction time
- DeFi positions across 8,000+ protocols
- NFTs with metadata and floor prices
- PnL tracking: historical gains, losses, invested value

**Key Insight:** Both DeBank and Zerion abstract away blockchain complexity. They maintain their own indexing infrastructure that processes raw on-chain data into structured, queryable formats. This is expensive to build but allows near-instant queries.

---

## 6. Copy Trading Discovery Algorithms

### eToro's Popular Investor Discovery

**Program Structure:**
- ~3,300 copyable traders out of 30M+ users
- Four tiers: Cadet → Champion → Elite → Elite Pro
- Top traders earn ~1.5% annually on assets under copy (AUC)
- Only ~12 traders generate revenue at the highest level

**Discovery Mechanism:**
- Traders **opt-in** to the Popular Investor program
- Platform ranks by verified track record (minimum time requirement)
- Users browse leaderboard filtered by risk score, returns, # copiers
- Algorithmic risk scoring ensures diversity (not just highest returns)

**Key Metric:** Heloïse Greeff (top trader) has 126,000 followers, uses ML algorithms, 6,100 active copiers with $10M+ AUC. This demonstrates the power-law distribution in copy trading.

### 3Commas Signal Marketplace

**How Signal Discovery Works:**
- **Marketplace model**: Signal providers publish strategies, users subscribe
- Providers use private algorithms/strategies to generate buy/sell signals
- Subscription model: some free, others paid monthly
- Bot creation: subscribe → create bot → select signal as "trade start condition"

**Signal Bot Features:**
- Multi-pair trading (up to 200 pairs per bot)
- Flexible order scaling
- Long/short with hedge mode
- Risk controls (maximum initial margin)
- Webhook integration (TradingView, PineScript, sentiment tools)

**Key Insight:** 3Commas is a signal aggregation platform, NOT a discovery algorithm. Providers self-select and publish. Quality filtering is mostly user-driven (reviews, subscriber counts).

### General Copy Trading Discovery Metrics

**Essential Ranking Metrics:**
- **ROI** — percentage growth over time
- **Maximum Drawdown (MDD)** — worst peak-to-trough loss (< 20% = conservative, 35-50% = aggressive)
- **Risk-Adjusted Returns** — Sharpe Ratio (> 1.0 good, > 2.0 excellent), Sortino Ratio, Calmar Ratio
- **Win Rate + Risk-Reward Ratio** — 40% win rate with 2:1 R:R > 90% win rate with catastrophic tail risk
- **Track Record Length** — minimum 6 months, 12+ preferred
- **PnL in USD** and **AUM** — verifies real performance at scale

**Discovery Sources:**
1. Exchange leaderboards (Hyperliquid, Bybit, OKX)
2. On-chain analytics (verified blockchain performance)
3. Signal communities (Telegram, Discord)

---

## 7. Key Takeaways for Building Our System

### Data Access is Surprisingly Easy

Polymarket's public APIs provide everything needed for whale tracking **without authentication**:
- Any wallet's positions, activity, trade history, and portfolio value
- Leaderboard rankings by PnL and volume
- Market-level holder and open interest data
- Real-time WebSocket feeds for price/orderbook changes

This is dramatically different from traditional DeFi whale tracking (which requires expensive RPC infrastructure, subgraph deployment, and multi-chain indexing).

### Architecture Pattern: All Copy Bots Use the Same Approach

Every open-source copy trading bot follows this pattern:
1. **Poll** the Polymarket activity/positions API for a target wallet (every 1-5 minutes)
2. **Diff** against last known state to detect new trades
3. **Mirror** the trade proportionally (scaled to bot's balance)
4. **Risk manage** with slippage caps and position limits

This is simple and effective but **reactive** (you trade AFTER the whale, not WITH them).

### The Hard Problem: Whale Discovery, Not Tracking

Tracking a known whale is trivial. The **hard problem** is:
1. **Discovering** which wallets are actually profitable and worth following
2. **Scoring** wallets on multiple dimensions (not just PnL — also consistency, risk profile, market selection)
3. **Filtering noise** — large positions ≠ smart positions
4. **Detecting freshness** — wallets that were good may stop being good

SightWhale's Whale Score™ and PredictAlpha's automated whale discovery are the most interesting approaches here. They go beyond "find big wallets" to "find consistently profitable wallets with good risk-adjusted returns."

### polymarket-insider-tracker is the Closest Open-Source Analog

The `pselamy/polymarket-insider-tracker` (40 stars) is the most architecturally relevant project. It does:
- ML-based anomaly detection on trade patterns
- Fresh wallet detection
- Trade size vs market depth analysis
- Funding chain analysis (wallet linking)

This is the kind of "smart" detection we should be building, not just simple position mirroring.

### Nansen/Arkham Approaches are Overkill for Polymarket

Nansen and Arkham build massive infrastructure to:
- Index raw blockchain data across 19+ chains
- Maintain millions of wallet labels via AI/ML entity resolution
- Process block-level data in real-time via RPC nodes

For Polymarket specifically, this is unnecessary because **Polymarket already provides structured API access to all trading data**. We don't need to index raw Polygon blockchain transactions — we can query the API directly.

### What the Best Platforms Do That Open-Source Doesn't

| Capability | Open-Source Bots | SightWhale/PredictAlpha |
|-----------|-----------------|------------------------|
| Track known wallet | ✅ | ✅ |
| Discover new whales | ❌ | ✅ (automated) |
| Score wallet quality | ❌ | ✅ (Whale Score) |
| Historical performance | ❌ | ✅ |
| Signal delivery (Telegram) | ✅ (basic) | ✅ (rich) |
| Multiple whale monitoring | ❌ (1 wallet) | ✅ (500+) |
| Insider detection | ⚠️ (1 project) | ✅ |
| Risk-adjusted metrics | ❌ | ✅ |

### Recommended Architecture for Our System

Based on this research, the optimal stack would be:

1. **Data Layer:** Polymarket public APIs (Data API + Gamma API) — no auth needed, no blockchain indexing required
2. **Ingestion:** Scheduled polling (1-5 min intervals) of leaderboard + known whale wallets + activity feeds
3. **Whale Discovery Engine:** Algorithmic scoring combining:
   - PnL (absolute and percentage)
   - Win rate
   - Sharpe/Sortino ratio equivalent
   - Position sizing consistency
   - Market selection quality (avoiding just sports bets)
   - Freshness decay (recent performance weighted higher)
4. **Signal Generation:** Pattern detection for new trades by high-scoring wallets
5. **Delivery:** Telegram bot with trade details, wallet score, and direct Polymarket links
6. **Storage:** PostgreSQL for historical trade/wallet data; enables backtesting

### GitHub URLs Summary

| Project | Stars | URL |
|---------|-------|-----|
| Polymarket/agents | 2,378 | https://github.com/Polymarket/agents |
| polymarket-cli | 1,533 | Official Polymarket |
| vladmeer/copy-trading-bot | 1,100 | https://github.com/vladmeer/polymarket-copy-trading-bot |
| warproxxx/poly-maker | 914 | https://github.com/warproxxx/poly-maker |
| py-clob-client | 837 | https://github.com/Polymarket/py-clob-client |
| warproxxx/poly_data | 593 | https://github.com/warproxxx/poly_data |
| AtlasAlperen/copytrading | 227 | https://github.com/AtlasAlperen/polymarket-copytrading-bot |
| rjykgafi/trading-bot | 191 | https://github.com/rjykgafi/polymarket-trading-bot |
| polymarket-subgraph | 188 | https://github.com/Polymarket/polymarket-subgraph |
| pselamy/insider-tracker | 40 | https://github.com/pselamy/polymarket-insider-tracker |
| polymarket-ai-resolution | 31 | https://github.com/x1xhlol/polymarket-ai-resolution |
| dylanpersonguy/Trading-Bot | 21 | https://github.com/dylanpersonguy/Polymarket-Trading-Bot |
| polymarket-data-collector | 8 | https://github.com/harrodyuan/polymarket-data-collector |
| polymarket_data | 6 | https://github.com/amirharati/polymarket_data |
| achiko/LastTick | 3 | https://github.com/achiko/LastTick |
| resolution-subgraph | 3 | https://github.com/Polymarket/resolution-subgraph |
