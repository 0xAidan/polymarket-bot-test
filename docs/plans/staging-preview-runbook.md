# Ditto Staging Preview Runbook

This is the review path for the Ditto redesign before anything touches production.

## Goal

Serve the redesign branch on a non-production URL such as `staging.ditto.jungle.win` so the new UI can be reviewed safely before merge.

## Recommended shape

- App code lives in `/opt/polymarket-bot-staging`
- App listens on `127.0.0.1:3005`
- Caddy serves `staging.ditto.jungle.win`
- The staging app runs from the redesign branch, not `main`
- Discovery can stay disabled for pure UI review

## Safety rules

- Do not reuse production secrets blindly
- Prefer a separate staging `.env`
- Keep `DISCOVERY_ENABLED=false` unless explicitly needed
- Use safe auth settings for review
- If OIDC is enabled, add `https://staging.ditto.jungle.win` to the allowed callback and logout URLs
- Keep the bot stopped unless intentionally validating behavior

## One-time setup on the server

```bash
sudo mkdir -p /opt/polymarket-bot-staging
sudo chown -R polymarket:polymarket /opt/polymarket-bot-staging
git clone https://github.com/0xAidan/polymarket-bot-test.git /opt/polymarket-bot-staging
cd /opt/polymarket-bot-staging
git checkout <redesign-branch>
```

Create a staging env file:

```bash
cd /opt/polymarket-bot-staging
nano .env
```

Recommended staging-specific values:

```bash
PORT=3005
HOST=127.0.0.1
DISCOVERY_ENABLED=false
AUTH_MODE=legacy
API_SECRET=<choose-a-staging-secret>
```

If you need hosted auth review instead of legacy auth review, use the normal OIDC values but make sure the staging URL is allow-listed in the auth provider first.

Install the example systemd unit:

```bash
sudo cp deploy/systemd/polymarket-app-staging.service.example /etc/systemd/system/polymarket-app-staging.service
sudo systemctl daemon-reload
sudo systemctl enable polymarket-app-staging.service
```

Install the staging Caddy site:

```bash
sudo cp deploy/Caddyfile.staging.example /etc/caddy/sites/staging-ditto.caddy
```

Then include or merge that site block into your active Caddy configuration and reload Caddy.

## Deploy or update staging

```bash
cd /opt/polymarket-bot-staging
git fetch origin
git checkout <redesign-branch>
git pull --ff-only
bash scripts/deploy-staging.sh
```

## Validation

```bash
sudo systemctl status polymarket-app-staging.service --no-pager
curl -I https://staging.ditto.jungle.win
```

You should be able to review the redesign at:

`https://staging.ditto.jungle.win`

## What to review there

- Auth screen and no-flash initialization
- Home shell and navigation
- First-run setup guide
- Trading Wallets and Tracked Wallets flows
- Discovery page readability
- Settings and Diagnostics cleanup

## Promotion rule

Do not merge the redesign for production until the staging URL has been reviewed and approved.
