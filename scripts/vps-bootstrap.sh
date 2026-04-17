#!/usr/bin/env bash

set -euo pipefail

# Usage:
# sudo APP_DOMAIN=ditto.jungle.win TLS_EMAIL=you@example.com bash scripts/vps-bootstrap.sh

APP_DOMAIN="${APP_DOMAIN:-}"
TLS_EMAIL="${TLS_EMAIL:-}"
APP_USER="${APP_USER:-polymarket}"
APP_DIR="${APP_DIR:-/opt/polymarket-bot}"
DATA_DIR="${DATA_DIR:-/var/lib/polymarket/data}"

if [[ -z "$APP_DOMAIN" || -z "$TLS_EMAIL" ]]; then
  echo "ERROR: APP_DOMAIN and TLS_EMAIL are required."
  echo "Example:"
  echo "  sudo APP_DOMAIN=ditto.jungle.win TLS_EMAIL=you@example.com bash scripts/vps-bootstrap.sh"
  exit 1
fi

if [[ ! -f "package.json" || ! -d "deploy" ]]; then
  echo "ERROR: Run this script from the repository root."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y curl ca-certificates gnupg git ufw sqlite3 rsync

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$APP_USER"
fi

mkdir -p "$APP_DIR" "$DATA_DIR" "$APP_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

if [[ "$PWD" != "$APP_DIR" ]]; then
  rsync -a --delete --exclude '.git' --exclude 'node_modules' ./ "$APP_DIR"/
fi

cd "$APP_DIR"
npm ci --legacy-peer-deps
npm run build

chmod +x scripts/backup-data.sh scripts/deploy-production.sh

install -m 0644 deploy/systemd/polymarket-app.service /etc/systemd/system/polymarket-app.service
install -m 0644 deploy/systemd/polymarket-discovery-worker.service /etc/systemd/system/polymarket-discovery-worker.service
install -m 0644 deploy/systemd/polymarket-backup.service /etc/systemd/system/polymarket-backup.service
install -m 0644 deploy/systemd/polymarket-backup.timer /etc/systemd/system/polymarket-backup.timer

install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile

if ! grep -q '^APP_DOMAIN=' /etc/environment; then
  echo "APP_DOMAIN=$APP_DOMAIN" >> /etc/environment
fi
if ! grep -q '^TLS_EMAIL=' /etc/environment; then
  echo "TLS_EMAIL=$TLS_EMAIL" >> /etc/environment
fi

ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true

systemctl daemon-reload
systemctl enable polymarket-app.service polymarket-discovery-worker.service polymarket-backup.timer caddy.service
systemctl restart polymarket-app.service
systemctl restart polymarket-discovery-worker.service
systemctl restart polymarket-backup.timer
systemctl restart caddy.service

echo
echo "Bootstrap complete."
echo "Next:"
echo "1) Copy your production .env into $APP_DIR/.env"
echo "2) Restart app: sudo systemctl restart polymarket-app.service polymarket-discovery-worker.service"
echo "3) Verify health: systemctl status polymarket-app.service --no-pager"
