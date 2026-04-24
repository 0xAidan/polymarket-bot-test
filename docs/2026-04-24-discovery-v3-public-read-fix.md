# Discovery v3 — Public Read Surface Fix

**Date:** 2026-04-24
**Branch:** `fix/discovery-v3-public-read` (off `discovery-v3-rebuild`)
**PR:** opened, **NOT merged** — awaits manual merge per Space policy
**Status:** Green locally (270/270 tests, typecheck clean); ready to deploy to staging

## TL;DR

`staging.ditto.jungle.win/discovery-v3/` was showing a blocking red
banner — `HTTP 401: {"success":false,"error":"Authentication required"}` —
to every visitor without an Auth0 session. i.e. to every single person
the link was shared with. Fixed by making the v3 read endpoints public
and gating only mutations (`/track`, `/watchlist`, `/dismiss`) behind
per-route auth.

## Root cause

`src/server.ts` wired `/api` with a blanket OIDC gate:

```ts
app.use('/api', apiLimiter, requireOidcAuth, …);  // 401 for anyone without session
app.use('/api/discovery/v3', createDiscoveryV3Router(…));  // mounted BEHIND the gate
```

The Rev 7 fix (commit `7364a75`) skipped v3 from the rate limiter but
did nothing about the auth gate — every `/api/discovery/v3/*` fetch
from an anonymous browser still got 401. The v3 frontend's `safeFetch`
had no 401 handling, so it surfaced the raw body as the red-error
banner. Users had no way to know they needed to click something, and
there was no sign-in CTA on the page.

## Fix — three layers

### Layer 1: per-route auth gate on the router

`src/api/discoveryRoutesV3.ts` exports `requireAuthForMutations`:

```ts
export const requireAuthForMutations = (req, res, next) => {
  const oidc = req.oidc;
  if (oidc && typeof oidc.isAuthenticated === 'function') {
    if (oidc.isAuthenticated()) return next();
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      loginUrl: '/auth/login',
    });
  }
  next(); // non-OIDC mode — upstream middleware handles it
};
```

Applied to the four mutation routes only:

| Route | Gate? |
|---|---|
| `GET /tier/:tier` | ❌ public |
| `GET /wallet/:address` | ❌ public |
| `GET /compare` | ❌ public |
| `GET /health` | ❌ public |
| `GET /cutover-status` | ❌ public |
| `POST /watchlist` | ✅ `requireAuthForMutations` |
| `DELETE /watchlist/:addr` | ✅ `requireAuthForMutations` |
| `POST /dismiss` | ✅ `requireAuthForMutations` |
| `POST /track` | ✅ `requireAuthForMutations` |

### Layer 2: mount v3 above the global auth gate

`src/server.ts` now defines `mountDiscoveryV3Public()` and calls it in
all three auth modes (OIDC, legacy API-secret, open dev) **before** the
global gate is installed. Critically, in OIDC mode the mount sits
*after* `app.use(auth(oidcConfig))` so `req.oidc` is populated on every
v3 request — the per-route gate needs it to distinguish logged-in vs
anonymous.

Belt-and-suspenders: the global `/api` middleware now short-circuits for
any `/discovery/v3/*` path so the tenant resolver doesn't double-handle
a request that's already been served.

### Layer 3: frontend auth-awareness

`public/discovery-v3/app.js`:

- `safeFetch` passes `credentials: 'same-origin'` so the Auth0 session
  cookie reaches the server.
- 401 → returns `{ kind: 'auth_required', loginUrl }` instead of the
  raw HTTP error. Callers prompt login, never show the raw banner.
- On boot, `refreshAuthStatus()` hits `/api/auth/me` to determine
  `state.authed`, then renders a header auth-bar:
  - Guest: `"Viewing as guest — sign in to copy trade"` + **Sign in** button
  - Authed: `"Signed in"` + **Log out** link
- Copy-trade CTA relabels to **"Sign in to Copy"** for guests and
  redirects to `/auth/login?returnTo=…` on click.

`public/discovery-v3/styles.css`: auth-bar styling (flex row, accent
pill button, `needs-auth` variant of the Copy CTA).

## Tests

`tests/discoveryV3PublicAuth.test.ts` — 4 tests, all green:

1. Anonymous GETs on `/tier/alpha`, `/health`, `/cutover-status`,
   `/compare` all return 200 JSON.
2. Anonymous POSTs/DELETEs on `/track`, `/watchlist`,
   `/watchlist/:addr`, `/dismiss` all return 401 JSON with
   `loginUrl: '/auth/login'`.
3. Mutators succeed when `req.oidc.isAuthenticated()` returns true.
4. `requireAuthForMutations` lets the request through when `req.oidc`
   is absent (legacy / dev fallthrough).

Full suite: **270/270 pass.** Existing `tests/apiRateLimiter.test.ts`
still green — no regression to Rev 7.

## Deploy

```bash
cd /opt/polymarket-bot-staging
git fetch origin
git checkout fix/discovery-v3-public-read
npm ci
npm run build
sudo systemctl restart polymarket-app-staging
# discovery-worker-staging does NOT need a restart (no worker changes).
```

Post-deploy smoke:

```bash
# Anonymous — MUST return 200 JSON success:true:
curl -s https://staging.ditto.jungle.win/api/discovery/v3/tier/alpha | jq .success
curl -s https://staging.ditto.jungle.win/api/discovery/v3/health | jq .success

# Anonymous — MUST return 401 JSON with loginUrl:
curl -s -X POST https://staging.ditto.jungle.win/api/discovery/v3/track \
  -H 'content-type: application/json' -d '{"address":"0x1111111111111111111111111111111111111111"}' \
  | jq '{success, error, loginUrl}'
```

Then load `staging.ditto.jungle.win/discovery-v3/` in an incognito
window and confirm: tier list populates, header shows "Viewing as
guest — sign in to copy trade", Copy CTAs say "Sign in to Copy".

## Invariants (captured in `CODEBASE_GUIDE.md` Rev 8)

1. The v3 read surface is **public**. Do not add auth to it. If you
   need a private read, add a new path — don't quietly gate an
   existing v3 read.
2. Every v3 **mutation** MUST attach `requireAuthForMutations` as
   per-route middleware. Do not rely on global `requireOidcAuth`,
   because the v3 router is mounted above it.
3. The v3 frontend must always set `credentials: 'same-origin'` on
   fetches and must never render the raw 401 body. Route the user to
   `/auth/login?returnTo=…` instead.
