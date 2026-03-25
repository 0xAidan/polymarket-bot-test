#!/usr/bin/env bash

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
DB_PATH="$DATA_DIR/copytrade.db"

mkdir -p "$BACKUP_DIR"

if [[ -f "$DB_PATH" ]]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/copytrade-$TIMESTAMP.db'"
  else
    cp "$DB_PATH" "$BACKUP_DIR/copytrade-$TIMESTAMP.db"
  fi
fi

if [[ -d "$DATA_DIR" ]]; then
  tar -czf "$BACKUP_DIR/data-$TIMESTAMP.tar.gz" -C "$APP_DIR" "$(basename "$DATA_DIR")"
fi

find "$BACKUP_DIR" -type f -mtime +"$RETENTION_DAYS" -delete
