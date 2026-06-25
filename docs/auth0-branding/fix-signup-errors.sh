#!/usr/bin/env bash
# Fix signup showing a generic "Something went wrong" when the email is already registered.
# Prereq: auth0 login (Management API scopes for prompts + tenant settings + users).
#
# Usage:
#   bash docs/auth0-branding/fix-signup-errors.sh
#   bash docs/auth0-branding/fix-signup-errors.sh --delete-user test@test.com
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DELETE_EMAIL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --delete-user)
      DELETE_EMAIL="${2:-}"
      if [ -z "$DELETE_EMAIL" ]; then
        echo "Usage: $0 --delete-user <email>" >&2
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

echo "Applying signup custom text (duplicate-email friendly messages)..."
auth0 api put "prompts/signup/custom-text/en" --data "$(cat "$DIR/custom-text-signup.json")" < /dev/null

echo "Enabling specific duplicate-email errors on signup (enable_public_signup_user_exists_error)..."
auth0 api patch "tenants/settings" --data '{"flags":{"enable_public_signup_user_exists_error":true}}' < /dev/null

if [ -n "$DELETE_EMAIL" ]; then
  echo "Looking up Auth0 user: $DELETE_EMAIL"
  USER_ID=$(auth0 users search --query "email:\"$DELETE_EMAIL\"" --json < /dev/null 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const rows=JSON.parse(d); console.log(rows[0]?.user_id||'')}catch{console.log('')}})")
  if [ -z "$USER_ID" ]; then
    echo "No Auth0 user found for $DELETE_EMAIL (nothing to delete)."
  else
    echo "Deleting Auth0 user $USER_ID ($DELETE_EMAIL)..."
    auth0 users delete "$USER_ID" --force < /dev/null
    echo "Deleted."
  fi
fi

echo "Signup error fix applied. Try signing up again in an incognito window."
