#!/usr/bin/env bash
# One-shot PRODUCTION deploy (run ON THE SERVER as root, AFTER staging looks good).
# Usage: bash scripts/deploy-production-v2.sh
set -euo pipefail

PROD_DIR="/opt/polymarket-bot"
APP_SERVICE="polymarket-app.service"
WORKER_SERVICE="polymarket-discovery-worker.service"

cd "$PROD_DIR"

echo "==> PRODUCTION deploy from $(pwd)"
read -r -p "Type DEPLOY to continue: " confirm
if [ "$confirm" != "DEPLOY" ]; then
  echo "Aborted."
  exit 1
fi

BACKUP_TAG="$(date +%Y%m%d-%H%M)"
sudo cp -a data "data.backup-${BACKUP_TAG}" 2>/dev/null || true
sudo cp .env ".env.backup-${BACKUP_TAG}"

sudo -u polymarket git fetch origin
sudo -u polymarket git checkout main
sudo -u polymarket git pull --ff-only
echo "==> Commit: $(git rev-parse --short HEAD)"

sudo -u polymarket npm ci --legacy-peer-deps
sudo -u polymarket npm run build
sudo systemctl restart "$APP_SERVICE"
sudo systemctl restart "$WORKER_SERVICE"

sleep 2
curl -sf "https://ditto.jungle.win/health" | head -c 200 && echo
curl -sf "https://ditto.jungle.win/health/ready" && echo " ready OK"

echo ""
echo "DONE. Open https://ditto.jungle.win and smoke-test copy trading."
