# Discovery v3 — Operations Runbook

Discovery v3 is the full rebuild of wallet discovery: a DuckDB-backed analytical
pipeline, three-tier scoring (alpha / whale / specialist), live Goldsky ingest,
and a new UI. All v3 code is additive and gated on `DISCOVERY_V3=true`.

## Quickstart

```bash
export DISCOVERY_V3=true
export DUCKDB_PATH=./data/discovery_v3.duckdb
npm run build
npm start
```

With the flag off the v3 API returns 404, the UI route returns 404, and the
worker bootstrap is a no-op — the rest of the bot is unaffected.

## Runtime ownership (critical)

Discovery v3 live ingest is bootstrapped by `src/discovery/discoveryWorker.ts`.

- Use `npm run start:discovery` (dev) or `npm run start:prod:discovery` (prod).
- Do **not** rely on `APP_RUNTIME=discovery-worker` through `src/index.ts` for v3.
  That path starts the legacy discovery runtime but does not start the v3
  Goldsky + refresh integration.

## Pipeline

| Stage | Script | Output |
|---|---|---|
| 1. Fetch parquet | `scripts/backfill/00_fetch_parquet.ts` | markets.parquet (users.parquet requires 70GB free) |
| 2. Init DuckDB | `scripts/backfill/01_init_duckdb.ts` | DDL applied |
| 3. Load events | `scripts/backfill/02_load_events.ts --limit N --source-url URL` | `discovery_activity_v3` |
| 4. Load markets | `scripts/backfill/03_load_markets.ts` | `markets_v3` |
| 5. Emit snapshots | `scripts/backfill/04_emit_snapshots.ts` | `discovery_feature_snapshots_v3` |
| 6. Score + publish | `scripts/backfill/05_score_and_publish.ts` | `discovery_wallet_scores_v3` (SQLite) |
| 7. Validate | `scripts/backfill/06_validate.ts` | Spot-checks 20 wallets against data-api |

All steps are idempotent. Re-running any stage produces byte-identical output.

## Live ingest

The worker bootstrap (`src/discovery/v3/workerIntegration.ts`) polls Goldsky
every 5 minutes (`goldskyIntervalMs`) and refreshes tier rankings every hour
(`refreshIntervalMs`). Duplicates are absorbed by the DuckDB `UNIQUE(tx_hash,
log_index)` index.

## Flags

| Variable | Default | Purpose |
|---|---|---|
| `DISCOVERY_V3` | `false` | Master switch. When off, v3 is invisible. |
| `DUCKDB_PATH` | `./data/discovery_v3.duckdb` | DuckDB file location. |
| `DISCOVERY_V3_LEGACY_WRITES` | unset | During cutover, allow legacy discovery writes alongside v3. |
| `DISCOVERY_V3_HISTORICAL_BACKFILL_SOURCE` | `huggingface:SII-WANGZJ/Polymarket_data/users.parquet` | Coverage contract source label returned by v3 API health/cutover endpoints. |
| `DISCOVERY_V3_HISTORICAL_COVERAGE_MAX_TS` | `1772668800` | Coverage contract boundary (unix ts) used to communicate known historical completeness limits. |
| `DISCOVERY_V3_KNOWN_GAP_POLICY` | built-in text | Coverage policy returned by v3 API health/cutover endpoints. |

## Cutover sequence (Phase 4)

1. Deploy with `DISCOVERY_V3=false` — no behavior change.
2. Backfill: run scripts 00–06. Inspect `/api/discovery/v3/cutover-status`.
3. Flip `DISCOVERY_V3=true`. Worker starts polling Goldsky; UI at
   `/discovery-v3/` serves tiered view.
4. Once confidence is high, remove legacy references in a follow-up PR.

## Endpoints (all gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/discovery/v3/tier/:tier` | Top wallets in tier (alpha/whale/specialist) |
| GET | `/api/discovery/v3/wallet/:address` | Tier memberships + score for one wallet |
| GET | `/api/discovery/v3/compare?addresses=a,b,c,d` | Side-by-side (max 4) |
| GET | `/api/discovery/v3/health` | Flag state, tier counts, cursor positions, and coverage contract metadata |
| POST | `/api/discovery/v3/watchlist` | Add wallet to watchlist |
| DELETE | `/api/discovery/v3/watchlist/:addr` | Remove |
| POST | `/api/discovery/v3/dismiss` | Suppress wallet for a duration |
| POST | `/api/discovery/v3/track` | Attach copy-trade assignment |
| GET | `/api/discovery/v3/cutover-status` | Readiness: flag, total rows, tier counts, cursors, and coverage contract metadata |

## Promotion gate (integrity vs coverage)

Use two validators:

1. `scripts/backfill/06_validate.ts` — coverage-aware API comparison (informational under known-gap policy).
2. `scripts/backfill/06_promotion_gate.ts` — hard block on integrity failures only.

Recommended promotion sequence:

```bash
npx tsx scripts/backfill/06_validate.ts
npm run verify:promotion-gate
```

`verify:promotion-gate` blocks promotion when any of these fail:

- duplicate `(tx_hash, log_index)` groups present,
- sentinel corruption rows (`proxy_wallet='duckdb'`) present,
- empty snapshot table,
- missing/empty tier rows in SQLite read model.

Coverage mismatches in API comparisons are logged as warnings and interpreted
under the explicit coverage contract instead of triggering blind reruns.

## Staging soak checklist (24-48h)

Run this periodically (for example every 30-60 minutes) during soak:

```bash
npm run verify:soak
```

Pass conditions during soak:

- `duckdb.snapshot_rows > 0` and `duckdb.snapshot_wallets > 0`
- all 3 tiers remain non-empty in `sqlite.tiers`
- `cursor.cursor_age_seconds` remains within expected polling lag
- `sqlite.score_age_seconds` remains within expected refresh lag

If any metric stalls, inspect the discovery worker process first.

## Production promotion rule

Promote only the same commit hash that passed staging soak.

Before promotion:

```bash
npm run verify:promotion-gate
npm run verify:soak
./scripts/verify-release-commit.sh <staging-soaked-commit-sha>
```

Also keep issue `#103` explicitly open as the known historical coverage follow-up.

## Troubleshooting

- **UI shows "Discovery v3 is not enabled"**: flag is off on the server.
- **`/health` reports empty tier counts**: run backfill scripts 04 + 05.
- **Goldsky fetcher errors in log**: the listener swallows transient failures
  and retries on the next tick. Check `pipeline_cursor` for stuck values.
- **Snapshot determinism**: snapshots are deleted + re-emitted each refresh.
  Hash should be stable across runs for a fixed input dataset.
- **Unexpected v3 staleness with `DISCOVERY_V3=true`**: verify the discovery
  process is `start:discovery`/`start:prod:discovery` (single worker owner),
  not just `APP_RUNTIME=discovery-worker` via `index.ts`.

## Phase B2 dedup: GROUP BY, not ROW_NUMBER (addendum 2026-04-23)

The per-bucket `INSERT INTO discovery_activity_v3` in
`buildSortedParquetToActivitySql` uses `GROUP BY (transaction_hash,
log_index)` with `arg_min(col, timestamp)` to pick the winner row.

Do NOT change this to `ROW_NUMBER() OVER (PARTITION BY ...)` or
`LAG() OVER ()`:

- `LAG() OVER ()` (empty window) has undefined row ordering in DuckDB
  and produced duplicate primary keys in production
  (`tx_hash: 000004e9..., log_index: 106`).
- `ROW_NUMBER() OVER (PARTITION BY tx_hash, log_index ORDER BY timestamp)`
  was the next attempt. It also produced duplicate rn=1 rows in parallel
  execution over pre-sorted bucket parquets
  (`tx_hash: 0001b36e..., log_index: 524`), despite the partition
  mathematically guaranteeing uniqueness. Root cause is likely the
  parallel window operator merging streams incorrectly when input is
  pre-sorted by partition keys.
- `GROUP BY` + `arg_min` is mathematically guaranteed to emit exactly
  one row per key. The deprecated staging path used the same pattern
  successfully.
- Memory is bounded: each bucket is ~14.5M rows (~1.5GB), well under the
  6GB `DUCKDB_MEMORY_LIMIT_GB`. The global GROUP BY that failed at 900M
  rows is not relevant here — buckets cap group count.

Tests in `tests/v3-backfill-mapping.test.ts` assert the SQL uses
`GROUP BY transaction_hash, log_index` and `arg_min(...)`, and forbid
`ROW_NUMBER(` / `LAG(`.
