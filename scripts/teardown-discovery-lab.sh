#!/usr/bin/env bash
# One-time Discovery teardown for prod + staging (run after archive verified).
set -euo pipefail

echo "=== Discovery teardown $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="

sudo systemctl stop polymarket-discovery-worker.service polymarket-discovery-worker-staging.service 2>/dev/null || true
sudo systemctl disable polymarket-discovery-worker.service polymarket-discovery-worker-staging.service 2>/dev/null || true

VOLUME="${DISCOVERY_LAB_ROOT:-/mnt/HC_Volume_105468668}"
STAGING_DATA="${STAGING_DATA_DIR:-$VOLUME/polymarket-staging-data}"
PROD_DATA="${PROD_DATA_DIR:-/opt/polymarket-bot/data}"

for app_dir in /opt/polymarket-bot /opt/polymarket-bot-staging; do
  if [[ -f "$app_dir/.env" ]]; then
  # shellcheck disable=SC1090
    if grep -q '^DISCOVERY_ENABLED=' "$app_dir/.env"; then
      sed -i 's/^DISCOVERY_ENABLED=.*/DISCOVERY_ENABLED=false/' "$app_dir/.env"
    else
      echo 'DISCOVERY_ENABLED=false' >> "$app_dir/.env"
    fi
    if grep -q '^DISCOVERY_V3=' "$app_dir/.env"; then
      sed -i 's/^DISCOVERY_V3=.*/DISCOVERY_V3=false/' "$app_dir/.env"
    else
      echo 'DISCOVERY_V3=false' >> "$app_dir/.env"
    fi
  fi
done

APP_DIR=/opt/polymarket-bot DATA_DIR="$PROD_DATA" bash /opt/polymarket-bot/scripts/cleanup-discovery-lab.sh
APP_DIR=/opt/polymarket-bot-staging DATA_DIR="$STAGING_DATA" bash /opt/polymarket-bot/scripts/cleanup-discovery-lab.sh

if command -v sqlite3 >/dev/null 2>&1; then
  for db in "$PROD_DATA/copytrade.db" "$STAGING_DATA/copytrade.db"; do
    if [[ -f "$db" ]]; then
      echo "VACUUM $db"
      sqlite3 "$db" "VACUUM;"
    fi
  done
fi

sudo systemctl restart polymarket-app.service polymarket-app-staging.service 2>/dev/null || true

echo "=== Disk after teardown ==="
df -h / "$VOLUME" 2>/dev/null || df -h /
curl -s https://ditto.jungle.win/health | head -c 500 || true
echo
curl -s https://staging.ditto.jungle.win/health | head -c 500 || true
echo
