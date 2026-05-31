#!/usr/bin/env bash
# Run on the staging host over SSH (see docs/plans/staging-preview-runbook.md).
# Usage (example):
#   ssh polymarket@staging-host 'bash -s' < scripts/verify-staging-on-server.sh
# Or copy repo to server and: ./scripts/verify-staging-on-server.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/polymarket-bot-staging}"
SERVICE="${STAGING_SERVICE_NAME:-polymarket-app-staging.service}"
PORT="${PORT:-}"
DISCOVERY_UNIT="${DISCOVERY_WORKER_UNIT:-polymarket-discovery-worker.service}"

echo "=== App directory: ${APP_DIR} ==="
if [[ ! -d "$APP_DIR" ]]; then
  echo "WARN: ${APP_DIR} not found; set APP_DIR to your deploy path."
fi

if [[ -f "${APP_DIR}/.env" ]] && [[ -z "${PORT}" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "${APP_DIR}/.env" 2>/dev/null || true
  set +a
  PORT="${PORT:-3005}"
fi
PORT="${PORT:-3005}"

echo "=== systemd: ${SERVICE} ==="
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl status "$SERVICE" --no-pager || true
  echo ""
  echo "=== Last 80 log lines ==="
  sudo journalctl -u "$SERVICE" -n 80 --no-pager || true
else
  echo "systemctl not available (not a Linux systemd host?)"
fi

echo ""
echo "=== Listen on PORT ${PORT} (node / npm) ==="
if command -v ss >/dev/null 2>&1; then
  ss -lntp | grep -E ":${PORT}\\b" || echo "Nothing listening on :${PORT}"
else
  echo "ss not installed"
fi

echo ""
echo "=== Localhost (no TLS) ==="
curl -sS -o /dev/null -w "GET /health -> HTTP %{http_code} in %{time_total}s\n" "http://127.0.0.1:${PORT}/health" || echo "curl failed"
curl -sS -w "\nGET /api/auth/required -> HTTP %{http_code}\n" "http://127.0.0.1:${PORT}/api/auth/required" | head -c 400
echo ""

echo ""
echo "=== Deployed git (if repo) ==="
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true
  git -C "$APP_DIR" log -1 --oneline 2>/dev/null || true
  git -C "$APP_DIR" branch -vv 2>/dev/null | head -5 || true
else
  echo "No .git in ${APP_DIR}"
fi

echo ""
echo "=== Optional discovery worker (data freshness; separate from HTTP /api/discovery on main app) ==="
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -q discovery; then
    sudo systemctl status "$DISCOVERY_UNIT" --no-pager 2>/dev/null || echo "Unit ${DISCOVERY_UNIT} not active or not installed"
  else
    echo "No discovery-related systemd unit found; worker may run elsewhere or not be installed."
  fi
fi

if command -v ss >/dev/null 2>&1; then
  echo ""
  echo "=== DISCOVERY_WORKER_PORT (default 3002) ==="
  ss -lntp | grep -E ':3002\b' || echo "Nothing listening on :3002 (worker may be off or use another port)"
fi

echo ""
echo "Done."
