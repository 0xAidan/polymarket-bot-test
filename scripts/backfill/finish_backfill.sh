#!/usr/bin/env bash
#
# Finish the Discovery v3 backfill on a Hetzner-class machine.
# Assumes:
#   - Phase A (02a_sort_bucket.ts) has produced 64 sorted bucket parquets in
#     $SORTED_PARQUET_DIR (sorted_events_bucket_NNNN.parquet).
#   - The DuckDB file lives at $DUCKDB_PATH (or the default path resolved by
#     src/discovery/v3/featureFlag.ts getDuckDBPath).
#
# Phase B (bucket-local dedup path — final v3 fix 2026-04-22 rev2):
#   1. For each bucket parquet, run 02c_merge_one_bucket.ts in a fresh node
#      process. Does an INSERT that dedups inside the bucket (valid because
#      02a bucketizes on hash(tx_hash) so duplicate keys all live in ONE
#      bucket). Target table has NO indexes during load. Deletes the parquet
#      on success.
#   2. Once all 64 buckets are loaded, run 02d_dedup_and_index.ts once. This
#      scans for duplicate keys (defensive) and CHECKPOINTs. It does NOT
#      create ART indexes — DuckDB 1.4.x requires the index to fit in
#      memory (~100GB+ for 800M rows) which the Hetzner 8GB box cannot
#      provide. See src/discovery/v3/duckdbSchema.ts for rationale.
#   3. Run 03_load_markets.ts, 04_emit_snapshots.ts, 05_score_and_publish.ts,
#      06_validate.ts in sequence.
#
# Env vars honoured (match the existing runbook):
#   DUCKDB_MEMORY_LIMIT_GB, DUCKDB_THREADS, DUCKDB_TEMP_DIR,
#   DUCKDB_MAX_TEMP_DIR_GB, SORTED_PARQUET_DIR

set -euo pipefail

SORTED_PARQUET_DIR="${SORTED_PARQUET_DIR:-/mnt/HC_Volume_105468668/bucket_parquets}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "=============================================="
echo "=== finish_backfill.sh starting at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "=============================================="
echo "=== git HEAD ==="
(cd "$REPO_ROOT" && git log --oneline -1 2>/dev/null || echo "not a git repo")
echo "=== disk ==="
df -h "$SORTED_PARQUET_DIR" 2>/dev/null | tail -1 || true
cd "$REPO_ROOT"

mkdir -p "$SORTED_PARQUET_DIR"

echo "=== bucket parquets ==="
# Robust bucket count (no pipefail bleed-through; `find` handles empty dirs cleanly).
BUCKET_COUNT=$(find "$SORTED_PARQUET_DIR" -maxdepth 1 -name 'sorted_events_bucket_*.parquet' -printf '.' 2>/dev/null | wc -c)
BUCKET_COUNT=${BUCKET_COUNT:-0}
echo "found $BUCKET_COUNT bucket parquets"

TOTAL_BUCKETS="${DUCKDB_SORT_BUCKETS:-64}"

# --- 02a: produce sorted bucket parquets if missing ---------------------
if [ "$BUCKET_COUNT" -lt "$TOTAL_BUCKETS" ]; then
  echo
  echo "=============================================="
  echo "=== 02a: sort $TOTAL_BUCKETS buckets from users.parquet ==="
  echo "=============================================="
  for b in $(seq 0 $((TOTAL_BUCKETS - 1))); do
    BNAME=$(printf 'sorted_events_bucket_%04d.parquet' "$b")
    OUT="$SORTED_PARQUET_DIR/$BNAME"
    if [ -s "$OUT" ]; then
      echo "--- [02a] bucket $((b+1))/$TOTAL_BUCKETS already exists ($(du -h "$OUT" | cut -f1)), skipping ---"
      continue
    fi
    echo "--- [02a] bucket $((b+1))/$TOTAL_BUCKETS -> $OUT ---"
    npx tsx scripts/backfill/02a_sort_bucket.ts --bucket "$b" --total "$TOTAL_BUCKETS" --out "$OUT" || {
      echo "ERROR: 02a bucket $b failed. Aborting."
      exit 1
    }
    df -h "$SORTED_PARQUET_DIR" 2>/dev/null | tail -1 || true
  done
  # Re-count
  BUCKET_COUNT=$(find "$SORTED_PARQUET_DIR" -maxdepth 1 -name 'sorted_events_bucket_*.parquet' -printf '.' 2>/dev/null | wc -c)
  BUCKET_COUNT=${BUCKET_COUNT:-0}
  echo "After 02a: $BUCKET_COUNT bucket parquets present."
fi

if [ "$BUCKET_COUNT" -lt 1 ]; then
  echo "ERROR: no bucket parquets in $SORTED_PARQUET_DIR after 02a; aborting."
  exit 1
fi

echo
echo "=============================================="
echo "=== 02c: dedup-insert each bucket           ==="
echo "=============================================="
for f in "$SORTED_PARQUET_DIR"/sorted_events_bucket_*.parquet; do
  [ -e "$f" ] || continue
  b=$(basename "$f" | sed -E 's/sorted_events_bucket_([0-9]+)\.parquet/\1/' | sed 's/^0*//')
  [ -z "$b" ] && b=0
  size=$(du -h "$f" | cut -f1)
  echo "--- [02c] dedup-inserting bucket $b (size $size) ---"
  npx tsx scripts/backfill/02c_merge_one_bucket.ts --bucket "$b" --path "$f" || {
    echo "ERROR: 02c bucket $b failed. Remaining buckets not loaded."
    exit 1
  }
  df -h "$SORTED_PARQUET_DIR" 2>/dev/null | tail -1 || true
done

echo
echo "=============================================="
echo "=== 02d: verify + CHECKPOINT (no index build) ==="
echo "=============================================="
npx tsx scripts/backfill/02d_dedup_and_index.ts

echo
echo "=============================================="
echo "=== 03..06: markets, snapshots, score, val  ==="
echo "=============================================="
npx tsx scripts/backfill/03_load_markets.ts
npx tsx scripts/backfill/04_emit_snapshots.ts
npx tsx scripts/backfill/05_score_and_publish.ts
npx tsx scripts/backfill/06_validate.ts

echo
echo "=============================================="
echo "=== ALL DONE at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "=============================================="
