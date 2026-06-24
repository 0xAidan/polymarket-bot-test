#!/usr/bin/env bash
# Remove Discovery lab files when Discovery is disabled.
# Safe for hourly cron — never touches keystores or non-discovery app data.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/polymarket-bot}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
VOLUME="${DISCOVERY_LAB_ROOT:-/mnt/HC_Volume_105468668}"

load_discovery_flags() {
  if [[ -f "$APP_DIR/.env" ]]; then
  # shellcheck disable=SC1090
    set -a
    source <(grep -E '^(DISCOVERY_ENABLED|DISCOVERY_V3)=' "$APP_DIR/.env" || true)
    set +a
  fi
}

load_discovery_flags

if [[ "${DISCOVERY_V3:-false}" == "true" || "${DISCOVERY_ENABLED:-false}" == "true" ]]; then
  echo "Discovery enabled — skipping lab cleanup"
  exit 0
fi

echo "=== Discovery lab cleanup $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="

remove_path() {
  local target="$1"
  if [[ -e "$target" ]]; then
    local size
    size=$(du -sh "$target" 2>/dev/null | awk '{print $1}')
    echo "Removing $target ($size)"
    rm -rf "$target"
  fi
}

remove_path "$DATA_DIR/discovery_v3.duckdb"
remove_path "$DATA_DIR/discovery_v3.duckdb-wal"
remove_path "$DATA_DIR/discovery_v3.duckdb-shm"
remove_path "$VOLUME/discovery_v3.duckdb"
remove_path "$VOLUME/discovery_v3.duckdb.wal"
remove_path "$VOLUME/discovery_v3.duckdb.tmp"
remove_path "$VOLUME/duckdb_tmp"
remove_path "$VOLUME/bucket_parquets"
remove_path "$VOLUME/backfill"
remove_path "$VOLUME/repo-v3"
remove_path "$VOLUME/gap_api_shards"
remove_path "$VOLUME/trades.parquet"

if [[ -f "$APP_DIR/dist/index.js" ]]; then
  node --input-type=module -e "
    import { initDatabase, closeDatabase } from './dist/database.js';
    import { countDiscoverySqliteRows, purgeAllDiscoveryDataIncludingV3 } from './dist/dataRetention.js';
    import { vacuumDatabaseIfDegraded, vacuumDatabaseIfDiskPressure } from './dist/database.js';
    await initDatabase();
    const rows = countDiscoverySqliteRows();
    if (rows > 0) {
      const removed = purgeAllDiscoveryDataIncludingV3();
      console.log('Purged', removed, 'Discovery SQLite rows');
      vacuumDatabaseIfDegraded() || vacuumDatabaseIfDiskPressure();
    }
    closeDatabase();
  " || echo "SQLite discovery purge skipped (build may be stale)"
fi

echo "=== Discovery lab cleanup done ==="
