# Hosted Multi-Tenant Enterprise Implementation Plan

**Goal:** Host the Polymarket copy-trade bot as a single website with logins, per-user profiles and tracked wallets, 24/7 uptime, secure isolation (no profile overlap or drains), and reliable Polymarket API access without Railway-style blocking. Discovery stays unified; copy-trading runs as separate logical instances per profile.

**Sources:** Parallel deep research (Polymarket/Cloudflare blocking, multi-tenant SaaS, hosting), plus codebase review of `server.ts`, `storage`, `copyTrader`, `walletManager`, `database`, `config`, `api/routes`, `api/discoveryRoutes`, `secureKeyManager`, `domeWebSocket`, `walletMonitor`.

---

## Table of Contents

1. [Part 1: Why Railway Was Blocked and What Actually Works](#part-1-why-railway-was-blocked-and-what-actually-works)
2. [Part 2: Hosting Strategy](#part-2-hosting-strategy-affordable-247-works-with-polymarket)
3. [Part 3: Multi-Tenant Architecture](#part-3-multi-tenant-architecture-profiles-isolation-no-overlap)
4. [Part 4: Implementation Phases (High Level)](#part-4-implementation-phases)
5. [Part 5: In-Depth Implementation Detail](#part-5-in-depth-implementation-detail)
6. [Part 6: API and Auth Detail](#part-6-api-and-auth-detail)
7. [Part 7: Frontend and Discovery Detail](#part-7-frontend-and-discovery-detail)
8. [Part 8: Testing, Rollback, and Checklist](#part-8-testing-rollback-and-checklist)
9. [Part 9: Risk and Reality Check](#part-9-risk-and-reality-check)
10. [Security note and Document control](#security-note-api-keys-in-chat)

---

## Part 1: Why Railway Was Blocked and What Actually Works

### Why cloud/datacenter IPs get blocked

- **Cloudflare** (in front of Polymarket) scores requests by IP reputation and ASN. Datacenter IPs (AWS, GCP, Railway) are often treated as higher risk and get challenges or blocks.
- **Polymarket** also enforces **geographic restrictions** (e.g. US blocked for trading). They expose `/api/geoblock` to check if an IP is allowed.
- So “running locally worked” because: (1) your home IP is typically non-datacenter and (2) your location may be in an allowed region.

### What works (from research)

1. **Host in an approved region**  
   Use a region Polymarket does **not** geoblock. Documentation points to **eu-west-1** (Ireland) as a “closest non-georestricted” region. All hosting below should be **eu-west-1** (or another approved EU region).

2. **Stable, fixed egress IP**  
   Use a **single, fixed outbound IP** (e.g. NAT Gateway or static IP VPS) so Polymarket sees a consistent identity. Over time this can build reputation and optionally be allowlisted. Avoid shared/ephemeral cloud IPs.

3. **Use official APIs and Builder API**  
   Keep using CLOB + Data API and **Builder API** (already in the project). Throttle to stated limits (e.g. 500 orders per 10s burst), use retries with backoff, and **pre-flight** `/api/geoblock` before critical flows.

4. **No “residential proxy” requirement**  
   Research indicates that “residential” is not required; a **fixed IP in an approved region** plus compliant behavior is the recommended approach. Residential proxies are increasingly detected and are less reliable long-term.

---

## Part 2: Hosting Strategy (Affordable, 24/7, Works With Polymarket)

### Recommended: VPS in eu-west-1 with static IP

- **Providers (eu-west-1 or equivalent):**  
  Hetzner (Falkenstein/Nuremberg/Helinski), DigitalOcean (London/Frankfurt), Vultr (London/Amsterdam), or OVH (EU).
- **Why:** Lower cost than major clouds, full control over egress, single static IP, 24/7 process.
- **Sizing:** Start with a small VPS (e.g. 2 vCPU, 4 GB RAM). Scale up if you add many tenants or heavy discovery.

### Alternative: Serverless + fixed egress (eu-west-1)

- Run the app (or trade-execution path) on **AWS Lambda** or **Google Cloud Run** inside a **VPC** and route **all outbound traffic through a NAT Gateway** in **eu-west-1**.
- Gives a stable egress IP and pay-per-use, but NAT Gateway has a baseline cost. Good if traffic is bursty.

### What to avoid

- **Railway / generic cloud in US or unknown region** — high chance of geoblock and/or Cloudflare blocks.
- **Cheap “evasion” proxies** — against ToS and increasingly detected.
- **US-based hosting for trading** — Polymarket blocks US for order placement.

### Cost ballpark

- **VPS (Hetzner/DO/Vultr) eu-west-1:** ~$10–30/mo for a small instance + static IP.
- **Serverless + NAT in eu-west-1:** Variable; NAT Gateway adds ~$30–50/mo; compute is usage-based.

---

## Part 3: Multi-Tenant Architecture (Profiles, Isolation, No Overlap)

### Principles

- **One login = one profile (tenant).** Each colleague has one account; all their data is under that tenant.
- **Strict tenant isolation:** Every row and every operation is scoped by `tenant_id`. No cross-tenant reads or writes.
- **Unified discovery, per-tenant execution:** One shared Discovery Engine; “track this wallet” adds to the **logged-in user’s** tracked list. Copy-trading runs in **per-tenant** context (that user’s wallets, config, and credentials only).

### Tenant identity

- **`tenant_id`:** Stable ID from your identity provider (e.g. Auth0/Cognito `sub` or equivalent). Use this everywhere as the partition key.
- **Auth:** Use **OpenID Connect (OIDC)** with an IdP (Auth0, AWS Cognito, Keycloak, etc.). Short-lived access tokens + refresh; no custom password storage.

### Data model (tenant-scoped)

| Data | Current | Multi-tenant |
|------|---------|--------------|
| Tracked wallets | Single list | `tenant_id` on every row; all reads/writes filtered by tenant |
| Bot config (trade size, stop-loss, etc.) | Single `bot_config` | Per-tenant (e.g. `tenant_id` + key, or one row per tenant) |
| Executed positions / no-repeat | Single table | `tenant_id` on every row |
| Pending positions | Single table | `tenant_id` on every row |
| Trading wallets & copy assignments | In-memory + `bot_config` | Per-tenant; stored in tenant-scoped config or dedicated tables with `tenant_id` |
| Discovery wallets/trades/markets | Shared | **No** `tenant_id`; shared across all users |
| Keystore (encrypted keys per trading wallet) | File-based by wallet id | Namespaced by tenant (e.g. `tenant_id/wallet_id`) so User A never has access to User B’s keys |

### Execution model (per-tenant copy-trading)

- **Option A (recommended):** One **CopyTrader**-style orchestrator that is **tenant-aware**. When a trade is detected for a tracked wallet, the system knows which tenant(s) own that wallet (each wallet belongs to exactly one tenant). For each such tenant:
  - Load that tenant’s config, trading wallets, and copy assignments.
  - Run the same no-repeat, sizing, and safety checks using **that tenant’s** storage and config.
  - Execute using **that tenant’s** trading wallet and Polymarket credentials (from secure storage).
- **Option B:** One CopyTrader **instance per tenant** (heavier: more memory and more processes, but stronger process isolation). Prefer Option A unless you have a strong reason for per-process isolation.

- **Discovery:** Single DiscoveryManager (unchanged conceptually). When a user clicks “Track” on a discovered wallet, the API associates that wallet with the **current user’s** `tenant_id` and adds it to that tenant’s tracked list.

### Secrets (per-tenant)

- **Trading wallet private keys** and **Polymarket Builder API credentials** must be stored per tenant and never shared.
- **Recommended:** HashiCorp Vault or AWS Secrets Manager (or equivalent) with **envelope encryption** and **tenant-scoped access** (e.g. policy: tenant A can only read secrets prefixed with `tenant_a/`).
- **Alternative (simplest for MVP):** Keep file-based keystore but **namespace by tenant** (e.g. `data/keystores/<tenant_id>/<wallet_id>.keystore.json`) and strict file permissions; ensure app code never reads another tenant’s directory.

---

## Part 4: Implementation Phases

### Phase 0: Prep and hosting (no code change to app yet)

1. **Choose region and provider**
   - Pick VPS or serverless in **eu-west-1** (or approved EU region). Confirm static egress IP (NAT or static IP from provider).
   - Document the exact region and egress IP for future allowlisting or support requests.

2. **Confirm Polymarket access**
   - From that IP, call Polymarket’s `/api/geoblock` (or documented geoblock endpoint) and any health/read endpoint (e.g. CLOB or Data API read).
   - Ensure response indicates you’re not blocked and not in a restricted country (e.g. US).
   - If blocked, do not proceed with that region; switch provider/region.

3. **Optional: request allowlisting**
   - If you have a stable IP and enterprise/compliance need, contact Polymarket (e.g. support or builder program) and ask whether they support IP allowlisting for CLOB/Data API.

### Phase 1: Tenant identity and storage

1. **Introduce `tenant_id` in the schema**
   - Add `tenant_id TEXT NOT NULL DEFAULT 'default'` to `tracked_wallets` and `executed_positions`; add indexes on `tenant_id`.
   - For `bot_config`: either (A) change to composite primary key `(tenant_id, key)` and migrate existing rows to `tenant_id = 'default'`, or (B) add a new `tenant_config` table and leave `bot_config` for global keys only (see §5.1).
   - Run migration in a single transaction; backfill existing rows with `tenant_id = 'default'`.
   - Note: There is no separate `pending_positions` table; pending is a status on `executed_positions`, so adding `tenant_id` to `executed_positions` is sufficient.

2. **Tenant-scoped storage layer**
   - Create `src/tenantContext.ts` with AsyncLocalStorage, `getTenantId()`, and `runWithTenant(tenantId, fn)`.
   - Update `src/database.ts`: add migration for new columns/tables; change `dbLoadTrackedWallets`, `dbSaveTrackedWallets`, `dbLoadConfig`, `dbSaveConfig`, `dbLoadExecutedPositions`, `dbSaveExecutedPositions` to accept and filter by `tenantId`.
   - Update `src/storage.ts`: in every method that reads/writes tracked wallets, config, or executed positions, call `getTenantId()` and pass it to the DB layer; throw or return forbidden if tenant is missing when required.

3. **Auth and session**
   - Integrate OIDC (Auth0/Cognito/Keycloak): implement `GET /auth/login` (redirect to IdP), `GET /auth/callback` (exchange code for tokens, return or set token for frontend), and optionally `GET /auth/me` and `POST /auth/logout`.
   - Add middleware that runs after the existing `/api` gate: for protected routes, verify JWT (signature, issuer, expiry), extract `tenant_id` (e.g. `payload.sub`), and call `runWithTenant(tenantId, next)`.
   - During transition, support API_SECRET: if request has valid API_SECRET and no JWT, set tenant to `'default'` and run with that context so existing single-user setup keeps working.

### Phase 2: Per-tenant config and wallets

1. **Trading wallets and copy assignments**
   - Store trading wallets and copy assignments per tenant (tables or tenant-keyed config). On startup, either load for “all active tenants” or load on-demand when processing that tenant’s trades.

2. **Keystore namespace**
   - Ensure encrypted keystores are stored under `tenant_id` (e.g. `data/keystores/<tenant_id>/`). All lookups for “current user’s trading wallet” use `req.tenantId`.

3. **Config (trade size, stop-loss, etc.)**
   - All bot config previously in single `bot_config` becomes per-tenant (keyed by `tenant_id`). Defaults for new tenants can be copied from current defaults.

### Phase 3: CopyTrader and execution (tenant-aware)

1. **WalletMonitor / DomeWebSocket**
   - Continue to load “all active tracked wallets” but **with** `tenant_id`. When a trade is detected for wallet W, resolve tenant T from W’s `tenant_id`.
   - Invoke handling for tenant T: run no-repeat check, sizing, and execution in **tenant T’s** context (Storage + executor use T’s data and credentials).

2. **CopyTrader**
   - Refactor so that the pipeline (detect → validate → size → execute) runs with an explicit **tenant context** (tenant_id). All Storage and executor calls use that context.
   - Ensure: no-repeat, in-flight guard, and order size cap remain **per-tenant** (no cross-tenant state).

3. **TradeExecutor**
   - For each order, resolve the trading wallet and Polymarket credentials from the **current tenant’s** keystore/config. Never use another tenant’s keys.

### Phase 4: API and frontend

1. **API routes**
   - All `/api/*` routes (except auth and health) require a valid session/token. Resolve `tenant_id` from token; pass it into Storage and any service that needs it.
   - Discovery read endpoints remain shared; “track wallet” and “untrack” write to **current user’s** tenant.

2. **Frontend**
   - Add login (OIDC redirect + callback). After login, store access token (and optionally refresh token) and send token on every API request (e.g. `Authorization: Bearer <token>`).
   - Dashboard: only show and modify the **current user’s** tracked wallets, trading wallets, config, and trade history. Discovery list is shared; “Track” applies to current user.

### Phase 5: Hardening and 24/7

1. **Secrets**
   - Move from file-based to Vault/Secrets Manager with tenant-scoped policies if you need enterprise-grade secret handling.
   - Rotate any credentials that were ever in chat or logs (e.g. Parallel API key).

2. **Audit and safety**
   - Add an **audit log** (e.g. tenant_id, action, order id, timestamp) for trade intents and executions. Helps with compliance and debugging.
   - Re-verify trade safety invariants (no-repeat, in-flight guard, stop-loss fail-safe, wallet settings passed through) in the tenant-aware flow.

3. **Uptime**
   - Process manager (e.g. PM2 or systemd) on VPS; restart on crash. Optional: health checks and external monitoring (e.g. UptimeRobot) on `/health`.
   - If serverless: use managed runtimes and ensure NAT/egress is in eu-west-1.

4. **Rate limits and behavior**
   - Apply Polymarket’s documented limits (e.g. 500 orders per 10s burst). Add client-side throttling and jittered backoff. Pre-flight geoblock where relevant.

---

## Part 5: In-Depth Implementation Detail

This section provides file-level and code-level guidance so implementers know exactly what to change.

### 5.1 Database schema changes (exact SQL and migration)

**New columns and tables:**

1. **`tracked_wallets`**  
   - Add column: `tenant_id TEXT NOT NULL DEFAULT 'default'`.  
   - Add index: `CREATE INDEX idx_tracked_wallets_tenant ON tracked_wallets(tenant_id);`  
   - Primary key remains `address`; for multi-tenant the same wallet address can theoretically be tracked by different tenants, so consider composite primary key `(tenant_id, address)` if you want to allow that. Recommended: keep `address` as PK and enforce “one wallet tracked by one tenant” in app logic (e.g. unique on `address` globally, or allow same address for multiple tenants — document the choice).

2. **`executed_positions`**  
   - Add column: `tenant_id TEXT NOT NULL DEFAULT 'default'`.  
   - Add index: `CREATE INDEX idx_executed_positions_tenant ON executed_positions(tenant_id);`  
   - All existing rows get `tenant_id = 'default'` in migration.

3. **`bot_config`**  
   - **Option A (simplest):** Change to composite key. Replace `(key TEXT PRIMARY KEY)` with `(tenant_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (tenant_id, key))`. Default tenant `'default'` for existing rows.  
   - **Option B:** New table `tenant_config (tenant_id, key, value)` and keep `bot_config` for global/server config only.  
   - Recommendation for this codebase: **Option A**. Migration: create new table `bot_config_new(tenant_id, key, value)`, copy existing rows with `tenant_id = 'default'`, drop `bot_config`, rename `bot_config_new` to `bot_config`, create unique index on `(tenant_id, key)`.

**Migration script pattern (run once on deploy):**

- Use `safeAddColumn`-style helpers (as in `database.ts`) for adding `tenant_id` to `tracked_wallets` and `executed_positions` so existing DBs get the column without data loss.  
- Backfill: `UPDATE tracked_wallets SET tenant_id = 'default' WHERE tenant_id IS NULL OR tenant_id = '';` (and same for `executed_positions`).  
- For `bot_config`, run the create-copy-backfill-drop-rename sequence in a single transaction.

**Files to modify:**

- `src/database.ts`: add migration logic (new schema version, run `ALTER TABLE` / table swap), update `dbLoadTrackedWallets` / `dbSaveTrackedWallets` to accept optional `tenantId` and filter/write by it; same for `dbLoadConfig` / `dbSaveConfig` (tenant-scoped); update `dbLoadExecutedPositions` / `dbSaveExecutedPositions` to be tenant-scoped.  
- `src/storage.ts`: every method that reads/writes tracked wallets, config, or executed positions must pass through a tenant context (see request context below).

### 5.2 Request-scoped tenant context

**Goal:** So that route handlers and downstream code (Storage, CopyTrader, WalletManager) do not need to thread `tenantId` through every function call, introduce a request-scoped tenant.

**Implementation:**

1. **AsyncLocalStorage (Node.js)**  
   - In `src/`, create a small module e.g. `src/tenantContext.ts`:
     - `import { AsyncLocalStorage } from 'async_hooks';`
     - `export const tenantStorage = new AsyncLocalStorage<{ tenantId: string }>();`
     - `export function getTenantId(): string | undefined { return tenantStorage.getStore()?.tenantId; }`
     - `export function runWithTenant<T>(tenantId: string, fn: () => T): T { return tenantStorage.run({ tenantId }, fn); }`
   - In Express middleware (after auth), resolve tenant from JWT (e.g. `sub` or custom claim), then call `runWithTenant(tenantId, () => next())` so that any code running in that request chain can call `getTenantId()`.

2. **Fallback for non-request code (background/worker)**  
   - When CopyTrader or WalletMonitor runs in the process (e.g. polling loop), there is no HTTP request. For a **detected trade**, the tenant is known from the tracked wallet’s `tenant_id`. So when the pipeline runs `handleDetectedTrade(trade)`, it should call `runWithTenant(trade.tenantId, async () => { ... })` at the entry point so that all Storage and executor calls inside use that tenant.  
   - Ensure `DetectedTrade` (or the object that carries the tracked-wallet info) includes `tenantId` (set when loading active wallets in WalletMonitor/DomeWebSocket).

**Files to create/modify:**

- **New:** `src/tenantContext.ts` (as above).  
- **Modify:** `src/server.ts`: add middleware that validates JWT, reads `tenant_id` (e.g. from `payload.sub`), and wraps `next()` in `runWithTenant(tenantId, next)`.  
- **Modify:** `src/storage.ts`: in every method that is tenant-scoped, call `getTenantId()` from `tenantContext`; if missing and method is invoked from an API path, throw or return 403; if invoked from background with no context, use a single “system” tenant only for discovery or document that background always runs with an explicit tenant from the trade’s wallet.

### 5.3 Storage layer: method-by-method tenant scoping

**Convention:** For any method that reads or writes tenant-specific data, the implementation must restrict by `tenant_id`. Prefer reading `getTenantId()` from context; optionally allow an explicit `tenantId` parameter for background callers that pass it.

| Storage method | Action |
|----------------|--------|
| `loadTrackedWallets()` | Query/load only where `tenant_id = getTenantId()`. |
| `addWallet(address)` | Insert with `tenant_id = getTenantId()`. |
| `removeWallet(address)` | Delete only rows where `address` and `tenant_id = getTenantId()`. |
| `getWallet(address)` | Filter by `tenant_id` and `address`. |
| `updateWalletLastSeen`, `toggleWalletActive`, `updateWalletLabel`, etc. | All must include `tenant_id` in WHERE. |
| `loadConfig()` / `saveConfig()` | Load/save only the key-value set for `getTenantId()` (e.g. `bot_config` filtered by `tenant_id`). |
| `loadExecutedPositions()` / `saveExecutedPositions()` | Filter by `tenant_id`. |
| `addExecutedPosition`, `isPositionBlocked`, `addPendingPosition`, `markPendingPositionExecuted`, etc. | All must use `getTenantId()` when reading/writing executed_positions. |
| Discovery-related (e.g. discovery_wallets, discovery_trades) | **Do not** add tenant_id; keep global. |

**Database layer:**

- `dbLoadTrackedWallets(tenantId?: string)`: if `tenantId` provided (or from context), add `WHERE tenant_id = ?`; else for migration period you may load all (deprecate that).  
- `dbSaveTrackedWallets(wallets, tenantId)`: only write rows for that tenant; or replace-all for that tenant (delete where tenant_id = ? then insert).  
- Same pattern for config and executed_positions: all DB helpers take `tenantId` and filter by it.

### 5.4 WalletManager and keystore: tenant namespace

**Current behavior:**  
- `walletManager.ts` keeps in-memory `tradingWallets` and `copyAssignments`; they are persisted in `Storage.loadConfig()` / `saveConfig()` under keys `tradingWallets` and `copyAssignments`.  
- `secureKeyManager.ts` uses `config.dataDir` and a single `keystores` dir; wallet files are keyed by wallet `id`.

**Multi-tenant changes:**

1. **Config:**  
   - Trading wallets and copy assignments are already stored in bot_config. Once bot_config is tenant-scoped (see above), each tenant’s config will naturally contain only that tenant’s `tradingWallets` and `copyAssignments`. No structural change in WalletManager other than ensuring it runs with tenant context (so `loadConfig`/`saveConfig` are tenant-scoped).

2. **Keystore path:**  
   - Change `keystoresDir()` in `secureKeyManager.ts` to include tenant id: e.g. `path.join(config.dataDir, 'keystores', getTenantId() ?? 'default')`.  
   - Ensure `addEncryptedWallet`, `removeEncryptedWallet`, and any read of keystore files use this path. So each tenant’s keys live under `data/keystores/<tenant_id>/`.  
   - When the app runs a trade for a tenant, it must set tenant context (e.g. `runWithTenant(tenantId, ...)`) before calling into WalletManager/TradeExecutor so that keystore path and config both resolve to that tenant.

**Files to modify:**

- `src/secureKeyManager.ts`: make `keystoresDir()` tenant-aware via `getTenantId()`.  
- `src/walletManager.ts`: ensure init/load/save run with tenant context when called from API; when called from CopyTrader for a specific tenant, that path already runs inside `runWithTenant(tenantId, ...)`.

### 5.5 CopyTrader, WalletMonitor, and DomeWebSocket: tenant-aware pipeline

**WalletMonitor (polling):**

- Today it calls `Storage.getActiveWallets()` (or `loadTrackedWallets` then filter active).  
- Change to: load **all** active tracked wallets **with** their `tenant_id` (e.g. from DB: `SELECT * FROM tracked_wallets WHERE active = 1`).  
- When it detects a trade for wallet W, it has W’s `tenant_id`. Build a `DetectedTrade` that includes `tenantId: W.tenant_id`.  
- When passing the trade to CopyTrader, invoke handling inside that tenant’s context: `runWithTenant(trade.tenantId, () => copyTrader.handleDetectedTrade(trade))`.

**DomeWebSocket:**

- Same idea: when it receives an event for a user address, resolve which tracked wallet that is. Tracked wallets now carry `tenant_id`. So when building the `DetectedTrade`, set `trade.tenantId` from the wallet record.  
- Call `runWithTenant(trade.tenantId, () => copyTrader.handleDetectedTrade(trade))`.

**CopyTrader.handleDetectedTrade:**

- At the very start, ensure tenant context is set (either already set by the caller via `runWithTenant`, or set here from `trade.tenantId`). Then all existing logic (no-repeat check, sizing, execution) will use Storage and WalletManager that read `getTenantId()` and thus operate on the correct tenant’s data and keys.  
- **Critical:** No-repeat, in-flight guard, and order size cap must remain per-tenant. The in-flight set can stay in-memory keyed by (tenant_id + trade key) so two tenants can process different trades concurrently without blocking each other.

**TradeExecutor:**

- It already uses WalletManager and config to resolve which trading wallet and credentials to use. Once WalletManager is tenant-scoped (via context), the executor will use the current tenant’s trading wallet and Builder credentials. No change to executor interface; ensure it’s only ever called from within `runWithTenant(tenantId, ...)`.

**Files to modify:**

- `src/walletMonitor.ts`: load wallets with tenant_id; attach tenantId to detected trade; call handleDetectedTrade inside runWithTenant(trade.tenantId, ...).  
- `src/domeWebSocket.ts`: when enriching from wallet, include tenant_id in the trade object; when emitting to CopyTrader, run inside runWithTenant(trade.tenantId, ...).  
- `src/copyTrader.ts`: ensure handleDetectedTrade runs in tenant context (if not already); key inFlightTrades and processedCompoundKeys by tenant (e.g. `tenantId:tradeKey`) so tenants don’t share state.  
- `src/types.ts`: add optional `tenantId?: string` to `DetectedTrade` (or required when in multi-tenant mode).

### 5.6 Discovery: unified engine, tenant on “track”

- Discovery **read** endpoints (list wallets, scores, signals) stay global: no tenant_id, no filtering.  
- **Track action:** When a user clicks “Track” on a discovered wallet (e.g. `POST /api/discovery/wallets/:address/track`), the API must add that wallet to the **current user’s** tracked list. So this route must:
  1. Require auth and resolve `tenantId` from the JWT (middleware already set tenant context).  
  2. Call `Storage.addWallet(address)` (or equivalent), which will now insert with `tenant_id = getTenantId()`.  
  3. Optionally call `markWalletTracked(address, true)` in discovery’s statsStore (global flag that “someone” is tracking this wallet; or you can keep it per-tenant in a separate table — document choice).  
- **Untrack:** Same: remove wallet only for current tenant (`Storage.removeWallet(address)` with tenant context).

**Files to modify:**

- `src/api/discoveryRoutes.ts`: on `POST /wallets/:address/track`, ensure auth middleware has run and tenant context is set; then call `Storage.addWallet(address)`. Same for any “untrack” or remove endpoint.  
- Discovery manager and chain/API pollers remain unchanged; they only write to discovery_* tables (no tenant_id).

### 5.7 Config and env: no global “default” wallet

- Today, `config.ts` reads `PRIVATE_KEY` and Builder credentials from env for a single “default” wallet. In multi-tenant, **do not** use a single global PRIVATE_KEY for trading. Each tenant’s trading wallets (and their keys) live in the tenant’s keystore and config.  
- Keep env for **server** config only: `PORT`, `DATA_DIR`, `API_SECRET` (if still used), OIDC client id/secret, Polymarket API URLs, etc. Remove or ignore `PRIVATE_KEY` / Builder from env for the actual copy-trading execution; those come from per-tenant keystore and config.  
- If you still need a “first user” or bootstrap flow, create a default tenant (e.g. `default`) and have setup wizard add the first trading wallet for that tenant and store keys in keystore.

### 5.8 File-by-file change summary

| File | Changes |
|------|--------|
| **New:** `src/tenantContext.ts` | AsyncLocalStorage, `getTenantId()`, `runWithTenant()`. |
| `src/database.ts` | Add `tenant_id` to schema; migration; `dbLoadTrackedWallets(tenantId)`, `dbSaveTrackedWallets(wallets, tenantId)`; same for config and executed_positions. |
| `src/storage.ts` | Every tenant-scoped method uses `getTenantId()` and passes it to DB layer; `loadConfig`/`saveConfig` tenant-scoped. |
| `src/config.ts` | Remove or stop using global PRIVATE_KEY/Builder for execution; keep server-only env (PORT, DATA_DIR, OIDC vars, etc.). |
| `src/secureKeyManager.ts` | `keystoresDir()` includes `getTenantId()` (e.g. `data/keystores/<tenant_id>/`). |
| `src/walletManager.ts` | No structural change; runs in tenant context so load/save config are tenant-scoped. |
| `src/walletMonitor.ts` | Load wallets with tenant_id; set `trade.tenantId`; call `runWithTenant(trade.tenantId, () => copyTrader.handleDetectedTrade(trade))`. |
| `src/domeWebSocket.ts` | Enrich trade with tenantId from wallet; same runWithTenant when calling CopyTrader. |
| `src/copyTrader.ts` | Ensure handleDetectedTrade runs in tenant context; key inFlightTrades/processedCompoundKeys by tenant. |
| `src/types.ts` | Add `tenantId?: string` to `DetectedTrade`. |
| `src/server.ts` | Auth middleware: verify JWT, set `runWithTenant(tenantId, next)`; keep `/api/auth/required` and `/api/auth/check`; gate `/api/*` on JWT (or API_SECRET → default tenant). |
| `src/api/routes.ts` | No signature change; all handlers run after middleware so `getTenantId()` is set. Optionally add `GET /auth/me` that returns tenant/user info. |
| `src/api/discoveryRoutes.ts` | `POST .../track`: ensure auth + tenant context, then `Storage.addWallet(address)`. |
| `public/js/app.js` | Add login UI (or redirect to /auth/login); after callback, store token; show “Log out” when logged in. |
| `public/js/api.js` | No change if token is stored and sent as today; ensure 401 triggers login flow. |

---

## Part 6: API and Auth Detail

### 6.1 Routes that must be tenant-scoped (require auth + tenant context)

Every route that reads or writes tracked wallets, bot config, executed positions, trading wallets, copy assignments, or trade history must run **after** auth middleware and inside tenant context. This includes (from `src/api/routes.ts`):

- **Wallets:** `GET/POST/DELETE /wallets`, `PATCH /wallets/:address/*`, `GET /wallets/:address/positions`, `trades`, `balance`, `stats`, `mirror-preview`, `mirror-execute`.  
- **Trading wallets:** `GET/POST/PATCH/DELETE /trading-wallets`, `GET/POST/DELETE /copy-assignments`, `POST /wallets/unlock`, `GET /wallets/lock-status`.  
- **Config:** All `/config/*` (trade-size, monitoring-interval, usage-stop-loss, no-repeat, price-limits, slippage, trade-side-filter, rate-limiting, value-filters, proxy-wallet, private-key, builder-credentials, etc.).  
- **Status and performance:** `GET /status`, `GET /performance`, `GET /trades`, `GET /trades/failed`, `GET /issues`, `POST /issues/:id/resolve`, `GET /wallet`, `GET /wallet/balance`, `GET /wallet/balance-history`. (These return data for the current tenant only.)  
- **Control:** `POST /start`, `POST /stop` — scope to current tenant if you support per-tenant start/stop; otherwise document that start/stop are global.  
- **Ladder, stoploss, pricemonitor, lifecycle, arb, hedge, entities, executor, pnl:** All must run in tenant context so they read/write that tenant’s config and positions.

### 6.2 Routes that stay global (no tenant)

- `GET /health` — no auth, no tenant.  
- `GET /api/auth/required` — no tenant.  
- `POST /api/auth/check` — validates token only; no tenant data.  
- Discovery **read** endpoints: `GET /api/discovery/wallets`, `GET /api/discovery/signals`, `GET /api/discovery/summary`, `GET /api/discovery/status`, `GET /api/discovery/config` — no tenant filter on data.  
- Discovery **write** that affects “track”: `POST /api/discovery/wallets/:address/track` — requires auth and then runs in tenant context so the wallet is added for the current user.

### 6.3 OIDC integration (step-by-step)

1. **Choose IdP:** Auth0, AWS Cognito, or Keycloak. Get: issuer URL, client ID, client secret, redirect URI(s) (e.g. `https://yourdomain.com/auth/callback`).  
2. **Endpoints to implement:**  
   - `GET /auth/login` — redirect to IdP’s authorization URL (response_type=code, scope=openid profile, redirect_uri, state, client_id).  
   - `GET /auth/callback` — IdP redirects here with `code` and `state`. Exchange code for tokens (POST to IdP token endpoint). Store access_token (and optionally refresh_token) in an HTTP-only cookie or return to frontend (e.g. for sessionStorage).  
   - `GET /auth/me` or rely on token — decode JWT to get `sub` (or custom claim) as `tenant_id`.  
   - `POST /auth/logout` — clear cookie or instruct frontend to clear token; optionally redirect to IdP logout.  
3. **Middleware:** For protected routes, read Bearer token from `Authorization` header (or cookie). Verify JWT (signature, issuer, expiry). Extract `tenant_id` (e.g. `payload.sub`), set tenant context with `runWithTenant(tenantId, next)`, then call `next()`.  
4. **Frontend:** After login, store access token (e.g. sessionStorage or cookie). Send `Authorization: Bearer <token>` on every API request. On 401, redirect to login or show login modal.

### 6.4 Backward compatibility (single-tenant / “default” tenant)

- During migration, all existing rows get `tenant_id = 'default'`.  
- If you do not yet add OIDC, you can keep using `API_SECRET` as today: when the request has a valid API_SECRET and no JWT, set tenant context to `'default'` so existing single-user setup still works.  
- Once OIDC is on, you can require JWT for all tenant-scoped routes and drop API_SECRET for dashboard access, or support both (e.g. API_SECRET implies tenant `default`).

---

## Part 7: Frontend and Discovery Detail

### 7.1 Login and token flow

- **Login page or modal:** If no token (or 401), show login. Button “Log in” redirects to `GET /auth/login` (or your backend redirects to IdP).  
- **Callback:** After IdP redirects to `/auth/callback`, backend returns a page that writes the token into sessionStorage (or sets a cookie) and redirects to dashboard.  
- **api.js:** Already sends `Authorization: Bearer ${token}` when token exists. Keep using `API.getToken()` from sessionStorage; ensure after OIDC callback the token is the JWT access token.  
- **Logout:** Call `API.clearToken()` and optionally hit `POST /auth/logout`; redirect to login or home.

### 7.2 Dashboard scoping

- All existing dashboard calls (wallets, config, trades, performance, etc.) remain the same; they now implicitly return only the **current user’s** data because the backend runs in that user’s tenant context. No frontend change except ensuring the token is sent.  
- **Discovery tab:** List and scores are global. “Track” button calls `POST /api/discovery/wallets/:address/track`; backend adds that wallet to the current user’s tracked list. Show “Tracked by you” or “Track” depending on whether the current user has that wallet in their tracked list (you may need a small endpoint like `GET /api/discovery/wallets/:address/tracked-by-me` that returns boolean for current tenant).

### 7.3 First-time user (onboarding)

- New user logs in via OIDC; backend creates no tenant row automatically unless you add a “tenant” table. Simplest: tenant_id = IdP `sub`, no separate tenant table.  
- On first API call with that tenant_id, Storage may return empty lists (no tracked wallets, default config). Frontend shows empty dashboard; user adds trading wallet (with key and Builder creds), then adds tracked wallets or uses Discovery to track.  
- Optional: “bootstrap default config” for new tenants (e.g. copy defaults from a template) in Storage when first access is detected.

---

## Part 8: Testing, Rollback, and Checklist

### 8.1 Testing checklist

- [ ] **Unit:** Storage methods with mock tenant context (e.g. `runWithTenant('tenant-a', () => Storage.loadTrackedWallets())` returns only tenant-a’s wallets).  
- [ ] **Integration:** Two tenants: add different tracked wallets and trading wallets; trigger a trade for tenant A’s wallet — only tenant A’s executor runs and uses A’s keys.  
- [ ] **API:** With two users (two JWTs), call `GET /api/wallets` and confirm each sees only their own list.  
- [ ] **Discovery:** User A tracks wallet X; User B does not. User B’s tracked list does not include X. Discovery list shows X; User B can click Track to add X for B.  
- [ ] **No-repeat:** Execute a trade for tenant A on market M; verify tenant B can still execute on M (no-repeat is per-tenant).  
- [ ] **Keystore:** Tenant A’s keystore dir is not readable by tenant B (path contains tenant_id; ensure no path traversal).

### 8.2 Rollback

- **DB:** Keep a backup before running migrations. If you need to rollback, restore backup or run reverse migrations (e.g. drop `tenant_id` column — only if you haven’t added a second tenant yet).  
- **Code:** Feature-flag or branch: multi-tenant behind a flag so you can deploy without enabling it until validated.  
- **Auth:** If OIDC has issues, fall back to API_SECRET with tenant_id = 'default' so existing single-user still works.

### 8.3 Deployment order

1. Deploy DB migrations (add tenant_id, backfill default).  
2. Deploy code that supports tenant context but still defaults to `default` when no JWT (API_SECRET path).  
3. Deploy OIDC (login, callback, middleware).  
4. Enable “require JWT for new users” and optionally deprecate API_SECRET.  
5. Add audit log and 24/7 hardening.

---

## Checklist Summary

- [ ] Host in **eu-west-1** (or approved non-geoblocked region).
- [ ] Use a **fixed egress IP** (NAT or static IP VPS).
- [ ] Confirm **Polymarket geoblock** and CLOB/Data API from that IP.
- [ ] Add **tenant_id** to all tenant-scoped tables and config; migration with default tenant.
- [ ] **Auth:** OIDC; resolve tenant_id from token; request-scoped context.
- [ ] **Storage:** All tenant-scoped reads/writes filtered by tenant_id; discovery stays global.
- [ ] **Keystore:** Namespace by tenant_id; executor uses only current tenant’s keys.
- [ ] **CopyTrader / execution:** Tenant-aware pipeline; no-repeat and safety checks per tenant.
- [ ] **API:** All mutating and data APIs require auth and tenant context; discovery “track” writes to current user.
- [ ] **Frontend:** Login; dashboard scoped to current user; discovery shared, track/untrack per user.
- [ ] **Secrets:** Prefer Vault/Secrets Manager with tenant-scoped access; rotate exposed keys.
- [ ] **Audit log** for trade intents/executions; **24/7** process manager and monitoring.

---

## Part 9: Risk and Reality Check

- **Polymarket/Cloudflare:** Even with eu-west-1 and fixed IP, there is no guarantee they will never tighten rules or change behavior. The plan is based on official docs and “compliance over evasion”; keep throttling and error handling robust.
- **Cost:** VPS in eu-west-1 is affordable; adding many tenants or high discovery load may require more CPU/memory. Secrets Manager and IdP have their own (usually small) costs.
- **Scope creep:** Delivering “unified discovery + per-profile execution” without changing core copy-trading logic is doable by making the pipeline tenant-aware and partitioning data; avoid rewriting the whole bot.
- **Security:** Tenant isolation must be enforced at every layer (DB, storage, keystore, API). One bug (e.g. missing tenant_id in a query) can cause overlap or data leak. Code review and tests for tenant boundaries are critical.

---

## Security note: API keys in chat

If you pasted any API key, token, or secret into a chat or document, treat it as **compromised**. Rotate it in the provider’s dashboard (e.g. Parallel, Polymarket Builder, IdP) and do not reuse it. Use environment variables or a secrets manager for all credentials in production.

---

## Document control

- **Created:** 2026-03-15  
- **Based on:** Parallel deep research (Polymarket API, Cloudflare, multi-tenant SaaS, hosting) + codebase review.  
- **Research outputs:** `polymarket-hosted-bot-multitenant-plan.md` (full report), `polymarket-hosted-bot-multitenant-plan.json` (metadata).
