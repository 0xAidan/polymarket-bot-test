#!/usr/bin/env bash
# One-shot staging deploy for Polymarket V2 fixes (run ON THE SERVER as root).
# Usage: bash scripts/deploy-staging-v2.sh
set -euo pipefail

STAGING_DIR="/opt/polymarket-bot-staging"
SERVICE="polymarket-app-staging.service"

if [ "$(pwd)" != "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
  cd "$STAGING_DIR"
fi

if [ ! -f "$STAGING_DIR/.env" ] && [ ! -f .env ]; then
  echo "ERROR: Run from $STAGING_DIR (staging only, NOT /opt/polymarket-bot)"
  exit 1
fi

echo "==> Staging deploy from $(pwd)"
sudo -u polymarket git fetch origin
sudo -u polymarket git checkout main
sudo -u polymarket git pull --ff-only
echo "==> Commit: $(git rev-parse --short HEAD)"

grep '^DATA_DIR=' .env || true
grep '^POLYMARKET_SIGNATURE_TYPE=' .env || echo "WARN: POLYMARKET_SIGNATURE_TYPE not set in .env"
grep '^POLYMARKET_BUILDER_CODE=' .env || echo "WARN: POLYMARKET_BUILDER_CODE not set (orders work, no attribution)"

sudo -u polymarket npm ci --legacy-peer-deps
sudo -u polymarket npm run build
sudo systemctl restart "$SERVICE"

sleep 2
curl -sf "http://127.0.0.1:3005/health" | head -c 200 && echo
curl -sf "https://staging.ditto.jungle.win/health" | head -c 200 && echo
curl -sf "https://staging.ditto.jungle.win/health/ready" && echo " ready OK"

echo ""
echo "DONE. Open https://staging.ditto.jungle.win — log in, Start copy trading, check logs:"
echo "  sudo journalctl -u $SERVICE -f"
