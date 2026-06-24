#!/usr/bin/env bash

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_FULL_DATA="${BACKUP_FULL_DATA:-0}"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
DB_PATH="$DATA_DIR/copytrade.db"

mkdir -p "$BACKUP_DIR"

disk_used_percent() {
  df -P "$DATA_DIR" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}' || echo "0"
}

USED_PCT="$(disk_used_percent)"
DISCOVERY_V3="${DISCOVERY_V3:-false}"
if [[ -f "$APP_DIR/.env" ]]; then
  DISCOVERY_V3="$(grep -E '^DISCOVERY_V3=' "$APP_DIR/.env" | tail -1 | cut -d= -f2- || echo false)"
fi

if [[ "$DISCOVERY_V3" != "true" && "$USED_PCT" -ge 80 ]]; then
  echo "Skipping backup: DISCOVERY_V3=false and disk ${USED_PCT}% used (threshold 80%)"
  find "$BACKUP_DIR" -type f -mtime +"$RETENTION_DAYS" -delete
  exit 0
fi

if [[ -f "$DB_PATH" ]]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/copytrade-$TIMESTAMP.db'"
  else
    cp "$DB_PATH" "$BACKUP_DIR/copytrade-$TIMESTAMP.db"
  fi
fi

if [[ "$BACKUP_FULL_DATA" == "1" && -d "$DATA_DIR" ]]; then
  tar -czf "$BACKUP_DIR/data-$TIMESTAMP.tar.gz" -C "$APP_DIR" "$(basename "$DATA_DIR")"
fi

find "$BACKUP_DIR" -type f -mtime +"$RETENTION_DAYS" -delete
