#!/usr/bin/env bash
set -euo pipefail

# Strict no-shortcut runner for discovery v3:
# - Full historical backfill from parquet
# - Gap fill to "now"
# - Snapshot + scoring publish
# - Promotion integrity gate
#
# Usage:
#   bash scripts/backfill/08_run_full_backfill_and_forward.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

echo "[08] Starting strict full-backfill + forward bootstrap run"
echo "[08] Repo root: ${REPO_ROOT}"

if [[ "${DISCOVERY_V3:-false}" != "true" ]]; then
  echo "[08] ERROR: DISCOVERY_V3 must be true for this run."
  echo "[08] Set DISCOVERY_V3=true and retry."
  exit 2
fi

if [[ -z "${POLYGON_RPC_URL:-}" ]]; then
  echo "[08] ERROR: POLYGON_RPC_URL is required for gap-fill/forward stage."
  exit 2
fi

echo "[08] 0/9 Preflight capacity check (full-backfill)"
npx tsx scripts/backfill/00_preflight_capacity.ts --mode full-backfill

echo "[08] 1/9 Fetch parquet source"
npx tsx scripts/backfill/00_fetch_parquet.ts

echo "[08] 2/9 Initialize DuckDB schema"
npx tsx scripts/backfill/01_init_duckdb.ts

echo "[08] 3/9 Load historical events from parquet"
npx tsx scripts/backfill/02_load_events.ts --mode parquet-direct

echo "[08] 4/9 Load market metadata"
npx tsx scripts/backfill/03_load_markets.ts

echo "[08] 5/9 Emit snapshots"
npx tsx scripts/backfill/04_emit_snapshots.ts

echo "[08] 6/9 Score and publish to SQLite read model"
npx tsx scripts/backfill/05_score_and_publish.ts

echo "[08] 7/9 Validation + promotion gate"
npx tsx scripts/backfill/06_validate.ts
npm run verify:promotion-gate

echo "[08] 8/9 Fill post-HF gap to now"
npx tsx scripts/backfill/07_goldsky_gap_fill.ts
npx tsx scripts/backfill/04_emit_snapshots.ts
npx tsx scripts/backfill/05_score_and_publish.ts
npm run verify:promotion-gate

echo "[08] 9/9 Done. Start forward listener worker:"
echo "      DISCOVERY_V3=true DISCOVERY_V3_RPC_POLL_ENABLED=true npm run start:discovery"
echo "[08] SUCCESS"
