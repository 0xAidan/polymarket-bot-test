#!/usr/bin/env bash

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

cd "$APP_DIR"

npm ci --legacy-peer-deps
npm run build

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart polymarket-app.service
  sudo systemctl restart polymarket-discovery-worker.service
  sudo systemctl restart caddy.service
else
  echo "systemctl not found; build completed but services were not restarted."
fi
