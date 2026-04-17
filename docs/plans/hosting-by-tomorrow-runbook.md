# Hosting By Tomorrow - Minimal Manual Runbook

This is the simplest path from local to cloud.

## You only do these 4 things

1. Create a Hetzner server (Ubuntu 22.04 or Debian 12).
2. Point DNS `A` record for `ditto.jungle.win` to your server IPv4.
3. SSH into server and run one copy/paste block below.
4. Paste your production `.env` into `/opt/polymarket-bot/.env`.

Everything else is automated by repo scripts.

---

## 1) Local machine prep (already mostly done)

This repo now includes:
- `scripts/vps-bootstrap.sh` (server bootstrap)
- `scripts/deploy-production.sh` (future updates)
- `scripts/backup-data.sh` (nightly backups)
- `deploy/Caddyfile`
- `deploy/systemd/*.service` and `*.timer`

---

## 2) One-time server bootstrap (copy/paste)

Run this from your laptop:

```bash
ssh root@YOUR_SERVER_IP
```

Then on server:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/0xAidan/polymarket-bot-test.git /opt/polymarket-bot
cd /opt/polymarket-bot
sudo APP_DOMAIN=ditto.jungle.win TLS_EMAIL=YOUR_EMAIL@example.com bash scripts/vps-bootstrap.sh
```

---

## 3) Add production secrets

Create env file:

```bash
cd /opt/polymarket-bot
nano .env
```

Add your production values (wallet keys, polymarket builder creds, API secret, etc), save file.

Then restart:

```bash
sudo systemctl restart polymarket-app.service polymarket-discovery-worker.service
```

---

## 4) Health checks

```bash
sudo systemctl status polymarket-app.service --no-pager
sudo systemctl status polymarket-discovery-worker.service --no-pager
sudo systemctl status caddy.service --no-pager
curl -I https://ditto.jungle.win
cd /opt/polymarket-bot && npm run validate:egress
```

Expected:
- all services show `active (running)`
- HTTPS responds
- egress validation passes

---

## 5) Backup and restore proof

Run backup once:

```bash
sudo systemctl start polymarket-backup.service
ls -lah /opt/polymarket-bot/backups
```

Restore drill (non-production folder):

```bash
mkdir -p /tmp/polymarket-restore-test
tar -xzf /opt/polymarket-bot/backups/data-*.tar.gz -C /tmp/polymarket-restore-test
ls -lah /tmp/polymarket-restore-test
```

---

## 6) Future deployments (single command)

```bash
cd /opt/polymarket-bot
git pull
bash scripts/deploy-production.sh
```
