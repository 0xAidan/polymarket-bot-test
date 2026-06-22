#!/usr/bin/env bash
# Automated disk maintenance for Ditto production hosts.
# Safe to run from cron/systemd timer; also invoked at app startup.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/polymarket-bot}"
cd "$APP_DIR"

echo "=== Disk maintenance $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="
df -h /

# Journal cap (requires sudo)
if command -v journalctl >/dev/null 2>&1; then
  sudo journalctl --vacuum-size=200M 2>/dev/null || true
fi

# Stale deploy backups on root (never touch active data/)
for dir in "$APP_DIR"/data.backup-* "$APP_DIR"/data.bak-on-root "$APP_DIR"/data.local-backup-*; do
  if [[ -e "$dir" && "$dir" != "$APP_DIR/data" ]]; then
    echo "Removing stale backup: $dir"
    rm -rf "$dir"
  fi
done

if [[ -d /opt/polymarket-bot-staging ]]; then
  STAGING_DIR="/opt/polymarket-bot-staging"
  for dir in "$STAGING_DIR"/data.backup-* "$STAGING_DIR"/data.bak-on-root "$STAGING_DIR"/data.local-backup-*; do
    if [[ -e "$dir" && "$dir" != "$STAGING_DIR/data" ]]; then
      echo "Removing stale staging backup: $dir"
      rm -rf "$dir"
    fi
  done
fi

rm -f "$APP_DIR"/.env.backup* 2>/dev/null || true

# App-level maintenance (WAL checkpoint, retention purge, vacuum under pressure)
if [[ -f "$APP_DIR/dist/index.js" ]]; then
  node --input-type=module -e "
    import { initDatabase, closeDatabase } from './dist/database.js';
    import { runDiskMaintenance } from './dist/diskMaintenance.js';
    await initDatabase();
    await runDiskMaintenance('$APP_DIR');
    closeDatabase();
  " || echo "In-app disk maintenance skipped (build may be stale)"
fi

echo "=== After ==="
df -h /
