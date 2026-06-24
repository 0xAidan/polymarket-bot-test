#!/usr/bin/env bash
# Rebuild a bloated/corrupt staging SQLite DB while preserving app tables.
set -euo pipefail

STAGING_DATA="${STAGING_DATA_DIR:-/mnt/HC_Volume_105468668/polymarket-staging-data}"
CORRUPT="$STAGING_DATA/copytrade.db"
NEW="$STAGING_DATA/copytrade-rebuilt.db"
SCHEMA_SOURCE="${SCHEMA_SOURCE:-/opt/polymarket-bot/data/copytrade.db}"
DUMP_SQL="/tmp/staging-dump-$$.sql"

TABLES="schema_version tracked_wallets bot_config executed_positions app_tenants app_users app_tenant_memberships app_auth_audit_log allocation_policy_states allocation_policy_transitions allocation_policy_config pipeline_cursor discovery_wallet_scores_v3"

echo "Stopping staging app..."
sudo systemctl stop polymarket-app-staging.service 2>/dev/null || true

rm -f "$DUMP_SQL" "$NEW"
for t in $TABLES; do
  sqlite3 "$CORRUPT" ".dump $t" 2>/dev/null >> "$DUMP_SQL" || echo "skip dump $t"
done

cp "$SCHEMA_SOURCE" "$NEW"
sqlite3 "$NEW" "
  DELETE FROM tracked_wallets;
  DELETE FROM executed_positions;
  DELETE FROM app_users;
  DELETE FROM app_tenants;
  DELETE FROM app_tenant_memberships;
  DELETE FROM app_auth_audit_log;
  DELETE FROM bot_config;
"
sqlite3 "$NEW" < "$DUMP_SQL" || true
sqlite3 "$NEW" "VACUUM;"

mv "$CORRUPT" "$STAGING_DATA/copytrade.db.corrupt-$(date +%Y%m%d%H%M%S)"
mv "$NEW" "$CORRUPT"
rm -f "$DUMP_SQL"

echo "Rebuilt staging DB: $(ls -lh "$CORRUPT")"
sudo systemctl start polymarket-app-staging.service 2>/dev/null || true
