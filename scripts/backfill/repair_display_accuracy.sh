#!/usr/bin/env bash
# Repair Discovery v3 display stats on a server with DuckDB + SQLite.
# Run from repo root on staging (e.g. /opt/polymarket-bot-staging).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "[repair] stopping discovery worker (if systemd unit exists)…"
if systemctl is-active --quiet polymarket-discovery-worker-staging 2>/dev/null; then
  sudo systemctl stop polymarket-discovery-worker-staging
fi

echo "[repair] delete outlier notionals (global)…"
npx tsx scripts/backfill/delete_outlier_notionals.ts

echo "[repair] dedup gap window…"
npx tsx scripts/backfill/dedup_gap_activity.ts

DUPE_GROUPS="$(npx tsx -e "
import { openDuckDB } from './src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from './src/discovery/v3/featureFlag.js';
const duck = await openDuckDB(getDuckDBPath());
const [r] = await duck.query('SELECT COUNT(*)::BIGINT AS c FROM (SELECT tx_hash,log_index FROM discovery_activity_v3 GROUP BY 1,2 HAVING COUNT(*)>1) t');
console.log(String(r?.c ?? 0));
await duck.close();
" 2>/dev/null || echo "unknown")"

if [[ "${DUPE_GROUPS}" != "0" && "${DUPE_GROUPS}" != "unknown" ]]; then
  echo "[repair] ${DUPE_GROUPS} duplicate groups remain — running global dedup…"
  npx tsx scripts/backfill/dedup_activity_global.ts
fi

echo "[repair] re-emit snapshots…"
npx tsx scripts/backfill/04_emit_snapshots.ts

echo "[repair] score + publish (skipping heavy pillars on small boxes)…"
SKIP_COMPOSITE=1 SKIP_BRIER=1 SKIP_NICHE=1 SKIP_COPY=1 SKIP_CLV=1 \
  npx tsx scripts/backfill/05_score_and_publish.ts

echo "[repair] promotion gate…"
npx tsx scripts/backfill/06_promotion_gate.ts

echo "[repair] PnL diagnostic golden section…"
npx tsx scripts/backfill/99_pnl_diagnostic.ts | tail -80

npm run build

if systemctl list-unit-files polymarket-app-staging.service >/dev/null 2>&1; then
  sudo systemctl restart polymarket-app-staging
fi
if systemctl list-unit-files polymarket-discovery-worker-staging.service >/dev/null 2>&1; then
  sudo systemctl start polymarket-discovery-worker-staging
fi

echo "[repair] staging API spot-check…"
npx tsx scripts/verify-staging-discovery-display.ts

echo "[repair] done."
