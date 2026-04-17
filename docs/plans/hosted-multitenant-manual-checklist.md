# Hosted multitenant — manual verification (E2E)

Use this after deploy or before calling production “done.” Automated tests cover migration, tenant storage, and API pieces; this checklist is for **two real accounts** and **ops**.

## Accounts & isolation

1. Sign up / log in as **Account A** → dashboard shows **your** tracked wallets, trading wallets, and empty state if new.
2. Sign up / log in as **Account B** in another browser (or incognito) → **different** data; no wallets from A.
3. Account A adds a tracked wallet + copy assignment + trading wallet → only A sees it.
4. Log out A, log back in → same data for A.
5. B still sees **only** B’s data.

## Tenant header / IDOR

6. While logged in as A, do **not** get B’s data by changing `x-tenant-id` in DevTools (server should return **403** or empty for forbidden tenant).
7. `POST /api/config/private-key` and `POST /api/config/builder-credentials` return **403** in hosted mode.

## Background behavior

8. With both tenants having active tracked wallets, monitoring runs for **both** (no cross-tenant execution).
9. Ladder exits / stop-loss: each workspace’s rules load from **that** tenant’s `bot_config` (SQLite); price monitor ticks **per tenant** in hosted mode.

## Operations (production)

10. `DATA_DIR` is **absolute** on the server when `NODE_ENV=production` and hosted multitenant is active.
11. SQLite DB + `data/keystores/<tenant_id>/` are included in **backups**.
12. App + discovery worker run under **systemd** (or equivalent), restart on reboot.
13. HTTPS via reverse proxy; `/health` returns OK.

## Discovery

14. Discovery lists are **shared**; **Track** / copy actions only write the **logged-in** tenant’s tracked-wallet list.
