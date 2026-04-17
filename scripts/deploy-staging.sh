#!/usr/bin/env bash

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STAGING_SERVICE_NAME="${STAGING_SERVICE_NAME:-polymarket-app-staging.service}"
RESTART_CADDY="${RESTART_CADDY:-1}"

cd "$APP_DIR"

npm ci --legacy-peer-deps
npm run build

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart "$STAGING_SERVICE_NAME"
  if [ "$RESTART_CADDY" = "1" ]; then
    sudo systemctl restart caddy.service
  fi
else
  echo "systemctl not found; build completed but staging service was not restarted."
fi
