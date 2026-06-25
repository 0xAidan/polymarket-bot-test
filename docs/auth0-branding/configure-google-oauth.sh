#!/usr/bin/env bash
# Configure production Google OAuth credentials on Auth0 and re-enable Google for Jungle Agents.
#
# Prereqs:
#   1. Your own Google Cloud OAuth Web client (see GOOGLE-OAUTH-SETUP.md)
#   2. auth0 login (tenant: dev-rjdevt32s21vhh86.us.auth0.com)
#
# Usage:
#   export GOOGLE_OAUTH_CLIENT_ID="....apps.googleusercontent.com"
#   export GOOGLE_OAUTH_CLIENT_SECRET="GOCSPX-...."
#   bash docs/auth0-branding/configure-google-oauth.sh
#
# Optional:
#   AUTH0_APP_NAME="Jungle Agents"  (default)
set -euo pipefail

APP_NAME="${AUTH0_APP_NAME:-Jungle Agents}"

if [[ -z "${GOOGLE_OAUTH_CLIENT_ID:-}" || -z "${GOOGLE_OAUTH_CLIENT_SECRET:-}" ]]; then
  echo "ERROR: Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first."
  echo "See docs/auth0-branding/GOOGLE-OAUTH-SETUP.md"
  exit 1
fi

echo "Looking up Auth0 application: $APP_NAME"
CLIENT_ID=$(auth0 apps list --json < /dev/null 2>/dev/null | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c).on('end',()=>{
    const apps=JSON.parse(d||'[]');
    const app=apps.find(a=>a.name==='${APP_NAME}');
    if(!app){ console.error('App not found: ${APP_NAME}'); process.exit(1); }
    console.log(app.client_id);
  });
")

CONN_ID=$(auth0 api get "connections" --query "strategy=google-oauth2" < /dev/null 2>/dev/null | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c).on('end',()=>{
    const rows=JSON.parse(d||'[]');
    const conn=rows.find(c=>c.strategy==='google-oauth2');
    if(!conn){ console.error('Google connection not found'); process.exit(1); }
    console.log(conn.id);
  });
")

echo "Auth0 app client ID: $CLIENT_ID"
echo "Google connection ID: $CONN_ID"
echo "Updating Google connection with your OAuth credentials..."

PATCH_PAYLOAD=$(node -e "
  const payload = {
    options: {
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      scope: ['email', 'profile'],
      email: true,
      profile: true,
    },
  };
  console.log(JSON.stringify(payload));
")

auth0 api patch "connections/$CONN_ID" --data "$PATCH_PAYLOAD" < /dev/null

echo "Re-enabling Google sign-in for $APP_NAME..."
auth0 api patch "connections/$CONN_ID/clients" \
  --data "[{\"client_id\":\"$CLIENT_ID\",\"status\":true}]" < /dev/null

echo ""
echo "Done."
echo "  - Google OAuth credentials saved in Auth0 (not in this repo)."
echo "  - Google sign-in enabled for: $APP_NAME"
echo ""
echo "Verify:"
echo "  1. Auth0 Dashboard → Authentication → Social → Google → no 'development keys' warning"
echo "  2. Incognito → https://ditto.jungle.win → Sign in with Google"
echo "  3. Existing Google users should reach the same workspace as before"
