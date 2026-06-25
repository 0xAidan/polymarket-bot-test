# Discovery v3 Full Backfill + Forward Listening Runbook

**Date:** 2026-06-01  
**Purpose:** Execute discovery v3 end-to-end with no partial shortcuts: full historical backfill, then continuous forward listening.

---

## 1) Server sizing (hard requirements)

Two profiles are supported:

| Profile | CPU | RAM | Free disk | Use case |
|---|---:|---:|---:|---|
| Forward-only | >= 4 cores | >= 12 GiB (16 GiB recommended) | >= 100 GiB | Hourly `eth_getLogs` + hourly refresh |
| Full backfill + forward | >= 8 cores | >= 24 GiB (32 GiB recommended) | >= 302 GiB (400 GiB recommended) | Scripts `00` to `07` + ongoing live ingest |

Full backfill disk budget is based on:
- `users.parquet` ~51.5 GiB
- DuckDB working set (activity + snapshots + score staging) ~90 GiB
- DuckDB temp spill headroom for heavy stages ~120 GiB
- Safety margin ~40 GiB

> This current workspace machine has ~20 GiB free disk, so it is **not eligible** for full backfill.

### Current host check (your Hetzner setup)

From your screenshots:
- Server family: `CCX33` in HEL1
- Attached volume: `300 GB`

Strict outcome against this runbook:
- **CPU/RAM:** likely sufficient for full backfill (`CCX33` class)
- **Disk:** **not sufficient** for no-shortcut full backfill because the minimum safety floor is `>=302 GiB free` on the filesystem used by `DATA_DIR`, and a 300 GB volume is below that once converted to GiB and after filesystem overhead.

Required correction for full backfill:
- Increase attached volume to **>=400 GB** (recommended).
- Use **500 GB** if you want operational headroom for retries, extra snapshots, and temporary spill growth.

### Current provider price anchors (Hetzner, excl. VAT)

Reference rates from Hetzner price-adjustment doc (effective 2026-04-01):
- `CCX33` (Germany/Finland): **EUR 62.49/mo**
- Volumes: **EUR 0.0572 per GB per month**
- Source: `https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/`

Derived monthly infra totals:
- `CCX33 + 300 GB volume`: `62.49 + (300 * 0.0572) = EUR 79.65/mo` (`EUR 2.66/day`)
- `CCX33 + 400 GB volume`: `62.49 + (400 * 0.0572) = EUR 85.37/mo` (`EUR 2.85/day`)
- `CCX33 + 500 GB volume`: `62.49 + (500 * 0.0572) = EUR 91.09/mo` (`EUR 3.04/day`)

---

## 2) Deterministic preflight and cost model

Run preflight before any migration:

```bash
npm run discovery:preflight
```

If you only want forward listening on a smaller host:

```bash
npm run discovery:preflight:forward
```

To get exact dollar math for your chosen provider, supply pricing inputs:

```bash
COST_SERVER_USD_MONTH=<provider_vm_monthly_cost> \
COST_STORAGE_USD_MONTH=<attached_storage_monthly_cost> \
COST_RPC_USD_PER_1M_CALLS=<provider_rpc_price_per_1m> \
EST_RPC_CALLS_PER_DAY=<observed_calls_from_provider_dashboard> \
npm run discovery:preflight
```

This produces deterministic monthly/day totals from your real provider numbers.

---

## 3) Full backfill execution order (strict)

On the correctly sized server:

```bash
npx tsx scripts/backfill/00_preflight_capacity.ts --mode full-backfill
npx tsx scripts/backfill/00_fetch_parquet.ts
npx tsx scripts/backfill/01_init_duckdb.ts
npx tsx scripts/backfill/02_load_events.ts --mode parquet-direct
npx tsx scripts/backfill/03_load_markets.ts
npx tsx scripts/backfill/04_emit_snapshots.ts
npx tsx scripts/backfill/05_score_and_publish.ts
npx tsx scripts/backfill/06_validate.ts
npm run verify:promotion-gate
```

Single strict runner (same sequence, no skipped stages):

```bash
bash scripts/backfill/08_run_full_backfill_and_forward.sh
```

Then fill post-HF historical gap to "now":

```bash
npx tsx scripts/backfill/07_goldsky_gap_fill.ts
npx tsx scripts/backfill/04_emit_snapshots.ts
npx tsx scripts/backfill/05_score_and_publish.ts
npm run verify:promotion-gate
```

---

## 4) Forward listening (continuous)

Required env:

```bash
DISCOVERY_V3=true
DISCOVERY_V3_RPC_POLL_ENABLED=true
DISCOVERY_V3_RPC_POLL_INTERVAL_MS=3600000
DISCOVERY_V3_GOLDSKY_ENABLED=false
POLYGON_RPC_URL=<reliable_polygon_rpc_url>
```

Optional auth headers for providers that require key headers:

```bash
POLYGON_RPC_HEADER_NAME=x-api-key
POLYGON_RPC_HEADER_VALUE=<your_rpc_api_key>
```

Start the discovery worker owner process:

```bash
npm run start:discovery
```

Health checks:
- `GET /api/discovery/v3/health`
- Worker logs contain `[v3-rpc] blocks=... logs=... inserted=... rpc_calls_est=...`

---

## 5) Acceptance gates (must all pass)

1. Preflight PASS for selected mode
2. No duplicate `(tx_hash, log_index)` groups
3. No sentinel corruption rows (`proxy_wallet='duckdb'`)
4. Non-empty snapshots and all three tiers in SQLite
5. Forward cursor age remains within expected poll lag
6. Soak reports stable for 24-48 hours

Commands:

```bash
npm run verify:promotion-gate
npm run verify:soak
```

---

## 6) No-shortcut policy

- Do not claim full backfill complete if `00_fetch_parquet` was skipped.
- Do not claim forward listening healthy without `[v3-rpc]` insert activity and cursor movement.
- Do not promote if promotion gate fails, even if UI appears populated.
- Do not estimate costs from assumptions only; use provider invoice/rate card values in preflight env vars.
