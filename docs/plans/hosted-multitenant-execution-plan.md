# Hosted Multi-Tenant — Execution Plan (Risks, Edge Cases, and Clean Phases)

**Assumption:** Host on **Hetzner** (EU) with fixed egress IP; if blocked, switch to DigitalOcean, Vultr, or OVH in an approved EU region and re-validate.

**Execution rule:** Complete each phase in order. Do not start Phase N until Phase N-1 is complete and verified.

---

## How the two plans relate (what to implement)

**Yes — everything in both plans is part of the same overhaul and needs to be implemented.**

| Document | Role | Use it for |
|----------|------|------------|
| **[hosted-multitenant-enterprise-implementation-plan.md](hosted-multitenant-enterprise-implementation-plan.md)** | Architecture and rationale | Why Railway was blocked; hosting strategy; multi-tenant data model; execution model; secrets approach; Part 5 in-depth implementation detail (DB, tenantContext, storage, WalletManager, CopyTrader); Part 6 API/auth; Part 7 frontend/discovery; Part 8 testing/rollback; Part 9 risk. |
| **This file (hosted-multitenant-execution-plan.md)** | Single actionable checklist | Phased tasks in order (0a → 0 → 1 → 2 → 3 → 3b → 4 → 5 → 6 → 7); risks and mitigations; Polymarket/Builder compliance; admin and monitoring; file-level changes. |

Implement from **this execution plan** phase by phase. When you need design rationale or file-level detail, refer to the **enterprise implementation plan** (e.g. §5.1 for exact schema, §6.1 for which routes are tenant-scoped). Together they define the full scope of the hosted multi-tenant overhaul.

**Execution order:** **0a** (Dome removal) → 0 (egress) → 1 → 2 → 3 → 3b → 4 → 5 → **6** (admin) → **7** (monitoring/dashboards).

---

## Decisions (locked in)

- **Same wallet, multiple tenants:** Yes. The same wallet address can be tracked by more than one tenant. Each tenant executes with **their own filters** (trade size, side filter, price limits, etc.) when copying that wallet. Implement with composite primary key `(tenant_id, address)` on `tracked_wallets`.
- **Egress:** Hetzner account in use. Validation script lives in the repo; run it once from the VPS after provisioning (minimal steps: clone, env, run script). Aim for minimal human intervention (script is the only manual step after VPS is up).
- **Login (OIDC):** OIDC = “login with your own account” via a provider (Auth0, Cognito, Keycloak). Implement with env placeholders and short docs so you can add credentials later. Until then, `API_SECRET` continues to work for single-tenant/default.
- **Admin:** Use env allowlist `ADMIN_TENANT_IDS` (comma-separated tenant IDs). No IdP role required initially. Document; IdP-based admin can be added later if needed.

---

## UI-first principle: do everything possible in the dashboard

**Goal:** As much as possible should be doable through the in-app UI (or clear dashboard panels). Avoid requiring env edits, config files, or SSH for normal operation. Custom dashboards here means the app’s own dashboard (tenant + admin), not an external analytics product.

### What already belongs in the UI (keep or add)

- **Tenant:** Tracked wallets (add/remove/toggle, per-wallet trade config), trading wallets and copy assignments, global and per-wallet config (trade size, stop-loss, monitoring interval, no-repeat, price limits, slippage, side filter, rate limits, value filters), wallet unlock, start/stop bot, trade history, performance, discovery (browse + track). All of this is already API-backed; ensure it remains fully usable from the Win95 dashboard with no env required for day-to-day use.
- **Admin (Phase 6–7):** Tenant list, enable/disable tenant, audit log view, trade log (with tenant filter), system health. Implement as dashboard tabs/panels, not only API.

### Additions to make more “UI-first” and easier to use

1. **Egress validation from the UI (Phase 0)**  
   Add an **admin-only** “Validate egress” (or “Connection check”) action that runs the same checks as the validation script (geoblock, read-only CLOB/Data API, optional test order path) from the **running app** and shows pass/fail and any error in the dashboard. Reduces reliance on SSH: deploy app, open admin UI, click “Validate egress” and fix provider if it fails. Keep the standalone script for use before first deploy or from a different host if needed.

2. **Admin list manageable from UI (Phase 6)**  
   Store admin tenant IDs in DB/config (e.g. `admin_tenant_ids` in bot_config or a small `admins` table) so a **bootstrap admin** (first user or env `ADMIN_TENANT_IDS` at first run) can add/remove admins from the dashboard. Env `ADMIN_TENANT_IDS` remains optional for initial bootstrap or override; once set from UI, no env change needed to add/remove admins.

3. **Single “Settings” / “Config” surface for tenant**  
   One place in the UI that shows and edits all tenant-scoped config: trade size, monitoring interval, stop-loss, no-repeat, price limits, slippage, side filter, rate limits, value filters, proxy wallet (if used). Avoid scattering these across many screens; use a single Settings or “My config” page with clear sections and links to “per-wallet” overrides where applicable.

4. **Discovery and global options in UI (Phase 4 / 7)**  
   Discovery config (e.g. poll interval, market count) is already API (`GET/POST /api/discovery/config`). Expose it in the dashboard: admin or a “Discovery settings” panel so no one has to edit env or DB for discovery tuning. If we add global rate-limiter or per-tenant fairness settings (Phase 3b), expose read (and where safe, edit) in admin “System” or “Rate limits” panel so operators can see and adjust without code/env.

5. **System health and one-glance status (Phase 7)**  
   Admin dashboard: one panel or “System health” tab showing Polymarket reachable (or last egress check result), rate limiter status, CopyTrader running, Discovery status, and optionally last trade log activity. So “is everything okay?” is answerable from the UI, not logs or SSH.

6. **Backup and maintenance in UI (Phase 5 / 6)**  
   Admin-only “Maintenance” or “Data”: “Download backup” (DB + critical config export) and a short note or reminder “Back up before major upgrades.” Optional: “Run egress check” and “View last egress result” in the same place so all operational checks live in the dashboard.

7. **First-run / setup flow (optional)**  
   After deploy, if no tenant has been set up yet, show a short “Getting started” or “Setup” flow in the UI: e.g. “Run egress check” → “Add your first trading wallet” (or “Log in” when OIDC is configured). Keeps “minimal human intervention” to: deploy with minimal env, open URL, follow UI steps; no requirement to SSH or edit env for standard setup.

### What stays outside the UI (by design)

- **Secrets:** Private keys, Builder secret/passphrase, OIDC client secret. Entered once via UI (e.g. “Add trading wallet” / “Connect Polymarket”) or set in env for automation; not re-displayed in full.
- **Server-level env:** PORT, DATA_DIR, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI. Document in “Settings → Login provider” or “Deploy docs” with a note that these are set on the server; optional “Status: OIDC configured” (yes/no, no secrets) in UI.
- **Bootstrap admin:** First admin can come from env `ADMIN_TENANT_IDS` or from the first user when no admins exist; after that, admin list is managed from the UI.

### Implementation notes

- Phase 0: add backend endpoint (e.g. `POST /api/admin/egress-check` or `GET /api/admin/egress-status`) that runs validation logic and returns result; admin UI calls it and shows pass/fail and message.
- Phase 6: add storage for admin list (DB or config), API to list/add/remove admins (restricted to current admins), and Admin tab “Admins” to manage the list.
- Phase 7: ensure “System health” and “Trade log” are full dashboard panels with filters and clear labels, not only API.
- Existing config endpoints remain the single source of truth; UI is the primary way to change them; no duplicate “config file” flow.

---

## Phase 0a: Remove Dome (deprecated)

Dome is deprecated and no longer usable. Remove all references before multi-tenant work. WalletMonitor (Data API polling) is the sole trade detection source after this.

- [ ] **0a.1** Delete `src/domeWebSocket.ts` and `src/domeClient.ts`.
- [ ] **0a.2** In `src/copyTrader.ts`: remove DomeWebSocketMonitor import, instance, start/stop/events, `getDomeWsMonitor()`, `domeWs` from status.
- [ ] **0a.3** In `src/index.ts`, `src/config.ts`, `src/api/routes.ts`: remove Dome config, routes (`GET /dome/status`), and Dome fields from `GET /status`; remove `domeWs.addWallet`/`removeWallet` from wallet routes.
- [ ] **0a.4** In `src/arbScanner.ts`, `src/entityManager.ts`, `src/polymarketApi.ts`, `src/priceMonitor.ts`, `src/platform/polymarketAdapter.ts`, `src/platform/kalshiAdapter.ts`: remove Dome imports and usage; use PolymarketApi/KalshiClient only.
- [ ] **0a.5** In `src/tradeDiagnostics.ts`, `src/types.ts`, `tests/tradeDiagnostics.test.ts`: remove `summarizeDomeTradeForDebug`, `domeUserId`, and Dome test.
- [ ] **0a.6** In `package.json` remove `@dome-api/sdk`; in `ENV_EXAMPLE.txt` remove `DOME_API_KEY`; in `.cursor/rules/trade-safety-invariants.mdc` and `agent-knowledge.mdc` remove Dome references.

**Verification:** `npm test` and `npm run build` pass; `rg -i dome src/` returns no matches (except comments).

---

## Will this plan work perfectly? Risks and mitigations

| Risk | Mitigation |
|------|------------|
| **AsyncLocalStorage context lost after `next()`** | Use `tenantStorage.enterWith({ tenantId })` in auth middleware (not `run()`). Context then persists for the entire request including async route handlers. Place tenant middleware **after** `express.json()` so body parsing does not run in a different context. |
| **Tenant ID in keystore path** | Sanitize `tenantId` from JWT: allow only alphanumeric, hyphen, underscore (regex). Reject or default if invalid to prevent path traversal (e.g. `../`). |
| **WalletManager global state** | Refactor so trading wallets and copy assignments are **not** stored in module-level variables. Read from `Storage.loadConfig()` (tenant-scoped via `getTenantId()`) when each API or executor call runs. Only call WalletManager when tenant context is set. |
| **Monitor needs all tenants’ wallets** | Background polling has no request context. Add a DB/Storage function that returns **all** active tracked wallets **with** `tenant_id` (e.g. `dbLoadAllActiveTrackedWalletsForMonitoring()`). Do not filter by tenant. When a trade is detected, use that wallet’s `tenant_id` and call `runWithTenant(trade.tenantId, ...)`. |
| **Cleanup expired positions at startup** | CopyTrader init has no tenant. Run cleanup per tenant: get distinct `tenant_id` from `executed_positions`, then for each id run `runWithTenant(tenantId, () => Storage.cleanupExpiredPositions(...))`. |
| **“User wallet” / getWalletAddress()** | In multi-tenant, “user wallet” is per-tenant (primary or active trading wallet). Ensure `TradeExecutor.getWalletAddress()` and CopyTrader’s use of it resolve from **current tenant’s** config/WalletManager (via `getTenantId()`). No global default. |
| **Same address tracked by two tenants** | Decide: (A) Allow — use composite primary key `(tenant_id, address)` on `tracked_wallets`. (B) Disallow — keep `address` as PK; when adding, return error if address already exists for another tenant. Document and implement one. |
| **JWT validation edge cases** | Use `clockTolerance: 30`–`60` seconds in `jwt.verify()` for server clock skew. Explicitly set `algorithms: ['RS256']` (or your IdP’s alg) to prevent “none” alg. Validate `aud` if IdP provides it. |
| **Token leakage on OIDC callback** | Do not pass access token in URL query or fragment. Prefer: backend sets HTTP-only cookie with token and redirects to `/`, or callback page receives token in response body (e.g. POST from backend) and stores in sessionStorage. |
| **DB migration data loss** | Before running schema migration (Phase 1.1), backup `copytrade.db` (and any JSON data in `data/`). Run migration in a single transaction; if it fails, restore backup. |
| **Trade safety invariants** | All six invariants in `.cursor/rules/trade-safety-invariants.mdc` must hold in the tenant-aware flow: no-repeat and addExecutedPosition per tenant; in-flight keyed by tenant; stop-loss fail-safe; wallet settings passed through; order size cap; rebuild after changes. |
| **Global API rate limit** | Polymarket CLOB enforces rate limits ([Rate Limits](https://docs.polymarket.com/api-reference/rate-limits)): POST /order 3,500/10s burst, 36,000/10 min sustained. If many profiles submit at once, 429s can block everyone. Implement a **global** rate limiter (token bucket or sliding window) through which all order submissions pass, so the app never exceeds the API cap. |
| **One tenant starving others** | Without fairness, one busy profile can consume all API capacity. Add **per-tenant fairness**: e.g. a shared queue drained in round-robin or Deficit Round Robin (DRR) so each active tenant gets a share of the global limit. Alternatively, cap max in-flight orders per tenant so no single tenant can monopolize. |
| **Duplicate orders on retry** | Network timeouts or retries can cause the same order to be sent twice. Use **idempotency**: generate a unique key per order intent (e.g. `tenantId:marketId:side:nonce` or UUID), pass as `Idempotency-Key` header if Polymarket supports it; use client `nonce` in order payload. Treat API response `INVALID_ORDER_DUPLICATED` as success (order already exists). |
| **Polymarket session heartbeat** | If the CLOB session does not receive a heartbeat within ~10 seconds, Polymarket may cancel **all** open orders for that session. Verify whether the current CLOB client or SDK sends heartbeats; if not, implement periodic heartbeat so all profiles’ open orders are not cancelled. |
| **SQLite lock contention** | Many tenants writing at once can cause `SQLITE_BUSY`. Use WAL (already in use); add `PRAGMA busy_timeout = 5000` so the DB waits up to 5s for lock instead of failing immediately. Keep write transactions short. |
| **One tenant’s errors affecting others** | Bad API key or repeated failures for one tenant should not block others. Optional: **per-tenant circuit breaker** — after N consecutive failures for a tenant, stop submitting that tenant’s orders for a cooldown period; other tenants continue. |

**Research source:** [multitenant-concurrent-trade-execution.md](../../multitenant-concurrent-trade-execution.md) (Parallel deep research).

---

## Polymarket and Builder docs compliance

The plan must adhere to [Polymarket’s official documentation](https://docs.polymarket.com/). Below are the doc-backed constraints and how the plan satisfies them.

### Rate limits (CLOB API)

Per [Polymarket Rate Limits](https://docs.polymarket.com/api-reference/rate-limits):

| Endpoint | Burst | Sustained |
|----------|--------|-----------|
| `POST /order` | 3,500 req / 10s | 36,000 req / 10 min |
| `DELETE /order` | 3,000 req / 10s | 30,000 req / 10 min |
| `POST /orders` (batch) | 1,000 req / 10s | 15,000 req / 10 min |

- Limits are enforced by Cloudflare (throttling/queuing, not immediate reject); sliding time windows.
- **Plan:** Phase 3b global rate limiter must use these exact limits (or lower) so the app never exceeds them when multiple profiles trade at once.

### Error handling (CLOB)

Per [Polymarket Error Codes](https://docs.polymarket.com/resources/error-codes):

- **429 Too Many Requests** — Exceeded rate limit. Implement exponential backoff and retry.
- **425 Too Early** — Matching engine restarting. Retry with backoff.
- **`order {id} is invalid. Duplicated.`** — Duplicate order. Treat as success (order already exists); do not retry as a new order.
- **`invalid nonce`** — Nonce already used or invalid. Do not retry with same nonce; use a new nonce for a new order intent.

**Plan:** Phase 3b idempotency and duplicate handling must treat “Duplicated” as success; retry logic must use exponential backoff on 429/425 and the same idempotency key for the same intent. For **425 Too Early** (matching engine restarting), follow docs and retry with backoff.

### Builder program and order attribution

Per [Builder Program](https://docs.polymarket.com/developers/builders/builder-intro) and [Order Attribution](https://docs.polymarket.com/developers/builders/order-attribution):

- **Credentials:** From [polymarket.com/settings?tab=builder](https://polymarket.com/settings?tab=builder): `key`, `secret`, `passphrase`. Stored as env (e.g. `POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_SECRET`, `POLYMARKET_BUILDER_PASSPHRASE`).
- **Purpose:** Builder credentials are for **order attribution only**. User/wallet credentials are still required for CLOB authentication (L1/L2).
- **Headers:** Each order request must include `POLY_BUILDER_API_KEY`, `POLY_BUILDER_TIMESTAMP`, `POLY_BUILDER_PASSPHRASE`, `POLY_BUILDER_SIGNATURE` (HMAC). The official CLOB client + Builder config (local or remote signing) attach these automatically.
- **Security:** Never expose builder credentials client-side or in version control; use server-side env or secrets. Use different keys for dev/staging/production if applicable.

**Plan:** The app already uses Builder API for attribution (see agent-knowledge and `.cursor/rules/polymarket-auth.mdc`). Multi-tenant changes must not break this: each tenant’s orders are placed with **that tenant’s** wallet/auth; builder credentials can remain server-level (one builder profile per deployment) so all orders are attributed to the same builder. Ensure CLOB client is still created with Builder config (local creds from env) so every `createAndPostOrder` sends the builder headers.

### APIs and base URLs

Per [APIs at a Glance](https://docs.polymarket.com/quickstart/introduction/endpoints):

- **CLOB API:** `https://clob.polymarket.com` — prices, orderbooks, order placement.
- **Data API:** `https://data-api.polymarket.com` — positions, activity, history.
- **Gamma API:** `https://gamma-api.polymarket.com` — market discovery and metadata.

**Plan:** Config (and validation script) should use these base URLs unless overridden by env. No change to existing `config.polymarketClobApiUrl` etc.

### Data API and Gamma rate limits

- Data API: General 1,000 req/10s; `/trades` 200/10s; `/positions` 150/10s.
- Gamma: General 4,000 req/10s; `/events` 500/10s; `/markets` 300/10s.

**Plan:** Discovery and wallet monitoring that call Data API or Gamma should stay within these limits (existing polling intervals and batch sizes). If adding new polling or bulk reads, cap concurrency and request rate per these limits.

### Matching engine and session behavior

- **425 Too Early:** Returned when the matching engine is restarting; retry with backoff (see [Error Codes](https://docs.polymarket.com/resources/error-codes) and [Matching Engine](https://docs.polymarket.com/trading/matching-engine) if linked).
- **Heartbeat:** If CLOB or matching-engine docs specify a session heartbeat (e.g. to avoid cancelling open orders), Phase 3b.4 must implement or verify SDK behavior so all tenants’ orders are not cancelled due to idle session.

---

## Phase 0: Egress and hosting (Hetzner, validate then proceed)

- [ ] **0.1** Provision a Hetzner VPS in an EU region (Falkenstein, Nuremberg, or Helsinki). Small size (e.g. 2 vCPU, 4 GB RAM). Confirm **fixed/static outbound IP** and document it.
- [ ] **0.2** Create `scripts/validate-polymarket-egress.mjs` (or `.ts` with tsx): call geoblock if documented; call read-only CLOB/Data API endpoint; optionally with Builder creds hit a trading-related endpoint. Exit 0 on success, non-zero on failure; print pass/fail and errors.
- [ ] **0.3** Add `docs/plans/egress-validation.md`: how to run, env vars, how to interpret pass/fail.
- [ ] **0.4** On VPS: clone repo, `npm install`, set env, run validation script.
- [ ] **0.5** If **pass**: proceed to Phase 1. If **fail**: provision VPS on DigitalOcean (London/Frankfurt), Vultr (London/Amsterdam), or OVH (EU) with static IP; re-run script; repeat until pass.
- [ ] **0.6** (Optional) After stable IP passes, contact Polymarket for IP allowlisting.
- [ ] **0.7** (UI-first) Add admin-only endpoint (e.g. `POST /api/admin/egress-check` or `GET /api/admin/egress-status`) that runs the same validation logic as the script from the running app and returns pass/fail and error message. Admin dashboard: “Validate egress” / “Connection check” button that calls it and shows result so operators don’t need SSH to verify.

**Verification:** Script exits 0 when run from chosen VPS; admin can run egress check from UI and see result.

---

## Phase 1: Tenant identity and storage

### 1.1 Database backup and schema migration

- [ ] **1.1.0** Backup: copy `data/copytrade.db` and `data/*.json` (if used) to a safe location before changing schema. If migration fails, restore from backup.
- [ ] **1.1.1** In `src/database.ts`, add `tenant_id TEXT NOT NULL DEFAULT 'default'` to `tracked_wallets` via `safeAddColumn`. Add index `idx_tracked_wallets_tenant`.
- [ ] **1.1.2** Add `tenant_id TEXT NOT NULL DEFAULT 'default'` to `executed_positions` and index `idx_executed_positions_tenant`.
- [ ] **1.1.3** Use composite PK `(tenant_id, address)` on `tracked_wallets` so the same address can be tracked by multiple tenants; each tenant’s execution uses their own filters (per Decisions above).
- [ ] **1.1.4** Migrate `bot_config` to composite key: create `bot_config_new(tenant_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (tenant_id, key))`. In one transaction: copy existing rows with `tenant_id = 'default'`, drop `bot_config`, rename to `bot_config`.
- [ ] **1.1.5** Backfill: UPDATE `tracked_wallets` and `executed_positions` SET `tenant_id = 'default'` WHERE `tenant_id` IS NULL OR `tenant_id = ''`.

### 1.2 Tenant context module

- [ ] **1.2.1** Create `src/tenantContext.ts`: `AsyncLocalStorage<{ tenantId: string }>`, `getTenantId(): string | undefined`, `runWithTenant<T>(tenantId: string, fn: () => T): T`. Optionally add `enterWith(tenantId: string)` that calls `tenantStorage.enterWith({ tenantId })` for use in Express middleware.

### 1.3 Database layer (tenant-scoped)

- [ ] **1.3.1** `dbLoadTrackedWallets(tenantId?: string)`: when `tenantId` provided, add `WHERE tenant_id = ?`. When not provided (monitoring path), return all rows with `tenant_id` so monitor can attribute trades to tenants.
- [ ] **1.3.2** `dbSaveTrackedWallets(wallets, tenantId: string)`: write only rows for that tenant (delete where tenant_id = ? then insert).
- [ ] **1.3.3** `dbLoadConfig(tenantId: string)` and `dbSaveConfig(configData, tenantId: string)`: filter/write by `tenant_id`.
- [ ] **1.3.4** `dbLoadExecutedPositions(tenantId: string)` and `dbSaveExecutedPositions(positions, tenantId: string)`: filter/write by `tenant_id`.
- [ ] **1.3.5** Add `dbLoadAllActiveTrackedWalletsForMonitoring()`: returns all rows from `tracked_wallets` WHERE `active = 1`, including `tenant_id` (for WalletMonitor/DomeWebSocket; no tenant filter).

### 1.4 Storage layer (tenant-scoped)

In `src/storage.ts`, tenant-scoped methods use `getTenantId()` and pass to DB. If tenant missing when required, throw or 403.

- [ ] **1.4.1** `loadTrackedWallets()`: require `getTenantId()`, pass to `dbLoadTrackedWallets(tenantId)`. Add `loadAllActiveTrackedWalletsForMonitoring()` that calls `dbLoadAllActiveTrackedWalletsForMonitoring()` (no tenant; for monitor only).
- [ ] **1.4.2** `addWallet`, `removeWallet`, `getWallet`, `getActiveWallets`: use `getTenantId()`; add/remove/get filter by tenant_id and address. If you chose (B) in 1.1.3, in `addWallet` check that address does not exist for another tenant and error if it does.
- [ ] **1.4.3** All wallet update methods: include `tenant_id` in WHERE.
- [ ] **1.4.4** All config getters/setters: use `getTenantId()` and pass to `dbLoadConfig`/`dbSaveConfig(tenantId)`.
- [ ] **1.4.5** All executed-positions methods: use `getTenantId()` and pass to DB. Discovery tables remain global.

### 1.5 Auth middleware and tenant context (use enterWith)

- [ ] **1.5.1** In `src/server.ts`, place tenant middleware **after** `express.json()` and the existing `/api` gate. For requests with Bearer token: verify JWT (signature, issuer, expiry, `clockTolerance: 30`–`60`, explicit `algorithms`). Extract tenant id (e.g. `payload.sub`). **Sanitize** tenantId (e.g. only `[a-zA-Z0-9_-]+`); if invalid, 401. Call `tenantStorage.enterWith({ tenantId })` then `next()`. Do **not** use `run(tenantId, () => next())` — context would not persist into async route handlers.
- [ ] **1.5.2** If no JWT but valid `API_SECRET`, call `tenantStorage.enterWith({ tenantId: 'default' })` then `next()`.
- [ ] **1.5.3** Ensure all tenant-scoped `/api` routes and discovery `POST .../track` run after this middleware.

### 1.6 Types

- [ ] **1.6.1** In `src/types.ts`, add `tenantId: string` (required in multi-tenant code paths) or `tenantId?: string` to `DetectedTrade`.

**Verification:** `npm test`. Start app, call API with tenant context (e.g. API_SECRET so tenant = default), add tracked wallet, confirm DB has correct `tenant_id`.

---

## Phase 2: Per-tenant config and keystore

- [ ] **2.1** In `src/secureKeyManager.ts`, `keystoresDir()` = `path.join(config.dataDir, 'keystores', (getTenantId() ?? 'default').replace(/[^a-zA-Z0-9_-]/g, ''))` or reject if tenantId contains invalid chars. Create tenant subdir on first keystore write. All keystore read/write use this path.
- [ ] **2.2** In `src/config.ts`, stop using global `PRIVATE_KEY` and Builder env for execution; keep server-only env (PORT, DATA_DIR, OIDC, API URLs).
- [ ] **2.3** Refactor `src/walletManager.ts`: remove module-level `tradingWallets` and `copyAssignments`. Every function that reads or writes wallets/assignments must call `Storage.loadConfig()` with `getTenantId()` (or get config from Storage when called) and use that tenant’s `tradingWallets`/`copyAssignments`. Write back via `Storage.saveConfig()` with same tenant. `initWalletManager()` may only ensure Storage/DB is ready; do not load a global list. Ensure no code path calls WalletManager without tenant context (API has context; CopyTrader path uses `runWithTenant` in Phase 3).
- [ ] **2.4** Ensure `TradeExecutor.getWalletAddress()` (and any “current user wallet” in CopyTrader) resolves from **current tenant’s** WalletManager/config (i.e. when called inside `runWithTenant`, `getTenantId()` is set and WalletManager returns that tenant’s primary or active trading wallet).

**Verification:** `npm test`. Add trading wallet via API; keystore under `data/keystores/<tenant_id>/`. Call from different tenant context; different tenant’s list.

---

## Phase 3: CopyTrader and execution tenant-aware

- [ ] **3.1** In `src/walletMonitor.ts`, load wallets via `Storage.loadAllActiveTrackedWalletsForMonitoring()` (all active with `tenant_id`). When building `DetectedTrade`, set `trade.tenantId` from wallet. When calling CopyTrader: `runWithTenant(trade.tenantId, () => copyTrader.handleDetectedTrade(trade))`.
- [ ] **3.2** ~~DomeWebSocket~~ **Removed in Phase 0a.** WalletMonitor (Data API polling) is now the sole trade detection source. No action needed here.
- [ ] **3.3** In `src/copyTrader.ts`, at start of `handleDetectedTrade` ensure tenant context is set (caller must have used `runWithTenant`). Key `inFlightTrades` and `processedCompoundKeys` by `tenantId + ':' + tradeKey`. Preserve all trade-safety invariants (no-repeat, in-flight add before await, try/finally cleanup, stop-loss fail-safe, wallet settings passed through, order size cap).
- [ ] **3.4** CopyTrader init cleanup: get distinct tenant_ids from `executed_positions` (or from tracked_wallets), then for each run `runWithTenant(tenantId, () => Storage.cleanupExpiredPositions(...))` with that tenant’s max block period.
- [ ] **3.5** Confirm `TradeExecutor` is only invoked inside tenant context; no interface change.

**Verification:** `npm test`. Two tenants, different configs; trigger trade for one tenant’s wallet — only that tenant’s executor and keys used. Re-check trade-safety invariants.

---

## Phase 3b: Multi-profile concurrent execution (all profiles can trade at once without fail)

These items ensure multiple profiles can execute trades concurrently without one profile blocking or breaking another. Implement after Phase 3; verify before Phase 4.

- [ ] **3b.1 Global CLOB rate limiter**  
  Introduce a **single** global rate limiter for Polymarket CLOB `POST /order` (and cancel if used). Configure to stay under [Polymarket’s documented limits](https://docs.polymarket.com/api-reference/rate-limits): **3,500 req/10s** burst, **36,000 req/10 min** sustained for `POST /order`. All order submissions from any tenant must acquire a token from this limiter before calling the CLOB client. Use a token bucket or sliding-window counter; on **429 Too Many Requests** from API, use exponential backoff and retry with same idempotency key (per [Error Codes](https://docs.polymarket.com/resources/error-codes)). Implement in a small module (e.g. `src/clobRateLimiter.ts`) used by `TradeExecutor` or the CLOB client wrapper.

- [ ] **3b.2 Per-tenant fairness**  
  Ensure one tenant cannot consume the whole global limit. Option A: **per-tenant queue** — each tenant’s order intents go into a tenant-specific queue; a single dispatcher pulls from queues in round-robin (or DRR) and submits through the global limiter. Option B (simpler): **per-tenant cap** — limit max concurrent in-flight order requests per tenant (e.g. 5 or 10); when a tenant is at cap, additional intents wait or are deferred so other tenants can submit. Implement either so that under load, every active tenant gets a share of API capacity.

- [ ] **3b.3 Idempotency and duplicate handling**  
  For each order intent, generate a **stable idempotency key** (e.g. `tenantId:marketId:outcome:side:nonce` or UUID stored with the intent). Use the same key for any retry of that same intent. If Polymarket supports an `Idempotency-Key` (or similar) header, send it. Include a client-side `nonce` in the order payload if the API accepts it. Per [Polymarket Error Codes](https://docs.polymarket.com/resources/error-codes), when the API returns **`order {id} is invalid. Duplicated.`** (Order Processing Errors), treat it as **success** (order already exists); do not retry. Handle **`invalid nonce`** by not retrying with the same nonce — use a new nonce for a new order intent. Return success to the caller so no duplicate order is placed.

- [ ] **3b.4 Polymarket session heartbeat**  
  Check Polymarket CLOB/session docs and the current `@polymarket/clob-client` (or relayer) usage: if the session requires a **heartbeat** within ~10 seconds or all open orders are cancelled, ensure the app sends that heartbeat (e.g. periodic keepalive or heartbeat endpoint). If the SDK does it automatically, document that. If not, add a background task that sends the heartbeat at an interval less than the timeout (e.g. every 8s) so all tenants’ orders are not cancelled due to idle session.

- [ ] **3b.5 SQLite busy timeout**  
  In `src/database.ts`, after opening the DB, run `PRAGMA busy_timeout = 5000` (or equivalent in better-sqlite3) so that under concurrent write load from multiple tenants, the DB waits up to 5s for lock instead of immediately returning `SQLITE_BUSY`. Keep write transactions short (batch where possible).

- [ ] **3b.6 (Optional) Per-tenant circuit breaker**  
  If a tenant’s orders repeatedly fail (e.g. auth or invalid request), optionally open a **circuit breaker** for that tenant: stop submitting their orders for a cooldown (e.g. 60s); other tenants unaffected. After cooldown, try again. Log when circuit opens so operators can fix that tenant’s config.

- [ ] **3b.7 Connection reuse**  
  Ensure HTTP requests to Polymarket CLOB use **connection keep-alive** (reuse one client/agent per process or per CLOB base URL) so many concurrent orders do not create a new connection per request. If using axios, use a shared instance with `httpAgent`/`httpsAgent` and `keepAlive: true`; or consider `undici` for connection pooling.

**Verification:** Run several profiles with active copy-trading; trigger trades for multiple tenants at once. Confirm: (1) no 429 from Polymarket due to exceeding rate limit, (2) each tenant’s trades execute (no indefinite starvation), (3) retrying a timed-out request does not create a duplicate order, (4) open orders are not cancelled due to missing heartbeat. Load test with 5–10 tenants if possible.

---

## Phase 4: API and frontend

### 4.1 OIDC (backend)

- [ ] **4.1.1** IdP: Auth0, Cognito, or Keycloak. Env: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`. Document.
- [ ] **4.1.2** `GET /auth/login`: redirect to IdP with `response_type=code`, `scope=openid profile`, `redirect_uri`, `state` (crypto-random), `client_id`.
- [ ] **4.1.3** `GET /auth/callback`: exchange `code` for tokens. **Do not** put access token in URL. Set HTTP-only cookie with token and redirect to `/`, or return HTML that POSTs token to a small endpoint which sets cookie or returns success so a script can store in sessionStorage and redirect.
- [ ] **4.1.4** Optional `GET /auth/me`: decode JWT (from cookie or Authorization), return `{ tenantId: sub, ... }`.
- [ ] **4.1.5** `POST /auth/logout`: clear auth cookie if any; 200. Frontend clears token and redirects.

### 4.2 Auth middleware (JWT)

- [ ] **4.2.1** Verify JWT with `clockTolerance: 30`–`60`, explicit `algorithms`, optional `aud`. Extract and sanitize `tenantId`; use `enterWith` as in 1.5.1.

### 4.3 Discovery track

- [ ] **4.3.1** `POST /api/discovery/wallets/:address/track`: runs after auth; call `Storage.addWallet(address)` (tenant from context). If using (B) from 1.1.3, handle “already tracked by another tenant” error.
- [ ] **4.3.2** Optional `GET /api/discovery/wallets/:address/tracked-by-me`: return `{ trackedByMe }` from current tenant’s tracked list.

### 4.4 Frontend

- [ ] **4.4.1** Login entry: no token → show “Log in” or redirect to `/auth/login`. Callback page stores token (cookie already set by backend, or script writes to sessionStorage from response) and redirects to dashboard.
- [ ] **4.4.2** When logged in, show “Log out”; on click clear token and call `POST /auth/logout`, redirect to login.
- [ ] **4.4.3** `api.js`: send Bearer (or cookie); on 401 clear token and trigger login.
- [ ] **4.4.4** (UI-first) Single “Settings” or “My config” page for tenant: all tenant-scoped config in one place (trade size, monitoring interval, stop-loss, no-repeat, price limits, slippage, side filter, rate limits, value filters, proxy wallet) with clear sections and links to per-wallet overrides. Expose discovery config (`GET/POST /api/discovery/config`) in dashboard (admin or “Discovery settings” panel).

**Verification:** Full OIDC flow; token not in URL. Two users; track wallet as User A only; User B’s list unchanged. Tenant can change all config from one Settings view.

---

## Phase 5: Hardening and 24/7

- [ ] **5.1** **Audit log (expanded):** Persist full audit trail: `tenant_id`, `actor` (who did it), `action` (e.g. `trade_executed`, `trade_failed`, `wallet_added`, `tenant_disabled`), `resource` (order id, wallet address, etc.), `timestamp`, `outcome`, optional `details`. Store in SQLite table `audit_log` (or append-only file); document location. Index by tenant_id and timestamp for admin queries.
- [ ] **5.2** VPS: PM2 or systemd; restart on crash. Optional external health check on `/health`.
- [ ] **5.3** Final pass: all six trade-safety invariants hold in tenant-aware flow (see `.cursor/rules/trade-safety-invariants.mdc`).

**Verification:** Deploy, hit `/health`, trigger trade and tenant action, confirm audit log has correct rows.

---

## Phase 6: Admin and user management

- [ ] **6.1** **Admin role:** Define admin via IdP role/group (e.g. Auth0 role `admin`) or env allowlist `ADMIN_TENANT_IDS=sub1,sub2`. Middleware: routes under `/api/admin/*` require admin; else 403.
- [ ] **6.2** **Access control:** Table or config: `tenant_id`, `enabled` (boolean). On every tenant-scoped API request, if tenant disabled → 403. Admin can set enabled/disabled via API.
- [ ] **6.3** **Admin API:** `GET /api/admin/tenants` (list tenants, enabled, last active, counts); `POST /api/admin/tenants/:id/disable`; `POST /api/admin/tenants/:id/enable`; `GET /api/admin/audit` (query audit_log with filters). Optional `GET /api/admin/me` (am I admin?).
- [ ] **6.4** **User password/profile:** We do not store passwords. Document and link to IdP profile (e.g. “Manage account” → IdP URL). Optional: button in dashboard that opens IdP profile in new tab.
- [ ] **6.5** **Admin dashboard UI:** If user is admin, show “Admin” tab: tenant list with Disable/Enable; link to audit log view; link to trade log (Phase 7).
- [ ] **6.6** (UI-first) **Admin list from UI:** Store admin tenant IDs in DB or config (e.g. `admin_tenant_ids` or `admins` table). API: list admins, add admin, remove admin (restricted to current admins). Admin tab “Admins” panel to manage list. Env `ADMIN_TENANT_IDS` remains optional for bootstrap; after that admins are managed in UI.
- [ ] **6.7** (UI-first) **Maintenance in UI:** Admin “Maintenance” or “Data” panel: “Download backup” (DB + critical config export), “Run egress check” (calls 0.7 endpoint), “View last egress result.” Short note “Back up before major upgrades.”

**Verification:** Admin can list tenants, disable/enable; disabled tenant gets 403. Non-admin cannot access `/api/admin/*`. Admin can add/remove admins and run egress check from UI.

---

## Phase 7: Monitoring, trade log, and operational dashboards

- [ ] **7.1** **Trade event store:** Persist trade lifecycle (e.g. table `trade_events`): `event_type` = `detected` | `filtered` | `executed` | `failed`, plus tenant_id, wallet, market, side, amount, reason, created_at. Write from CopyTrader/WalletMonitor and TradeExecutor at each step. Retention: last N days or size-bound; document.
- [ ] **7.2** **Trade log API:** `GET /api/trade-log` (tenant-scoped, current user’s events); `GET /api/admin/trade-log` (admin, optional filter by tenant_id). Params: limit, since, event_type.
- [ ] **7.3** **Detection/execution metrics:** Counts per tenant (detected, passed_filters, executed, failed with reason). Expose via status or `GET /api/admin/health` (extended) for admin dashboard.
- [ ] **7.4** **Dashboard UI:** Tenant: “Trade log” or “Recent activity” panel (last N events). Admin: “Trade log” tab (filter by tenant); “System health” panel with one-glance status: Polymarket reachable (or last egress result), rate limiter status, CopyTrader running, Discovery status, last trade activity. Use `GET /api/trade-log` and admin endpoints. Expose Phase 3b rate-limiter / fairness settings (read, and where safe edit) in admin “System” or “Rate limits” so operators can tune without env.
- [ ] **7.5** (Optional) Alerts: e.g. tenant with active wallets but 0 detections in 24h → log warning. Document as future work.
- [ ] **7.6** (UI-first, optional) **First-run / setup flow:** If no tenant set up yet, show “Getting started” or “Setup” in UI: run egress check, add first trading wallet or log in when OIDC is configured. Minimal env for deploy; rest via UI.

**Verification:** Trade log shows detected/executed/failed; admin can filter by tenant; system health visible at a glance; optional setup flow works for first deploy.

---

## Provider swap (if Phase 0 fails on Hetzner)

Provision DigitalOcean / Vultr / OVH in EU with static IP; re-run validation script; use that host for Phases 1–5. No code changes.

---

## File summary

| Action | File |
|--------|------|
| Add | `scripts/validate-polymarket-egress.mjs` (or .ts) |
| Add | `docs/plans/egress-validation.md` |
| Add | `src/tenantContext.ts` (getTenantId, runWithTenant, enterWith) |
| Edit | `src/database.ts` (schema, migration, tenant-scoped + monitoring load) |
| Edit | `src/storage.ts` (tenant-scoped + loadAllActiveTrackedWalletsForMonitoring) |
| Edit | `src/config.ts` (no global PRIVATE_KEY/Builder for execution) |
| Edit | `src/secureKeyManager.ts` (keystoresDir + tenantId sanitize) |
| Edit | `src/walletManager.ts` (no global cache; read/write via Storage per getTenantId) |
| Delete (Phase 0a) | `src/domeWebSocket.ts`, `src/domeClient.ts` (Dome deprecated) |
| Edit (Phase 0a) | `src/copyTrader.ts`, `src/index.ts`, `src/config.ts`, `src/api/routes.ts`, `src/arbScanner.ts`, `src/entityManager.ts`, `src/polymarketApi.ts`, `src/priceMonitor.ts`, `src/platform/polymarketAdapter.ts`, `src/platform/kalshiAdapter.ts`, `src/tradeDiagnostics.ts`, `src/types.ts`, `tests/tradeDiagnostics.test.ts`, `package.json`, `ENV_EXAMPLE.txt`, `.cursor/rules/trade-safety-invariants.mdc`, `.cursor/rules/agent-knowledge.mdc` — remove all Dome references |
| Edit | `src/walletMonitor.ts`, `src/copyTrader.ts` |
| Edit | `src/types.ts` (DetectedTrade.tenantId) |
| Edit | `src/server.ts` (tenant middleware after express.json; enterWith; JWT + sanitize) |
| Edit | `src/api/discoveryRoutes.ts` (track with tenant context) |
| Edit | `public/js/app.js` (login, logout, callback) |
| Edit | `ENV_EXAMPLE.txt` (OIDC, server-only vars) |
| Add (Phase 3b) | `src/clobRateLimiter.ts` or equivalent (global + optional per-tenant fairness) |
| Edit (Phase 3b) | `src/database.ts` (PRAGMA busy_timeout) |
| Edit (Phase 3b) | `src/tradeExecutor.ts` or CLOB layer (acquire from rate limiter; idempotency key; handle INVALID_ORDER_DUPLICATED) |
| Edit (Phase 3b) | CLOB client / heartbeat (verify or add heartbeat) |
| Add (Phase 5) | `audit_log` table in `src/database.ts`; write audit records from routes and CopyTrader |
| Add (Phase 6) | `src/api/adminRoutes.ts` (admin-only routes); admin middleware in server; egress-check endpoint; admin list storage (DB/config) |
| Edit (Phase 6) | `src/server.ts` (mount admin routes); `public/js/app.js` (admin tab: tenants, disable/enable, audit link, Admins panel, Maintenance: backup + egress check) |
| Edit (Phase 6) | `ENV_EXAMPLE.txt` (ADMIN_TENANT_IDS or IdP admin role doc) |
| Add (Phase 7) | `trade_events` table or store; write from CopyTrader/WalletMonitor/TradeExecutor |
| Edit (Phase 7) | `src/api/routes.ts` or adminRoutes: `GET /api/trade-log`, `GET /api/admin/trade-log`, extended health for admin |
| Edit (Phase 7) | `public/js/app.js` (tenant trade log panel; admin trade log + system health one-glance panel; optional first-run setup flow; Settings/My config single page for tenant) |

**Execution order:** **0a** (Dome removal) → 0 (egress) → 1 → 2 → 3 → **3b** → 4 → 5 → **6** (admin) → **7** (monitoring/dashboards). Complete and verify each phase before the next.
