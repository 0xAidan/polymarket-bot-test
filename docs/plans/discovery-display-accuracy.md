# Discovery v3 — Display accuracy (harvest-first)

## What users reported

On **staging** (`https://staging.ditto.jungle.win/discovery-v3/`), top wallet cards showed impossible stats vs Polymarket profiles (e.g. **$77M PnL** vs dvisik **-$646**). Addresses matched Polymarket; the bug was **corrupted DuckDB inputs**, not the cash-flow PnL formula.

## Root causes

1. **Duplicate rows** in `discovery_activity_v3` from May 2026 gap-fill (same `tx_hash` + `log_index` inserted multiple times).
2. **Inflated `usd_notional`** on some gap rows (outliers above realistic trade size).
3. **Semantic mismatch**: internal `trade_count` counts OrderFilled events; Polymarket UI shows **Predictions** from `GET /traded`.

Volume and lifetime PnL on cards are **sums over activity → snapshots**. Garbage in → garbage out.

## Architecture (source of truth)

```
HuggingFace parquet + Goldsky gap-fill
        ↓ dedupe on load (buildSortedParquetToActivityDedupedSql)
        ↓ batch dedupe + notional cap (goldskyListener)
        ↓ optional: dedup_gap_activity.ts / dedup_activity_global.ts
discovery_activity_v3 (DuckDB)
        ↓ buildSnapshotEmitSql() — cash-flow PnL
discovery_feature_snapshots_v3
        ↓ 05_score_and_publish.ts
discovery_wallet_scores_v3 (SQLite)  →  GET /api/discovery/v3/tier/*
        ↓ publish-time only: /traded + gamma profile name
public/discovery-v3/app.js
```

**Not used on read path:** live Polymarket API overlay for PnL/volume (removed `polymarketDisplayStats.ts`).

## Repair pipeline (staging)

**One command** (from repo root on the staging server):

```bash
bash scripts/backfill/repair_display_accuracy.sh
```

Manual steps (same order):

```bash
sudo systemctl stop polymarket-discovery-worker-staging
cd /opt/polymarket-bot-staging

# 1. Remove gap duplicates + cap outlier notionals
npx tsx scripts/backfill/dedup_gap_activity.ts
# Or full-table repair if dupes exist outside gap window:
# npx tsx scripts/backfill/dedup_activity_global.ts

# 2. Re-emit snapshots and publish scores (05 now excludes corrupt cards)
npx tsx scripts/backfill/04_emit_snapshots.ts
SKIP_COMPOSITE=1 SKIP_BRIER=1 SKIP_NICHE=1 SKIP_COPY=1 SKIP_CLV=1 \
  npx tsx scripts/backfill/05_score_and_publish.ts

# 3. Gates
npx tsx scripts/backfill/06_promotion_gate.ts
npx tsx scripts/backfill/99_pnl_diagnostic.ts

npm run build && sudo systemctl restart polymarket-app-staging
npx tsx scripts/verify-staging-discovery-display.ts
```

**Publish-time guard (code):** `05_score_and_publish.ts` calls `filterScoresForPublish()` so wallets with million-dollar PnL / fillCount ≫ predictions are not written to SQLite even before DuckDB repair completes.

Diagnostics:

```bash
npx tsx scripts/backfill/99_pnl_diagnostic.ts   # includes golden wallets §3b
```

## Golden wallets (acceptance)

| Label | Proxy | Profile | Expected |
|-------|-------|---------|----------|
| Amber Falcon | `0x2055b6a642839e86644d381c619aabc0afec1d9d` | dvisik | PnL ≈ **-$646**, predictions **7114** |
| Amber Hare | `0xfedc381bf3fb5d20433bb4a0216b15dbbc5c6398` | c000OLI0003 | PnL ≈ **+$83,535**, predictions **115** |

`06_promotion_gate.ts` calls `validateWalletPromotionGate()` — fails if derived PnL is **>10× or <0.1×** reference, **>$100k** off for small profiles, or volume **>>** API TRADE sum.

## API contract

- `volumeTotal`, `realizedPnl`, `fillCount` — pipeline only.
- `predictionsCount` — from Polymarket `/traded` at **publish** time (05); UI label **Predictions**.
- `profileUrl` — `https://polymarket.com/@{proxy_wallet}` (same address on card).
- `profileName` — optional Gamma subtitle.

## Verification

```bash
curl -sS 'https://staging.ditto.jungle.win/api/discovery/v3/tier/alpha?limit=5' \
  | jq '.data[] | {alias,address,realizedPnl,volumeTotal,predictionsCount,fillCount,profileUrl}'
```

Expect no millions for golden wallets after repair. Compare **View on Polymarket** on each card.
