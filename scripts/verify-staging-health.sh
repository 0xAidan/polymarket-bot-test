#!/usr/bin/env bash
# Public staging checks (run from your laptop / CI). Does not require SSH.
# Usage:
#   ./scripts/verify-staging-health.sh
#   STAGING_URL=https://staging.example.com ./scripts/verify-staging-health.sh
#   TRACE=1 ./scripts/verify-staging-health.sh   # verbose curl (TLS + headers) for Network-tab-style debugging

set -euo pipefail

BASE="${STAGING_URL:-https://staging.ditto.jungle.win}"
CURL_BASE=(curl -sS -L --connect-timeout 20 --max-time 60)

echo "=== Staging health: ${BASE} ==="
echo ""

req() {
  local name="$1"
  local path="$2"
  shift 2
  if [[ "${TRACE:-}" == "1" ]]; then
    echo "--- TRACE ${name} ---"
    curl -sS -L --connect-timeout 20 --max-time 60 -w "\n(time_total=%{time_total}s http_code=%{http_code} remote_ip=%{remote_ip})\n" -v "$@" "${BASE}${path}" 2>&1 | head -80
    echo ""
  else
    local code body
    body="$("${CURL_BASE[@]}" -w "\n%{http_code}" "$@" "${BASE}${path}")"
    code=$(echo "$body" | tail -n1)
    body=$(echo "$body" | sed '$d')
    echo "${name}: HTTP ${code}"
    echo "$body" | head -c 400
    echo ""
    echo ""
  fi
}

req "GET /health" "/health"
req "GET /api/auth/required" "/api/auth/required"
echo "GET /api/auth/me (expect 401 without browser session)"
req "GET /api/auth/me" "/api/auth/me"
echo "GET /api/discovery/home (expect 401 without browser session — JSON body, not a network failure)"
req "GET /api/discovery/home" "/api/discovery/home"

echo "=== Summary ==="
echo "If /health and /api/auth/required return 200 but the browser shows 'Failed to fetch', compare:"
echo "  - DevTools Network: failed vs 502 vs (blocked:mixed-content)"
echo "  - Same-origin session cookies for /api after OIDC login"
echo "  - Browser extensions / corporate proxy"
echo "Unauthenticated 401 JSON from /api/discovery/home means the route is reachable; session or client-side issue if UI still errors."
