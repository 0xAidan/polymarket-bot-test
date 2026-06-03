# Staging Update Handoff

Use this runbook to update staging safely without touching production resources.

## 1) Required Inputs (Fill Before Running)

- `STAGING_HOST`: SSH target (IP or hostname)
- `STAGING_APP_DIR`: staging repository directory
- `STAGING_SERVICE`: staging app service name
- `TARGET_BRANCH_OR_SHA`: exact branch or commit to deploy
- `STAGING_URL`: public staging URL

Example placeholders:

- `STAGING_APP_DIR=/opt/polymarket-bot-staging`
- `STAGING_SERVICE=polymarket-app-staging.service`

## 2) Safety Rules

- Do not run commands in production directories/services.
- Do not restart production services from this flow.
- Stop immediately if command output indicates a production path/service.

## 3) Pre-Deploy Checks

SSH to staging host and verify context:

```bash
ssh <STAGING_HOST>
cd <STAGING_APP_DIR>
pwd
```

Expected:

- `pwd` matches intended staging path exactly.

Verify git and working tree:

```bash
git status --short --branch
```

## 4) Checkout Target Revision

```bash
sudo -u polymarket git fetch origin
sudo -u polymarket git checkout <TARGET_BRANCH_OR_SHA>
sudo -u polymarket git pull --ff-only || true
git rev-parse HEAD
```

Record the deployed commit SHA.

## 5) Build and Restart Staging

```bash
grep '^DATA_DIR=' .env || true
sudo -u polymarket npm ci --legacy-peer-deps
sudo -u polymarket npm run build
sudo systemctl restart <STAGING_SERVICE>
sudo systemctl status <STAGING_SERVICE> --no-pager
```

## 6) Health and Reachability Checks

Local host checks:

```bash
curl -s http://127.0.0.1:3005/health
```

Public staging checks:

```bash
curl -I https://<STAGING_URL>
curl -s https://<STAGING_URL>/health
```

Repository-verifiable app route:

- `/health` (implemented in `src/server.ts`)

### About `/health/ready`

`/health/ready` is referenced in some deployment scripts/docs but is not defined as an app route in repository server code. Use it only if your infrastructure layer provides it and you have confirmed behavior in that environment.

## 7) Auth/UX Smoke Checks

In browser:

- open `https://<STAGING_URL>`
- verify login flow (if OIDC mode)
- verify core dashboard loads and API calls succeed

If Discovery v3 is enabled:

- verify `https://<STAGING_URL>/api/discovery/v3/health`

## 8) Evidence to Capture

- deployed commit SHA
- `systemctl status` output for staging service
- `/health` output
- browser smoke-check notes/screenshots

## 9) Recovery Steps

If deploy fails:

1. collect logs:

```bash
sudo journalctl -u <STAGING_SERVICE> -n 200 --no-pager
```

2. roll back to previous known-good commit:

```bash
sudo -u polymarket git checkout <previous-good-sha>
sudo -u polymarket npm ci --legacy-peer-deps
sudo -u polymarket npm run build
sudo systemctl restart <STAGING_SERVICE>
```

3. re-run health checks.

## 10) Explicit Production Guard

Before ending session, verify production services were not touched:

```bash
systemctl status polymarket-app.service --no-pager || true
systemctl status polymarket-discovery-worker.service --no-pager || true
```
