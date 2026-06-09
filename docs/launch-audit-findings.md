# Launch Readiness Audit — Findings Report

**Date:** June 9, 2026 (pre-launch audit for June 11 launch)
**Scope:** Money path, multi-tenant isolation, session lifecycle, every UI page and flow.
**Severity scale:** `LAUNCH-BLOCKER` (must fix before launch) / `SHOULD-FIX` (fix this week) / `LATER` (backlog)

> Plain-language summary for the owner: we walked every part of the product the way a
> new customer would, and also read the code that moves real money line by line.
> Everything marked LAUNCH-BLOCKER below was fixed in this PR. Everything else is
> documented so we can decide together.

---

## 1. Environment / boot findings

### 1.1 LAUNCH-BLOCKER (fixed): app could not start on current Node.js
- **What:** `better-sqlite3` was pinned to 12.6.x, which cannot compile on Node 26 (the
  version installed on the owner's machine). The app crashed on boot.
- **Fix:** upgraded to `better-sqlite3` ^12.10.0 (same major version, officially supports
  Node 20–26). All 399 tests pass after the upgrade.
- **Where:** `package.json`

### 1.2 SHOULD-FIX (fixed): missing `https://` on Auth0 issuer URL crashes the server
- **What:** if `AUTH0_ISSUER_BASE_URL` is set to a bare domain
  (`dev-xxx.us.auth0.com` instead of `https://dev-xxx.us.auth0.com`), the server dies at
  boot with a cryptic `"issuerBaseURL" must be a valid uri`. The owner's local `.env` had
  exactly this. Other URL configs already auto-heal via `ensureProtocol`.
- **Fix:** `auth0IssuerBaseUrl` now runs through the same `ensureProtocol` helper.
- **Where:** `src/config.ts`

### 1.3 NOTE: local `.env` adjusted for hosted-mode testing
- `AUTH0_ISSUER_BASE_URL` now includes `https://`; `AUTH0_BASE_URL` temporarily points to
  `http://localhost:3000` for local login testing; `PRIVATE_KEY` commented out (hosted
  mode forbids it). Original values preserved in `backup.env.local` (gitignored).

---

## 2. Data integrity findings

### 2.1 LAUNCH-BLOCKER (fixed): wallet tags silently lost on SQLite backend
- **What:** `TrackedWallet.tags` (category tags like "sports", "politics") existed in the
  TypeScript type and the JSON storage backend, and the API exposes
  `PATCH /api/wallets/:address/tags` — but the SQLite `tracked_wallets` table had no tags
  column. In hosted production (which requires SQLite), any tags a user saved were
  silently thrown away on the next write.
- **Fix:** added `tags_json` column via the established `safeAddColumn` migration
  pattern, wired it through `rowToWallet` and `dbSaveTrackedWallets`, with corrupt-JSON
  tolerance. Round-trip covered by `tests/database.test.ts`.
- **Where:** `src/database.ts`, `tests/database.test.ts`

---

## 3. Money path — trade safety invariant verification

Full line-by-line walk of `copyTrader.ts`, `walletMonitor.ts`, `tradeExecutor.ts`,
`clobClient.ts`, `storage.ts`, `walletConfigSafety.ts`, `noRepeatReconciliation.ts`,
`clobClientFactory.ts`, `tenantContext.ts`, `tenantPolicy.ts`.

| Invariant | Verdict |
| --- | --- |
| 1. No-repeat always active + recorded | **FAIL → FIXED** (3.1) |
| 2. Concurrency guard before any await | PASS (`copyTrader.ts` ~455-475, finally ~1480) |
| 3. Stop-loss fail-safe | PASS legacy / **FAIL hosted → FIXED** (3.3) |
| 4. All wallet settings passed through | PASS (all 16 settings + tenantId, verified twice) |
| 5. Order size safety cap | PASS fixed / **FAIL proportional → FIXED** (3.2) |
| 6. Hosted tenant routing | PASS (per-tenant context, per-(tenant,wallet) CLOB clients) |

### 3.1 LAUNCH-BLOCKER (fixed): no-repeat protection permanently disarmed after first window
- **What:** `Storage.addExecutedPosition` was a silent no-op when a matching executed
  record already existed — it never refreshed the timestamp. After the first no-repeat
  window expired for a market, every later trade on that market left the stale original
  timestamp in place, so the no-repeat check (which compares timestamps against the
  cutoff) could never block again. Configured 24h windows silently shrank to ~zero after
  one cycle; the 5-minute safety minimum was equally dead. In-memory dedup hid this
  within a session but not across restarts (the record's documented purpose).
- **Fix:** existing executed records are now refreshed (timestamp + order details) on
  every successful trade, re-arming the window. Covered by a new regression test.
- **Where:** `src/storage.ts` (`addExecutedPosition`), `tests/storage.test.ts`

### 3.2 LAUNCH-BLOCKER (fixed): proportional-mode safety cap could never fire
- **What:** the cap compared the calculated size against `max(2 × itself, $500)` — a
  condition that is mathematically false for every positive number. Proportional trades
  had no effective cap; one bad sizing input (e.g., a wrong portfolio value from the API)
  could spend the entire wallet balance on a single trade.
- **Fix:** proportional cap now references the configured baseline size
  (`max(2 × configured size, $500)`), which is independent of the calculated value.
- **Where:** `src/copyTrader.ts` (~line 1026)

### 3.3 SHOULD-FIX (fixed): hosted-mode stop-loss silently failed OPEN
- **What:** in hosted mode there is no global wallet, so the USDC-commitment stop-loss
  returned `active: false` ("wallet address not available") — an enabled risk control
  silently provided zero protection for every hosted tenant.
- **Fix:** hosted mode now resolves the tenant's first active trading wallet (proxy →
  derived proxy → address) and its own CLOB client; if no wallet can be resolved while
  stop-loss is enabled, it now fails CLOSED (blocks) per the fail-safe rule.
- **Where:** `src/copyTrader.ts` (`getUsageStopLossStatus`)

### 3.4 SHOULD-FIX (fixed): hosted pending-order reconciliation could permanently block a market
- **What:** the confirmation pass of pending-order reconciliation called
  `getCurrentPositionSize(trade)` without the probe wallet id (the first pass passed it).
  In hosted mode that throws, the caller's fail-safe catches it, and the market stays
  blocked forever for that tenant.
- **Fix:** pass `probeWalletId` in the confirmation pass, same as the first pass.
- **Where:** `src/copyTrader.ts` (~line 1606)

### 3.5 Flagged, NOT changed (trade logic — deliberate caution)
| # | Severity | Issue | Where |
| --- | --- | --- | --- |
| 1 | should-fix | Multi-wallet fan-out: `isPositionBlocked` falls back to market+side matching even with a per-wallet `positionKey`, so with multiple trading wallets assigned, only the first wallet ever trades (fails SAFE — no money risk, feature limitation) | `src/storage.ts:756` |
| 2 | later | Allocation weight (≤2.0) × hot-streak multiplier (1.5) can exceed the 2× fixed cap → legitimate upsized trades get blocked instead of clamped | `src/copyTrader.ts:1008` |
| 3 | later | Sizing/collateral/min-size pre-flight checks only use the FIRST execution target's CLOB client | `src/copyTrader.ts:872+` |
| 4 | later | SELL clamped to owned shares can drop below market min order size → unsellable dust positions | `src/copyTrader.ts:1253` |
| 5 | later | Ditto-state rejections happen before dedup keys are marked → duplicate "rejected" rows possible in feed | `src/copyTrader.ts:379-473` |
| 6 | later | Rate-limit counters only increment on fully executed trades; resting "pending" orders don't count | `src/copyTrader.ts:1375` |
| 7 | later | Missing txHash/id → random synthetic hash defeats tx-level dedup for that row | `src/walletMonitor.ts:369` |
| 8 | later | `storage.ts` uses `getTenantIdOrDefault()` (not strict) — a future code path missing `runWithTenant` would silently use the default tenant instead of throwing | `src/storage.ts:74` |

### 3.6 Verified clean
Side filter, price limits (0.01/0.99 defaults), value filter, rate-limit windows
(tenant+wallet keyed), fixed sizing math, slippage resolution and tick alignment, SELL
share-ownership verification (fail-safe skip), min-order-size double check, pending vs
executed discrimination, trade-feed recording on all outcome paths.

---

## 4. Multi-tenant isolation

### 4.1 Live two-user isolation test — PASS
Performed against a local hosted-mode instance (new Auth0 tenant) with two freshly
created users, `audit-user-a@` and `audit-user-b@`:

| Check | Result |
| --- | --- |
| First login auto-provisions user + personal workspace | PASS (both users got own `tenant_…` ids) |
| A adds tracked wallet → B's wallet list | PASS — B sees 0 wallets |
| A sets global trade size 77 → B's trade size | PASS — B still sees default (2) |
| B requests A's data via `x-tenant-id` header | DENIED (membership check + audit log) |
| B calls `POST /api/auth/switch-tenant` with A's tenant id | DENIED — 403 |
| Logout | PASS — full IdP logout, returns to login screen |

### 4.2 SHOULD-FIX: foreign `x-tenant-id` returns HTTP 500 instead of 403
- **What:** when a user requests a tenant they're not a member of, the request is
  correctly denied and audit-logged, but the rejection flows through `next(new Error(...))`
  and surfaces as a generic 500. Functionally safe; cosmetically wrong status code and a
  scary server-error in logs for what is a permission denial.
- **Where:** `src/server.ts` (~line 324, tenant resolver middleware)

### 4.3 NOTE: Auth0 tenant replaced
- The owner could not access the old Auth0 account (`dev-uan21r7z3d6onvec`), so the app
  now points at a new tenant `dev-rjdevt32s21vhh86.us.auth0.com` under an account linked
  to the owner's GitHub (owner-approved). A new "Jungle Agents" application was created
  with callbacks for `http://localhost:3000` and `https://ditto.jungle.win`.
- **Production deploy must update:** `AUTH0_ISSUER_BASE_URL`, `AUTH0_CLIENT_ID`,
  `AUTH0_CLIENT_SECRET` (new tenant), keep `AUTH0_BASE_URL=https://ditto.jungle.win`.
- **SHOULD-FIX before launch:** the Google social connection on the new tenant uses
  Auth0 dev keys (works, but shows a warning and is rate-limited). Either configure real
  Google OAuth credentials or disable the Google button for launch.

## 5. Session lifecycle

### 5.1 Verified working
- Login → Auth0 → callback → dashboard works end-to-end on the new tenant.
- Logout fully clears the session (server cookie + Auth0 IdP logout).
- The pre-auth gate is a dark fixed overlay (`.auth-gate-screen`) — no white flash from
  the app itself; remaining flash risk is only the instant before CSS loads (PR 2 adds an
  inline dark background on `<html>`).

---

## 5. Session lifecycle

_(populated below)_

---

### 5.2 Verified: session expiry handled correctly
- `public/js/api.js` intercepts 401s: OIDC mode redirects to `/auth/login?returnTo=<page>`;
  legacy mode reopens the token modal. No silent failures.

## 6. UI walkthrough findings (before-baseline)

Full click-through of every tab, dialog, and form on a clean local instance, plus
responsive checks at 1280/1024/768. Empty states, dialogs, and forms all behave; zero
console errors. Defects found (to be fixed in the UI overhaul PR):

| # | Severity | Issue |
| --- | --- | --- |
| 1 | launch-blocker | Topbar nav clips at 1024px — "Settings" truncates to "Set", items overlap (common laptop width) |
| 2 | should-fix | Trading wallet address ellipsized with no copy button/tooltip |
| 3 | should-fix | 768px: Jungle Agents + Trade history squeezed side-by-side; should stack |
| 4 | should-fix | "BOT RUNNING"/"BOT OFFLINE" status pill overflows its container at some widths |
| 5 | later | "Continue setup" button placement awkward at certain widths |

Also reproduced from the owner's report at narrow widths: trade-history columns truncate
("AMOUN…"), nav items clip. All to be addressed by the design-system + overhaul PR.

### 4.x addendum — fixed during audit
- Foreign `x-tenant-id` now returns **403** with a clean JSON error (was 500);
  verified live with a forged header from a second user's session.
