# Discovery v3 Operations Runbook

Operational runbook for Discovery v3 based on current repository code and scripts.

## 1) Scope and Ownership

Discovery v3 is additive and feature-flagged.

- Flag gate: `DISCOVERY_V3=true`
- API router: `src/api/discoveryRoutesV3.ts`
- Worker bootstrap: `src/discovery/v3/workerIntegration.ts`
- Parent worker process: `src/discovery/discoveryWorker.ts`

## 2) Runtime Ownership Rules

Source of truth:

- `src/discovery/discoveryWorker.ts`
- `src/discovery/v3/workerIntegration.ts`

Operational guidance:

- Use `npm run start:discovery` (or `npm run start:prod:discovery`) for dedicated worker runs.
- `npm run dev` also starts the discovery worker in watch mode.
- `APP_RUNTIME=discovery-worker` through `src/index.ts` exists, but it does not bootstrap v3 integration in that path; prefer dedicated discovery worker commands for v3 operations.

## 3) Environment Variables (v3-critical)

From `ENV_EXAMPLE.txt` + `src/discovery/v3/featureFlag.ts`.

- `DISCOVERY_V3` (default false): master v3 switch.
- `DUCKDB_PATH` (default `./data/discovery_v3.duckdb`): DuckDB sidecar location.
- `DISCOVERY_V3_SKIP_ACTIVITY_ART_INDEXES` (default false): backfill memory mitigation.
- `DISCOVERY_V3_GOLDSKY_ENABLED` (default false in template): force-enable Goldsky path post-cutover.
- `DISCOVERY_V3_RPC_POLL_ENABLED` (default true in template): enable RPC forward-fill.
- `DISCOVERY_V3_RPC_POLL_INTERVAL_MS` (default `3600000`): RPC poll interval.
- `DISCOVERY_V3_RPC_BLOCK_CHUNK` (default `2000`)
- `DISCOVERY_V3_RPC_OVERLAP_BLOCKS` (default `100`)
- `DISCOVERY_V3_RPC_INITIAL_LOOKBACK_BLOCKS` (default `1800`)

## 4) API Behavior and Auth Model

Server mount behavior from `src/server.ts`:

- Router mounts only when v3 is enabled.
- Read endpoints are exposed as public read surface.
- Mutating endpoints use `requireAuthForMutations` in router.

Mutating endpoints in router:

- `POST /watchlist`
- `DELETE /watchlist/:addr`
- `POST /dismiss`
- `POST /track`

Read endpoints in router:

- `GET /tier/:tier`
- `GET /wallet/:address`
- `GET /compare`
- `GET /health`
- `GET /cutover-status`

## 5) Backfill Pipeline (Scripts)

Primary scripts in `scripts/backfill/`:

1. `00_fetch_parquet.ts`
2. `01_init_duckdb.ts`
3. `02_load_events.ts` (and bucket variants `02a`, `02c`, `02d`)
4. `03_load_markets.ts`
5. `04_emit_snapshots.ts`
6. `05_score_and_publish.ts`
7. `06_validate.ts`
8. `06_promotion_gate.ts`
9. `07_soak_report.ts`
10. `07_goldsky_gap_fill.ts`

Canonical order can vary by dataset size/host constraints. For large workloads, bucketed loaders are the supported path.

See also:

- `scripts/backfill/README.md`
- `docs/plans/discovery-display-accuracy.md`

## 6) Verification Commands

Baseline checks:

```bash
npm run build
npm test
```

Discovery validation helpers:

```bash
npm run discovery:preflight
npm run discovery:preflight:forward
npm run discovery:run:full
npm run verify:staging-display
npm run verify:promotion-gate
npm run verify:soak
```

PnL validation helpers:

```bash
npm run verify:pnl:dry-run
npm run verify:pnl:smoke
npm run verify:pnl:full
```

## 7) Operational Health Checks

When app and worker are running locally:

```bash
curl -s http://localhost:3001/health
curl -s http://localhost:3001/api/discovery/v3/health
curl -s "http://localhost:3001/api/discovery/v3/tier/alpha?limit=5"
```

Expected:

- `/health` returns `{ "status": "ok", ... }`
- v3 endpoints return JSON success payloads when `DISCOVERY_V3=true`

## 8) Known Verification Boundaries

The following may exist in deployment scripts/docs but are not directly verifiable from app route code:

- `/health/ready` external readiness behavior

Repository evidence:

- `/health` route is implemented in `src/server.ts`.
- `/health/ready` is referenced in deployment scripts and some docs, but not defined as an app route in this repository.

Treat `/health/ready` as environment-specific until explicitly validated in target infrastructure.

## 9) Failure Triage

### v3 endpoints returning 404

- Confirm `DISCOVERY_V3=true` in process environment.

### v3 data appears stale

- Confirm discovery worker is running.
- Check worker logs for v3 bootstrap state, Goldsky/RPC poll, and refresh loop output.

### migration/index memory issues during backfill

- Use `DISCOVERY_V3_SKIP_ACTIVITY_ART_INDEXES=true` for large backfill hosts where ART index creation exceeds memory.

### auth mismatch on mutating endpoints

- Validate `AUTH_MODE`, OIDC session state, and route-level mutation auth response payloads.
