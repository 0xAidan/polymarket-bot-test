#!/usr/bin/env bash
# Applies Ditto branding to the active Auth0 tenant.
# Prereq: `auth0 login` against the tenant that hosts the Ditto application.
# Usage:  bash docs/auth0-branding/apply.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LOGO_URL="https://raw.githubusercontent.com/0xAidan/polymarket-bot-test/3089100063ebd1879319d1cd8c7ba07a3d833686/public/shared/logo-gold.png"

echo "1/8 Tenant friendly name + logo..."
auth0 api patch "tenants/settings" --data "{\"friendly_name\":\"Ditto\",\"picture_url\":\"$LOGO_URL\"}" < /dev/null

echo "2/8 Auth0 application display name..."
LEGACY_APP_NAME="${AUTH0_LEGACY_APP_NAME:-Jungle Agents}"
TARGET_APP_NAME="${AUTH0_APP_NAME:-Ditto}"
CLIENT_ID=$(auth0 apps list --json < /dev/null 2>/dev/null | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c).on('end',()=>{
    const apps=JSON.parse(d||'[]');
    const app=apps.find(a=>a.name==='${LEGACY_APP_NAME}') || apps.find(a=>a.name==='${TARGET_APP_NAME}');
    if(!app){ console.error('Auth0 app not found (${LEGACY_APP_NAME} or ${TARGET_APP_NAME})'); process.exit(1); }
    console.log(app.client_id);
  });
")
auth0 api patch "clients/$CLIENT_ID" --data "{\"name\":\"${TARGET_APP_NAME}\"}" < /dev/null

echo "3/8 Classic branding colors + logo..."
auth0 api patch "branding" --data "{\"colors\":{\"primary\":\"#E5B80B\",\"page_background\":\"#161721\"},\"logo_url\":\"$LOGO_URL\"}" < /dev/null

echo "4/8 Universal Login theme (create or update)..."
THEME_ID=$(auth0 api get "branding/themes/default" < /dev/null 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).themeId||'')}catch{console.log('')}})")
if [ -n "$THEME_ID" ]; then
  auth0 api patch "branding/themes/$THEME_ID" --data "$(cat "$DIR/theme.json")" < /dev/null
else
  auth0 api post "branding/themes" --data "$(cat "$DIR/theme.json")" < /dev/null
fi

echo "5/8 Login screen custom text (login + login-id)..."
auth0 api put "prompts/login/custom-text/en" --data "$(cat "$DIR/custom-text-login.json")" < /dev/null
auth0 api put "prompts/login-id/custom-text/en" --data "$(cat "$DIR/custom-text-login-id.json")" < /dev/null

echo "6/8 Signup screen custom text (signup + signup-id)..."
auth0 api put "prompts/signup/custom-text/en" --data "$(cat "$DIR/custom-text-signup.json")" < /dev/null
auth0 api put "prompts/signup-id/custom-text/en" --data "$(cat "$DIR/custom-text-signup-id.json")" < /dev/null

echo "7/8 Signup duplicate-email clarity (tenant flag)..."
auth0 api patch "tenants/settings" --data '{"flags":{"enable_public_signup_user_exists_error":true}}' < /dev/null

echo ""
echo "Optional: paste docs/auth0-branding/universal-login-head.html into"
echo "Auth0 Dashboard → Branding → Universal Login → Advanced → Custom Head"
echo "so login screens load Ditto CSS from https://ditto.jungle.win/shared/"
echo ""
echo "Verify custom domain: bash scripts/verify-auth0-issuer.sh"
echo "Done. Open the app and log out/in to see the branded screens."
