#!/usr/bin/env bash
# Re-enables Google social login for the Jungle Agents Auth0 application.
# Use AFTER configure-google-oauth.sh (real Google credentials), not with dev keys.
#
# Prereq: auth0 login
# Usage:  bash docs/auth0-branding/enable-google-login.sh
set -euo pipefail

APP_NAME="${AUTH0_APP_NAME:-Jungle Agents}"

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

echo "Client ID: $CLIENT_ID"
echo "Google connection ID: $CONN_ID"
echo "Enabling Google login for application..."

auth0 api patch "connections/$CONN_ID/clients" \
  --data "[{\"client_id\":\"$CLIENT_ID\",\"status\":true}]" < /dev/null

echo "Done. Google sign-in is enabled for $APP_NAME."
