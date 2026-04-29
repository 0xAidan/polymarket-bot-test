# Discovery v3 Student Handoff Runbook (No-Guess)

This runbook is the fastest safe path to finish Discovery v3 stabilization and promote to production.

## Scope

- Finish on branch `fix/discovery-v3-final-stabilization`.
- Do not redesign schema.
- Do not run a full historical reconstruction.
- Promote only a commit that passed staging soak.

## What you need

- Access to staging host repository path: `/mnt/HC_Volume_105468668/repo-v3`
- Node dependencies installed (`npm install`)
- Environment values for:
  - `DUCKDB_PATH`
  - `DUCKDB_TEMP_DIR`
  - `DATA_DIR`
  - `DUCKDB_MEMORY_LIMIT_GB`
  - `DUCKDB_THREADS`
  - `DUCKDB_MAX_TEMP_DIR_GB`
  - `DISCOVERY_V3_HISTORICAL_BACKFILL_SOURCE`
  - `DISCOVERY_V3_HISTORICAL_COVERAGE_MAX_TS`
  - `DISCOVERY_V3_KNOWN_GAP_POLICY`

## Step 1) Lock branch and commit

```bash
cd /mnt/HC_Volume_105468668/repo-v3
git fetch origin
git checkout fix/discovery-v3-final-stabilization
git pull --ff-only
git rev-parse HEAD
```

Save this SHA as `SOAK_SHA`. Every validation and promotion must use this exact commit.

## Step 2) Confirm required files exist

```bash
test -f scripts/backfill/05_score_and_publish.ts
test -f scripts/backfill/06_validate.ts
test -f scripts/backfill/06_promotion_gate.ts
test -f scripts/backfill/07_soak_report.ts
test -f scripts/verify-release-commit.sh
test -f src/api/discoveryRoutesV3.ts
test -f src/discovery/v3/coverageContract.ts
```

If any check fails, stop and fix checkout/branch drift first.

## Step 3) Export one canonical runtime environment

```bash
export DUCKDB_PATH="/mnt/HC_Volume_105468668/data/discovery_v3.duckdb"
export DUCKDB_TEMP_DIR="/mnt/HC_Volume_105468668/duckdb_tmp"
export DATA_DIR="/mnt/HC_Volume_105468668/data"
export DUCKDB_MEMORY_LIMIT_GB="6"
export DUCKDB_THREADS="1"
export DUCKDB_MAX_TEMP_DIR_GB="150"
export DISCOVERY_V3_HISTORICAL_BACKFILL_SOURCE="huggingface:SII-WANGZJ/Polymarket_data/users.parquet"
export DISCOVERY_V3_HISTORICAL_COVERAGE_MAX_TS="1772668800"
export DISCOVERY_V3_KNOWN_GAP_POLICY="Historical coverage is limited to imported backfill plus live ingest; issue #103 tracks historical source gaps."
```

Do not mix `/opt/...` and `/mnt/...` paths during this run.

## Step 4) Rebuild score read model

```bash
npx tsx scripts/backfill/05_score_and_publish.ts
```

If this fails with OOM, do not change schema. First confirm you are still on `SOAK_SHA`, then rerun with the same env and `DUCKDB_THREADS=1`.

## Step 5) Run hard gates

```bash
npx tsx scripts/backfill/06_validate.ts
npm run verify:promotion-gate
npm run verify:soak
```

Required pass conditions:

- `verify:promotion-gate` exits success
- no integrity blockers (duplicates, corruption sentinel rows, empty snapshot, missing tiers)
- soak report shows:
  - `duckdb.snapshot_rows > 0`
  - `duckdb.snapshot_wallets > 0`
  - all of `alpha`, `whale`, `specialist` tiers non-empty
  - cursor present and not stale

Coverage warnings are informational under known-gap policy and do not block promotion by themselves.

## Step 6) Verify single worker ownership

Run only one authoritative discovery worker process for this environment:

- dev: `npm run start:discovery`
- prod runtime: `npm run start:prod:discovery`

Do not rely on `APP_RUNTIME=discovery-worker` through `src/index.ts` for v3 ownership.

## Step 7) Soak window (24-48 hours)

Run every 30-60 minutes:

```bash
npm run verify:soak
```

Record outputs in your handoff notes. Any stalled cursor or empty tier is a no-go until corrected.

## Step 8) Promotion checks and release

Before production:

```bash
./scripts/verify-release-commit.sh "$SOAK_SHA"
npm run verify:promotion-gate
npm run verify:soak
```

Promote only if all checks pass on the same `SOAK_SHA`.

## No-Go conditions (stop immediately)

- Running commands from wrong working directory (`/root`, etc.)
- Any branch/commit mismatch from `SOAK_SHA`
- Empty tier table after scoring
- Integrity gate fails
- Cursor missing/stale after worker correction

## Student handoff template

Use this exact status block when handing off:

```txt
Discovery v3 stabilization handoff
- branch: fix/discovery-v3-final-stabilization
- soak_sha: <sha>
- env: canonical (/mnt paths) confirmed
- score_and_publish: PASS/FAIL
- validate: PASS/FAIL
- promotion_gate: PASS/FAIL
- soak: PASS/FAIL (attach latest JSON)
- worker ownership: single owner confirmed (yes/no)
- decision: GO / NO-GO
- notes: <only concrete blockers, no guesses>
```
