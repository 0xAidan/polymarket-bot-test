# Auth0 — Jungle Agents Branding

The login/signup experience is served by Auth0 Universal Login, branded to match the
Jungle Agents design system (`public/shared/jungle-brand.css`).

## What's configured (applied via `apply.sh`)

| Piece | Value |
| --- | --- |
| Tenant | `dev-rjdevt32s21vhh86.us.auth0.com` (account linked to the owner's GitHub) |
| Application | "Jungle Agents" (Regular Web App) |
| Callbacks | `http://localhost:3000/auth/callback`, `https://ditto.jungle.win/auth/callback` |
| Logout URLs | `http://localhost:3000`, `https://ditto.jungle.win` |
| Tenant friendly name | "Jungle Agents" (replaces the raw `dev-…` name on screens/emails) |
| Logo | gold jungle-eyes mark, served from this repo (raw GitHub URL pinned to a commit) |
| Theme | dark navy page (#161721), card #1C1D2E, gold primary (#E5B80B) — see `theme.json` |
| Custom text | "Welcome to the Jungle" / "Join the Jungle" — see `custom-text-*.json` |

## How to re-apply (e.g. on a new tenant)

```bash
auth0 login          # log in to the tenant
bash docs/auth0-branding/apply.sh
```

## Production checklist (before launch)

1. Set on the production server (values from the Auth0 dashboard → Applications → Jungle Agents):
   - `AUTH0_ISSUER_BASE_URL=https://dev-rjdevt32s21vhh86.us.auth0.com`
   - `AUTH0_CLIENT_ID=<client id>`
   - `AUTH0_CLIENT_SECRET=<client secret>`
   - `AUTH0_BASE_URL=https://ditto.jungle.win`
2. **Google login uses Auth0 dev keys** — fine for testing, but rate-limited and shows a
   tenant-admin warning. Before launch either:
   - create real Google OAuth credentials (Google Cloud Console → OAuth consent screen +
     client id/secret → paste into Auth0 → Authentication → Social → Google), or
   - disable the Google connection for the Jungle Agents app so only email/password shows.
3. Optional polish: a custom domain (e.g. `login.jungle.win`) removes the
   `dev-…us.auth0.com` address from the browser bar. Needs DNS access; not required.
4. The logo URL is pinned to a git commit and never breaks. To swap the logo, replace
   `public/shared/logo-gold.png`, push, update `LOGO_URL` in `apply.sh`, re-run it.

## User provisioning

No manual steps: the first time anyone logs in (email/password signup or Google), the app
creates their account row and a private workspace automatically (`src/authStore.ts`).
