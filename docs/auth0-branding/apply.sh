#!/usr/bin/env bash
# Applies Ditto branding to the active Auth0 tenant.
# Prereq: `auth0 login` against the tenant that hosts the Ditto application.
# Usage:  bash docs/auth0-branding/apply.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LOGO_URL="https://raw.githubusercontent.com/0xAidan/polymarket-bot-test/3089100063ebd1879319d1cd8c7ba07a3d833686/public/shared/logo-gold.png"

echo "1/5 Tenant friendly name + logo..."
auth0 api patch "tenants/settings" --data "{\"friendly_name\":\"Ditto\",\"picture_url\":\"$LOGO_URL\"}" < /dev/null

echo "2/5 Classic branding colors + logo..."
auth0 api patch "branding" --data "{\"colors\":{\"primary\":\"#E5B80B\",\"page_background\":\"#161721\"},\"logo_url\":\"$LOGO_URL\"}" < /dev/null

echo "3/5 Universal Login theme (create or update)..."
THEME_ID=$(auth0 api get "branding/themes/default" < /dev/null 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).themeId||'')}catch{console.log('')}})")
if [ -n "$THEME_ID" ]; then
  auth0 api patch "branding/themes/$THEME_ID" --data "$(cat "$DIR/theme.json")" < /dev/null
else
  auth0 api post "branding/themes" --data "$(cat "$DIR/theme.json")" < /dev/null
fi

echo "4/5 Login screen custom text..."
auth0 api put "prompts/login/custom-text/en" --data "$(cat "$DIR/custom-text-login.json")" < /dev/null

echo "5/5 Signup screen custom text..."
auth0 api put "prompts/signup/custom-text/en" --data "$(cat "$DIR/custom-text-signup.json")" < /dev/null

echo "Done. Open the app and log out/in to see the branded screens."
