# Polymarket Copytrade Bot — Features, Fixes & Roadmap

**Purpose:** Living document for potential new features, ongoing fixes, and future plans. Use as a think space and meeting prep. Update as priorities and decisions change.

**Last updated:** 2025-02-24

---

## Table of contents

1. [New feature candidates](#1-new-feature-candidates)
2. [Ongoing fixes](#2-ongoing-fixes)
3. [Future plans](#3-future-plans)
4. [References](#4-references)

---

## 1. New feature candidates

### 1.1 Whale watching (discovery & tracking)

**What it is:** Help users **discover** high-value traders (“whales”) on Polymarket and add them to the copytrade list, instead of requiring users to already know wallet addresses. Today the bot assumes you have addresses to paste; whale watching turns the product into “find who’s worth copying, then copy them.”

**Why it’s high value:** Expands the funnel (users who don’t know any traders can still get value), increases stickiness (discovery → track → copy in one flow), and differentiates from “dumb” copy bots that only mirror addresses you provide.

**Reference: PolyMetrics.** [PolyMetrics](https://github.com/KajuranElanganathan/PolyMetrics) is a real-time Polymarket surveillance dashboard (Python/FastAPI/PostgreSQL, React/TypeScript frontend). It does: live trade ingestion, whale identification/tagging, PnL computation across position history, volume/win-rate metrics, and instant alerting. We don’t need to copy their stack (we’re Node/TS); we **reuse the concepts**: how to define a “whale” (volume, PnL, trade size over a window), how to rank wallets, and how to surface “top traders” with a one-click “Track” action.

**How it could be implemented:**

- **Data source:** Polymarket exposes activity by wallet: REST `GET /activity?user={address}` (public) and WebSocket user channel for real-time trade lifecycle. We could add a **discovery pipeline** that either (a) periodically fetches activity for a large set of candidate addresses (e.g. from recent market makers or from our own “seed” list), or (b) subscribes to CLOB/order-book events and aggregates by wallet to compute volume and simple PnL proxies. No need for a separate PostgreSQL analytics DB initially; we can start with in-memory or SQLite aggregation over a rolling window (e.g. last 7 days).
- **Whale definition:** Configurable criteria: e.g. “top N by 7d volume,” “wallets with PnL above X,” or “trade size > $Y.” Start with volume and trade count; add PnL once we have position/outcome data (we already have `PerformanceTracker` and position lifecycle logic we can lean on).
- **Dashboard:** New section “Discover” or “Whale leaderboard”: table of wallets ranked by chosen metric, with columns like 7d volume, trade count, optional win rate or PnL if available. Each row has “Add to tracked wallets” that calls existing `addTradingWallet` (or equivalent) so the rest of the bot is unchanged.
- **Scope:** Start Polymarket-only; the existing codebase is already Polymarket-centric for copy execution; Kalshi can come later if discovery is extended to other venues.

**Pros:**

- Clear product story: “Discover then copy.”
- Reuses existing add-wallet and copy flow; no change to execution safety.
- PolyMetrics proves the concept (whale detection, PnL, alerts); we adapt it to our stack and UX.

**Cons:**

- Discovery requires either a list of candidate addresses (curation/maintenance) or streaming CLOB data and storage; both have cost and complexity.
- PnL on Polymarket requires resolving positions and market outcomes; we already have some of this in `positionLifecycle` and `PerformanceTracker`, but “historical PnL for any wallet” is a bigger lift than “volume last 7 days.”
- Risk of gaming: public leaderboards can encourage wash trading or self-reinforcing flows; we can mitigate by using volume + time windows and eventually verified-identity or stake if we ever go that route.

**Impact on the bot:** Additive. New discovery service + new UI section; copy execution, rate limits, and safety invariants stay as they are.

---

### 1.2 Whale / leaderboard (ranked discovery)

**What it is:** A **leaderboard** of wallets ranked by volume, PnL, or win rate over a configurable window (e.g. 24h, 7d, 30d), with filters (market category, min volume) and “Track” to add to copytrade list. Can be the same data backend as whale watching, with a more “gamified” or leaderboard-style UI.

**Why it’s high value:** Users and communities care about “who’s winning”; a leaderboard drives engagement and gives a clear reason to add new wallets. Aligns with how other platforms (e.g. eToro CopyTrader, crypto whale trackers like Hyperbot, Sonar) surface “top performers.”

**How it could be implemented:**

- Reuse the same aggregation as whale watching (volume, trade count, optional PnL). Expose via a new API route, e.g. `GET /api/leaderboard?window=7d&metric=volume&limit=50`, and render in the dashboard as a table or list with “Track” buttons.
- Optional: persist leaderboard snapshots (e.g. daily) so we can show “yesterday’s top 10” or simple trend arrows without recomputing on every page load.
- If we add “win rate” or “PnL,” we need resolved positions per wallet; that implies either using Polymarket’s activity/positions APIs per wallet or maintaining our own summary tables from trade/outcome data.

**Pros:**

- Strong differentiation; few Polymarket copy bots offer a built-in leaderboard.
- Same data pipeline as whale watching; incremental build.

**Cons:**

- Leaderboard can incentivize short-term, high-risk behavior; we should pair it with clear disclaimers and possibly “realized PnL” or “risk-adjusted” metrics later.
- Ranking by PnL requires consistent position/outcome data and settlement awareness (resolved markets).

**Impact:** Complements whale watching; can be the same feature (discovery + leaderboard view) or a second view on the same data.

---

### 1.3 Alerts (whale moves, price levels, copy events)

**What it is:** Notifications when (a) a tracked wallet opens or closes a large position, (b) a market crosses a price threshold you care about, or (c) the bot executes a copy trade (or hits a safety limit). Delivery: in-dashboard only at first; later email, Telegram, or Discord.

**Why it’s high value:** Keeps users informed without staring at the dashboard; “whale moved” and “your bot just copied a trade” are high-signal events. Common in premium bots (e.g. Maestro, Hyperbot, PolyBot-style whale alerts).

**How it could be implemented:**

- **Copy-trade alerts:** Already have execution flow in `CopyTrader` and `TradeExecutor`; add an optional “alert on copy” callback that appends to an in-app feed and/or calls a small notification module. No change to order path; fire-after-success.
- **Whale-move alerts:** If we have a discovery/whale pipeline, add a threshold (e.g. “notify when any wallet in top 20 by volume trades size > $X”). Run in the same pipeline that updates whale stats; emit event when threshold crossed; consumer writes to feed or external notifier.
- **Price alerts:** We already have `PriceMonitor` for ladder/stop-loss. Extend with “notify only” rules: e.g. “when market X YES price > 0.75, send alert.” Reuse price polling or WebSocket, but instead of executing a ladder/stop-loss, call notification handler. Storage: new table or config for alert rules (market, condition, user id if multi-user).
- **Delivery:** V1 = in-dashboard feed (list of recent events, optional “mark read”). V2 = pluggable notifiers (Telegram bot, Discord webhook, email) via config or env; keep secrets out of code.

**Pros:**

- Increases perceived control and trust (“I know when something big happens”).
- Copy and price alerts are natural extensions of existing execution and price-monitor code.

**Cons:**

- Too many alerts cause fatigue; we need thresholds and possibly “quiet hours” or per-alert-type toggles.
- External delivery (Telegram, etc.) requires token/webhook management and security (no leaking of trade details).

**Impact:** Improves engagement and trust; implementation can be incremental (in-app first, then external).

---

### 1.4 Portfolio and position analytics

**What it is:** Dashboard views that answer: “Where is my exposure?” (by market, outcome, or category) and “What’s driving my PnL?” (attribution by wallet, market, or time). Builds on existing position and performance data.

**Why it’s high value:** Power users and institutions expect portfolio-level risk and attribution; even casual users benefit from “you’re up $X this week, mostly from wallet A and market B.” Aligns with “institutional-grade” analytics (e.g. 3Commas, advanced copy platforms).

**How it could be implemented:**

- **Exposure:** We already have (or can get) positions per market/outcome from Polymarket (and Kalshi if we extend). Aggregate: sum size × current price by market, by outcome (YES/NO), and optionally by category if we have market metadata. New dashboard tab or section “Exposure” with tables or simple charts (e.g. bar chart by market).
- **PnL attribution:** `PerformanceTracker` and `CrossPlatformPnlTracker` already track performance. Extend to “PnL by wallet” (which copied wallet contributed how much) and “PnL by market” (which markets contributed). Requires consistent tagging of executed trades with source wallet and market; we may already have this in storage. Frontend: table or time-series “PnL over time” with breakdown by dimension.
- **Risk metrics (later):** Correlation of positions (e.g. many YES positions on correlated markets), max drawdown, Sharpe-like ratio over a window. These need more design and possibly external libs; good “phase 2” for analytics.

**Pros:**

- Uses data we already have or can derive; high value per engineering effort.
- Differentiates from “just copy and hope” bots.

**Cons:**

- Attribution can be ambiguous (e.g. same market, multiple wallets; timing of copy vs. resolution). We should define rules clearly (e.g. “realized PnL when position closed, attributed to wallet that triggered copy”).
- Cross-platform (Polymarket + Kalshi) attribution requires consistent IDs and possibly FX/unit normalization.

**Impact:** Makes the bot feel like a serious trading tool; encourages retention and willingness to add more wallets.

---

### 1.5 Per-wallet copy allocation (size and cap)

**What it is:** Let the user set a **copy fraction or cap per tracked wallet**: e.g. “Copy Whale A at 100%, Whale B at 50%, Whale C at 25%,” or “Max $50 per trade from Wallet X.” Today the bot has global trade size and per-wallet enable/disable; this adds **per-wallet sizing**.

**Why it’s high value:** Users want to “weight” who they trust (e.g. copy stars at full size, newcomers at half). Reduces blow-up risk from one aggressive wallet and matches how premium copy platforms (e.g. eToro, TradeLabs) allow “follow at 10% / 50% / 200%.”

**How it could be implemented:**

- **Storage:** Extend wallet config (e.g. in `Storage` or wallet manager) with optional `copyFraction` (0–1 or 0–2 for “2x”) and/or `maxOrderSizeUsd` per wallet. If absent, use global default (current behavior).
- **Execution:** In the copy path (e.g. where we compute order size from detected trade), after applying global caps and fixed size, multiply (or cap) by this wallet’s `copyFraction` and `maxOrderSizeUsd`. Must run after existing safety checks (no-repeat, stop-loss, order size cap) so we only reduce size, never increase beyond current limits.
- **Dashboard:** In “Tracked wallets” or wallet settings, add inputs for “Copy %” and “Max order size ($).” API: extend add/update wallet payloads and responses to include these fields.

**Pros:**

- Fine-grained risk control without removing a wallet entirely.
- Well-understood pattern; clear UX.

**Cons:**

- More settings can confuse; good defaults (e.g. 100%) and tooltips help.
- We must ensure fractional sizing doesn’t create dust orders (min size checks) and that we don’t exceed exchange/bot limits.

**Impact:** Better risk control and user trust; touches wallet config and one place in the execution pipeline.

---

### 1.6 Daily loss cap and session-level risk

**What it is:** A **daily (or session) loss cap**: if the bot’s cumulative PnL for the day drops below a threshold (e.g. −5% of starting balance or −$X), stop copying (and optionally stop new ladder/stop-loss triggers) until the next day or manual reset. Complements existing USDC commitment stop-loss and per-trade safety.

**Why it’s high value:** Prevents “revenge” drawdowns and limits tail risk; industry standard in serious trading bots (see 3Commas, Nadcab, Capture OS risk frameworks). Users sleep better knowing “max loss per day is bounded.”

**How it could be implemented:**

- **Config:** New settings, e.g. `dailyLossCapPercent` and `dailyLossCapUsd` (optional), and “session” definition (calendar day UTC or rolling 24h). Store in existing config/settings.
- **State:** At start of session, record “session start balance” (or portfolio value). On each executed trade (or periodically), compute current PnL for the session. If PnL < −cap, set a “trading paused – daily cap” flag and stop accepting new copy executions (and optionally pause price-monitor triggers). Expose cap status in API and dashboard.
- **Reset:** At midnight UTC (or after 24h), or via “Reset daily cap” button, clear the flag and record new session start balance. Don’t auto-resume without user awareness (show “Paused due to daily cap” in UI until reset).

**Pros:**

- Clear, understandable safety net; aligns with regulatory and institutional expectations.
- Fits existing pattern: we already have USDC stop-loss and order-size caps; this is another layer.

**Cons:**

- Need a clear definition of “PnL” (realized only vs. including unrealized) and “balance” (cash only vs. cash + positions). Usually “realized PnL + mark-to-market” or “portfolio value vs. session start” is used.
- If we pause, we must ensure in-flight orders complete or cancel cleanly and that resume is explicit.

**Impact:** Significant risk reduction; one new config surface and one gate in the copy (and optionally price-monitor) path.

---

### 1.7 Volatility-adjusted position sizing

**What it is:** Instead of (or in addition to) fixed trade size, size each copy trade by **volatility** of the market: e.g. use a target risk per trade (e.g. 1% of portfolio) and derive size from recent price range or outcome variance so that high-volatility markets get smaller position sizes.

**Why it’s high value:** Reduces blow-ups in wild markets; professional systems use ATR or similar (see Nadcab, risk-management guides). Differentiates from “dumb” fixed-size copying.

**How it could be implemented:**

- **Inputs:** Per market we need a volatility proxy: e.g. recent high-low range, or standard deviation of mid price over last N hours. Polymarket CLOB or data API may expose history; we might need to cache last N prices per market.
- **Sizing formula:** e.g. `size = (targetRiskPercent * portfolioValue) / (volatilityProxy * scaleFactor)`, capped by max size. Integrate into the same place we compute order size in the copy path; keep a floor (min order size) so we don’t create dust.
- **Config:** “Use volatility sizing” toggle and `targetRiskPercent` (default off so behavior is unchanged). Optional: fallback to fixed size when volatility data missing.

**Pros:**

- Better risk-adjusted outcomes in volatile markets.
- Optional and additive; can default off.

**Cons:**

- Requires reliable price/volatility data and a clear definition of “portfolio value” (cash vs. cash+positions).
- More moving parts; need to backtest or paper-trade to tune.

**Impact:** Advanced feature; implement after daily cap and per-wallet allocation if we want to avoid scope creep.

---

### 1.8 Arbitrage and edge detection (expand existing)

**What it is:** We already have `ArbScanner`; expand it to **surfacing** arb opportunities in the dashboard (e.g. “YES/NO mispriced on market X”) and optionally **automated execution** of simple arb (e.g. buy YES and NO when sum of prices < 1 minus fee). Also: “edge” detection such as same question listed on multiple markets with different prices.

**Why it’s high value:** Arbitrage is “free money” when it exists; prediction-market bots (e.g. PolyTrack’s arbitrage guides, Polymarket AI bot case studies) highlight arb and cross-market edge as premium features.

**How it could be implemented:**

- **Scanning:** `ArbScanner` already exists; ensure it exposes results via API (e.g. list of markets with spread or implied edge). Dashboard: “Opportunities” tab showing table with market, current spread, estimated profit, “Execute” or “Watch.”
- **Execution:** If we add auto-arb, it must be a separate path from copy trading (no mixing of user copy logic with arb logic). Dedicated small executor that (a) checks spread still valid, (b) places both legs, (c) has its own size/cap and kill switch. Start with “manual trigger” from dashboard; auto-execute only after thorough testing.
- **Edge across markets:** Same question, different slugs or condition IDs: need a way to match “same question” (metadata or manual mapping) and compare prices; then show “Market A YES 0.65, Market B YES 0.70” as edge.

**Pros:**

- Uses existing scanner; adds visible value and optional automation.
- Attracts more advanced users.

**Cons:**

- Arb can vanish quickly; execution latency and fees matter. We should be conservative (size caps, confirm-before-execute).
- Cross-market matching is product/design work (what counts as “same question”?).

**Impact:** Builds on current codebase; keep execution path strictly separated from copy path for safety.

---

### 1.9 Momentum / threshold auto-trading (optional)

**What it is:** In addition to copy trading, allow **rule-based auto-trading**: e.g. “When BTC price (from an external feed) crosses above $X, buy YES on market ‘BTC above $Y by date Z’ up to $W,” or “When any market in category Politics has YES &lt; 0.30, buy $50 YES.” This is “if condition then place order” with configurable conditions and size.

**Why it’s high value:** Some Polymarket bots (e.g. PolyBot, PolyTrack-style momentum and “late-round sniping”) offer automated scans and entries; this would put us in the same category for users who want both copy and rules.

**How it could be implemented:**

- **Rules engine:** New module: list of rules, each with (trigger type, trigger params, market selector, side, size, optional cap). Triggers: “price feed crosses threshold,” “market probability &lt; X,” “time to resolution &lt; Y minutes.” Market selector: by slug, condition ID, or category.
- **Execution:** Separate from copy path. When a rule fires, resolve market and side, compute size, then call the same order execution we use for copy (through a dedicated entry point) with strict caps and a “rule id” for logging. Rate-limit rule executions (e.g. max N per hour).
- **Data:** Price monitor already polls markets; we’d add external price feeds (e.g. BTC) via configurable URL or API. Store rule definitions in DB or config.

**Pros:**

- Attracts users who want automation beyond copying.
- Reuses execution and risk infrastructure.

**Cons:**

- Large surface area (many trigger types, market selectors); start with 1–2 trigger types (e.g. “market YES &lt; threshold” and “time to resolution &lt; X”).
- Risk of bad rules (e.g. “buy everything &lt; 0.30”); require caps and possibly manual approval for first version.

**Impact:** New product surface; implement only if we commit to maintaining and securing a rules engine.

---

### 1.10 Walkthrough tour (finish implementation)

**What it is:** Complete the in-app **walkthrough tour** as designed: overlay-only, no data replacement, steps for each main tab and controls, entry from Help → “Start walkthrough.” Design is already in [docs/plans/2025-02-24-walkthrough-tour-design.md](plans/2025-02-24-walkthrough-tour-design.md).

**Why it’s high value:** Reduces onboarding friction; new users understand where to add wallets, where to see trades, and how to use settings. Improves retention and support burden.

**How it could be implemented:** Follow the design doc: `tour.js` (steps, overlay, Next/Back/Skip, optional `switchTab`), `tour.css` (overlay, spotlight, step card), single Help menu item calling `startTour()`, and `data-tour` attributes where needed. No API or data-layer changes. Feature flag `TOUR_ENABLED` for quick disable.

**Pros:** Isolated, safe, already specified.  
**Cons:** None beyond implementation time.  
**Impact:** Better first-run experience; list under “Ongoing fixes” until shipped.

---

## 2. Ongoing fixes

- **Walkthrough tour:** Finish implementation per [docs/plans/2025-02-24-walkthrough-tour-design.md](plans/2025-02-24-walkthrough-tour-design.md); add `data-tour` targets and test on all main tabs.
- **Bugs / tech debt:** *(Add specific items as they come up: e.g. “Fix dashboard race when adding wallet during poll,” “Refactor X for testability,” “Upgrade dependency Y.”)*
- **Documentation:** Keep README and this roadmap in sync when we ship features; no README link required for now per decision.

---

## 3. Future plans

- **Product direction:** Decide how much to invest in “discovery” (whale + leaderboard) vs. “execution excellence” (risk, sizing, alerts) vs. “automation” (rules, arb). This doc supports that discussion.
- **Multi-platform parity:** Ensure Polymarket and Kalshi feature parity where it matters (copy, risk, analytics); extend discovery/whale to Kalshi only if we have demand and data.
- **Meeting notes / decisions:** *(After the meeting, paste key decisions here: e.g. “Prioritize whale watching + leaderboard in Q2,” “Daily loss cap approved; target ship by X.”)*

---

## 4. References

- **PolyMetrics (whale surveillance):** [GitHub – KajuranElanganathan/PolyMetrics](https://github.com/KajuranElanganathan/PolyMetrics) — Real-time Polymarket surveillance, whale tracking, PnL computation, FastAPI + React. We reuse concepts (whale definition, ranking, alerts), not the stack.
- **Polymarket data:** Activity API (`GET /activity?user={address}`), WebSocket user channel for trade lifecycle; CLOB and Data SDK docs for trades and markets.
- **Risk and copy patterns:** 3Commas (risk management, multi-account); TradeLabs (position sizing, multi-source signals); Maestro/Hyperbot (whale tracking, copy limits); Nadcab / Capture OS (daily loss cap, volatility sizing).
