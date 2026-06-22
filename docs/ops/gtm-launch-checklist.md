# Ditto GTM launch checklist

## Production environment (copy-paste)

```env
DISCOVERY_ENABLED=false
DISCOVERY_V3=false
DATA_DIR=/opt/polymarket-bot/data
AUTH_MODE=oidc
STORAGE_BACKEND=sqlite
AUTH0_BASE_URL=https://ditto.jungle.win
# GTM: use custom domain — NOT dev-xxx.us.auth0.com (see docs/auth0-branding/custom-domain-setup.md)
AUTH0_ISSUER_BASE_URL=https://login.ditto.jungle.win
AUTH_SESSION_SECRET=<64+ random chars>
PLATFORM_ADMIN_EMAILS=<real admin emails only>
# PRIVATE_KEY unset
# API_SECRET empty / unused
```

Restart: `sudo systemctl restart polymarket-app.service`

## Pre-demo roster review

- [ ] Every **enabled** Jungle Agent has a Polymarket address (or is disabled)
- [ ] KING and other seed agents are not showing unexplained "Pending"
- [ ] Admin saves work (no ENOSPC / 507)

## Branded Auth0 verification

See [auth0-branding/production-gate.md](../auth0-branding/production-gate.md) for blockers.

- [ ] Login URL is `login.ditto.jungle.win` (not `dev-….us.auth0.com`)
- [ ] `bash docs/auth0-branding/apply.sh` run after copy changes
- [ ] Incognito → `https://ditto.jungle.win` → Auth0 shows "Log in to copy Jungle Agents", gold logo, dark navy
- [ ] `curl -s https://ditto.jungle.win/api/auth/required` → `"mode":"oidc"`, `"required":true`
- [ ] Log out → branded login returns
- [ ] Auth0 dashboard **Alerts → Dev Keys** cleared (disable Google or use real Google OAuth)

## Investor demo script (15 min)

1. Incognito → branded login (email signup)
2. Setup strip → Trading Wallets → add wallet + builder creds
3. Jungle Agents → Follow agent with real address
4. Tracked Wallets → enable toggle + confirm sizing defaults
5. Home → Start bot → status "running"
6. Diagnostics → monitor polling, no errors
7. Log out → log back in → session persists

## Automated gate

```bash
npm test
npm run build
npm run lint
curl -s https://ditto.jungle.win/health | jq .
```

## What we do not demo yet

- Discovery v3 completion, backfill, tier repair
- Discovery public scrape API
- Platforms / Cross-platform / Kalshi
- Admin Health / Tenants stubs
- Interactive video tutorial (post-GTM)
- Admin jungle wallet categorization UI (post-GTM)

## Hosted key model FAQ

- Users sign in with Auth0; Ditto uses **session-derived encryption** for trading wallet keys in hosted mode
- There is no separate "vault password" in hosted mode
- Builder credentials are configured **per trading wallet**, not in server `.env`

## Multi-wallet behavior (post-PR4)

- Single credentialed wallet: follow Jungle Agent auto-assigns copy mapping
- Two or more credentialed wallets: user must assign copy mappings under Trading Wallets

## Disk monitoring

- `/health` includes `disk.status`, `disk.usedPercent`, `disk.availableBytes`
- See [disk-budget.md](./disk-budget.md) for incident runbook
