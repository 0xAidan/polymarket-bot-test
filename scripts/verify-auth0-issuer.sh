#!/usr/bin/env bash
# Verify production Auth0 issuer is not the default dev-*.us.auth0.com hostname.
# Usage:
#   bash scripts/verify-auth0-issuer.sh
#   AUTH0_ISSUER_BASE_URL=https://login.ditto.jungle.win bash scripts/verify-auth0-issuer.sh
set -euo pipefail

ISSUER="${AUTH0_ISSUER_BASE_URL:-}"
BASE="${AUTH0_BASE_URL:-https://ditto.jungle.win}"

if [ -z "$ISSUER" ]; then
  echo "AUTH0_ISSUER_BASE_URL is not set."
  echo "Production should use: https://login.ditto.jungle.win"
  echo "See docs/auth0-branding/custom-domain-setup.md"
  exit 1
fi

if echo "$ISSUER" | grep -qE '\.us\.auth0\.com'; then
  echo "FAIL: AUTH0_ISSUER_BASE_URL still points at default Auth0 tenant hostname:"
  echo "  $ISSUER"
  echo ""
  echo "Users will see an ugly dev-*.us.auth0.com URL at login."
  echo "Fix: configure custom domain login.ditto.jungle.win (docs/auth0-branding/custom-domain-setup.md)"
  exit 1
fi

echo "OK: Auth0 issuer is branded ($ISSUER)"

if command -v curl >/dev/null 2>&1; then
  echo "Checking $BASE/api/auth/required ..."
  curl -sf "$BASE/api/auth/required" | head -c 200 || true
  echo ""
fi

echo "Done."
