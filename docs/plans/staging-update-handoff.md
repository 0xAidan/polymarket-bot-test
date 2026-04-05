# Ditto Staging Update Handoff

Use this document when you want to update `staging.ditto.jungle.win` without touching live production.

## Read This First

You are only allowed to touch staging.

Safe staging items:

- Repo folder: `/opt/polymarket-bot-staging`
- Env file: `/opt/polymarket-bot-staging/.env`
- Data folder: `/opt/polymarket-bot-staging/data`
- Service: `polymarket-app-staging.service`
- URL: `staging.ditto.jungle.win`
- Port: `3005`

Do not touch production:

- `/opt/polymarket-bot`
- `/opt/polymarket-bot/.env`
- `polymarket-app.service`
- `polymarket-discovery-worker.service`
- `ditto.jungle.win`
- port `3001`

## One Simple Rule

If a command says `/opt/polymarket-bot` instead of `/opt/polymarket-bot-staging`, stop.

If a command says `polymarket-app.service` instead of `polymarket-app-staging.service`, stop.

## Normal Staging Update

Follow these steps in order.

### Step 1. SSH into the server

```bash
ssh root@46.62.231.173
```

### Step 2. Go to the staging folder

```bash
cd /opt/polymarket-bot-staging
pwd
```

Expected result:

```bash
/opt/polymarket-bot-staging
```

If you are not in `/opt/polymarket-bot-staging`, stop.

### Step 3. Pull the branch you want to review

Current review branch:

```bash
sudo -u polymarket git fetch origin
sudo -u polymarket git checkout feature/ditto-jungle-preview
sudo -u polymarket git pull --ff-only
```

If the review branch changes later, replace `feature/ditto-jungle-preview` with the new branch name.

### Step 4. Install packages and build staging

```bash
grep '^DATA_DIR=' /opt/polymarket-bot-staging/.env
sudo -u polymarket npm ci --legacy-peer-deps
sudo -u polymarket npm run build
```

Expected result:

- `DATA_DIR` points at staging-owned storage, not production or repo-relative production paths
- install finishes
- build finishes
- no fatal errors

### Step 5. Restart staging only

```bash
sudo systemctl restart polymarket-app-staging.service
```

Only restart this service.

Do not restart:

```bash
polymarket-app.service
polymarket-discovery-worker.service
```

### Step 6. Check that staging is running

```bash
sudo systemctl status polymarket-app-staging.service --no-pager
curl -I http://127.0.0.1:3005
curl -I https://staging.ditto.jungle.win
curl https://staging.ditto.jungle.win/health
curl -f https://staging.ditto.jungle.win/health/ready
```

Expected result:

- `polymarket-app-staging.service` shows `active (running)`
- `http://127.0.0.1:3005` responds
- `https://staging.ditto.jungle.win` responds with a normal HTTP status such as `HTTP/2 200`
- `/health` returns JSON with `status`
- `/health/ready` returns success for the staged release candidate

### Step 7. Open staging in the browser

```text
https://staging.ditto.jungle.win
```

This is the page the team should review.

## If Something Goes Wrong

### Problem: staging service does not start

Run:

```bash
sudo systemctl status polymarket-app-staging.service --no-pager
sudo journalctl -u polymarket-app-staging.service -n 100 --no-pager
```

### Problem: SSL or certificate error on staging

Run:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo journalctl -u caddy -n 100 --no-pager
```

### Problem: Auth0 callback mismatch

Check these:

- `AUTH0_BASE_URL` in `/opt/polymarket-bot-staging/.env`
- Auth0 settings

Auth0 should include:

- Allowed Callback URLs:
  - `https://staging.ditto.jungle.win/auth/callback`
  - `https://staging.ditto.jungle.win/auth/callback/`
- Allowed Logout URLs:
  - `https://staging.ditto.jungle.win`
- Allowed Web Origins:
  - `https://staging.ditto.jungle.win`

### Problem: worried production may have been affected

Run:

```bash
systemctl status polymarket-app.service --no-pager
systemctl status polymarket-discovery-worker.service --no-pager
systemctl status polymarket-app-staging.service --no-pager
```

Production and staging are separate services. Restarting `polymarket-app-staging.service` does not restart production.

## Safe Copy/Paste Block

If someone already knows the basics and just wants the safe update commands:

```bash
cd /opt/polymarket-bot-staging && \
sudo -u polymarket git fetch origin && \
sudo -u polymarket git checkout feature/ditto-jungle-preview && \
sudo -u polymarket git pull --ff-only && \
grep '^DATA_DIR=' /opt/polymarket-bot-staging/.env && \
sudo -u polymarket npm ci --legacy-peer-deps && \
sudo -u polymarket npm run build && \
sudo systemctl restart polymarket-app-staging.service && \
sudo systemctl status polymarket-app-staging.service --no-pager && \
curl -I https://staging.ditto.jungle.win && \
curl https://staging.ditto.jungle.win/health && \
curl -f https://staging.ditto.jungle.win/health/ready
```

## Final Reminder

If you are not sure, stop and ask before touching anything production-named.
