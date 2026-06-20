#!/usr/bin/env bash
# Disables Google social login for the Ditto Auth0 application.
#
# Use this before GTM if you have NOT replaced Auth0's shared Google "dev keys"
# with your own Google Cloud OAuth credentials. Email/password login keeps working.
#
# Prereq: auth0 login
# Usage:  bash docs/auth0-branding/disable-google-login.sh
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

echo "Client ID: $CLIENT_ID"

CONN_ID=$(auth0 api get "connections" --query "strategy=google-oauth2" < /dev/null 2>/dev/null | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c).on('end',()=>{
    const rows=JSON.parse(d||'[]');
    const conn=rows.find(c=>c.strategy==='google-oauth2');
    if(!conn){ console.error('Google connection not found'); process.exit(1); }
    console.log(conn.id);
  });
")

echo "Google connection ID: $CONN_ID"
echo "Removing Google login from application..."

auth0 api patch "connections/$CONN_ID/clients" \
  --data "[{\"client_id\":\"$CLIENT_ID\",\"status\":false}]" < /dev/null

echo "Done. Google sign-in is disabled for $APP_NAME."
echo "The Auth0 dashboard 'development keys' alert should clear within a few minutes."
echo "Users can still sign in with email and password."
