#!/usr/bin/env bash
# Archive Discovery v3 lab data before teardown.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/polymarket-bot}"
VOLUME="${DISCOVERY_LAB_ROOT:-/mnt/HC_Volume_105468668}"
STAGING_DATA="${STAGING_DATA_DIR:-$VOLUME/polymarket-staging-data}"
PROD_DATA="${PROD_DATA_DIR:-/opt/polymarket-bot/data}"
ARCHIVE_TAG="${ARCHIVE_TAG:-discovery-$(date -u +%Y-%m)}"
ARCHIVE_DIR="$APP_DIR/archive/$ARCHIVE_TAG"
REMOTE="${DISCOVERY_ARCHIVE_REMOTE:-}"
UPLOAD="${ARCHIVE_UPLOAD:-0}"
HASH_LARGE="${ARCHIVE_HASH_LARGE:-0}"

mkdir -p "$ARCHIVE_DIR"

echo "=== Discovery lab archive ($ARCHIVE_TAG) ==="

export_small_sqlite() {
  local db_path="$1"
  local label="$2"
  if [[ ! -f "$db_path" ]]; then return 0; fi
  if ! sqlite3 "$db_path" "SELECT 1 FROM sqlite_master WHERE name='discovery_wallet_scores_v3';" | grep -q 1; then
    return 0
  fi
  sqlite3 -json "$db_path" "SELECT * FROM discovery_wallet_scores_v3;" > "$ARCHIVE_DIR/scores-v3-${label}.json"
  echo "Exported scores-v3-${label}.json"
}

copy_json_artifact() {
  local src="$1"
  local dest_name="$2"
  if [[ -f "$src" ]]; then
    cp "$src" "$ARCHIVE_DIR/$dest_name"
    echo "Copied $dest_name"
  fi
}

export_small_sqlite "$STAGING_DATA/copytrade.db" "staging"
export_small_sqlite "$PROD_DATA/copytrade.db" "prod"
copy_json_artifact "$STAGING_DATA/discovery-v3-worker-state.json" "cursors-worker-state.json"
copy_json_artifact "$STAGING_DATA/07_gap_fill_cursor.json" "cursors-gap-fill.json"

if [[ -f "$APP_DIR/.env" ]]; then
  grep -E '^(DISCOVERY_|DUCKDB_|SORTED_PARQUET)' "$APP_DIR/.env" \
    | sed -E 's/(KEY|SECRET|TOKEN|PASS)=.*/\1=<redacted>/' \
    > "$ARCHIVE_DIR/env-discovery.snapshot" || true
fi

LARGE_FILES=(
  "$VOLUME/discovery_v3.duckdb"
  "$VOLUME/discovery_v3.duckdb.wal"
  "$VOLUME/backfill/users.parquet"
  "$VOLUME/trades.parquet"
)

node --input-type=module - "$ARCHIVE_DIR/manifest.json" "$ARCHIVE_TAG" "$REMOTE" "$HASH_LARGE" "${LARGE_FILES[@]}" <<'NODE'
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { writeFile } from 'fs/promises';

const [, , outPath, tag, remote, hashLarge, ...files] = process.argv;

const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });

const manifest = {
  archiveTag: tag,
  createdAt: new Date().toISOString(),
  remote: remote || null,
  files: [],
};

for (const filePath of files) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) continue;
    let digest = null;
    if (hashLarge === '1') {
      process.stderr.write(`Hashing ${filePath}...\n`);
      digest = await sha256File(filePath);
    }
    manifest.files.push({
      path: filePath,
      bytes: info.size,
      sha256: digest,
    });
  } catch {
    // missing file
  }
}

await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

if [[ "$UPLOAD" == "1" ]]; then
  if [[ -z "$REMOTE" ]]; then
    echo "ERROR: DISCOVERY_ARCHIVE_REMOTE required when ARCHIVE_UPLOAD=1"
    exit 1
  fi
  if ! command -v rclone >/dev/null 2>&1; then
    echo "ERROR: rclone not installed"
    exit 1
  fi
  REMOTE_PATH="$REMOTE/$ARCHIVE_TAG"
  for file_path in "${LARGE_FILES[@]}"; do
    [[ -f "$file_path" ]] && rclone copy "$file_path" "$REMOTE_PATH/" --progress
  done
  rclone copy "$ARCHIVE_DIR" "$REMOTE_PATH/manifest/" --progress
  echo "Upload complete — verify with: rclone ls $REMOTE_PATH"
else
  echo "Export-only mode (set ARCHIVE_UPLOAD=1 and DISCOVERY_ARCHIVE_REMOTE to upload)."
fi

echo "=== Archive artifacts ==="
ls -lah "$ARCHIVE_DIR"
