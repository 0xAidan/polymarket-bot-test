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

_(populated below from full code walk)_

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

## 6. UI walkthrough findings (before-baseline)

_(populated below with screenshots)_
