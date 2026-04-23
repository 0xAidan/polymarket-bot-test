#!/usr/bin/env bash
#
# Finish the Discovery v3 backfill on a Hetzner-class machine.
# Assumes:
#   - Phase A (02a_sort_bucket.ts) has produced 64 sorted bucket parquets in
#     $SORTED_PARQUET_DIR (sorted_events_bucket_NNNN.parquet).
#   - The DuckDB file lives at $DUCKDB_PATH (or the default path resolved by
#     src/discovery/v3/featureFlag.ts getDuckDBPath).
#
# Phase B (no-index-during-load path — final v3 fix 2026-04-22):
#   1. For each bucket parquet, run 02c_merge_one_bucket.ts in a fresh node
#      process. Does a RAW INSERT (no GROUP BY, no dedup, no indexes) and
#      deletes the parquet on success.
#   2. Once all 64 buckets are loaded, run 02d_dedup_and_index.ts once. This
#      CTAS-dedupes into a new table, swaps it in, and recreates the unique +
#      aux indexes.
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
echo "=== bucket parquets ==="
BUCKET_COUNT=$(ls "$SORTED_PARQUET_DIR"/sorted_events_bucket_*.parquet 2>/dev/null | wc -l || echo 0)
echo "found $BUCKET_COUNT bucket parquets"
if [ "$BUCKET_COUNT" -lt 1 ]; then
  echo "ERROR: no bucket parquets in $SORTED_PARQUET_DIR; run 02a_sort_bucket.ts first."
  exit 1
fi

cd "$REPO_ROOT"

echo
echo "=============================================="
echo "=== 02c: RAW-insert each bucket (no dedup)  ==="
echo "=============================================="
for f in "$SORTED_PARQUET_DIR"/sorted_events_bucket_*.parquet; do
  [ -e "$f" ] || continue
  b=$(basename "$f" | sed -E 's/sorted_events_bucket_([0-9]+)\.parquet/\1/' | sed 's/^0*//')
  [ -z "$b" ] && b=0
  size=$(du -h "$f" | cut -f1)
  echo "--- [02c] RAW-inserting bucket $b (size $size) ---"
  npx tsx scripts/backfill/02c_merge_one_bucket.ts --bucket "$b" --path "$f" || {
    echo "ERROR: 02c bucket $b failed. Remaining buckets not loaded."
    exit 1
  }
  df -h "$SORTED_PARQUET_DIR" 2>/dev/null | tail -1 || true
done

echo
echo "=============================================="
echo "=== 02d: CTAS dedup + rebuild indexes       ==="
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
