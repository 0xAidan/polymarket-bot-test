# Discovery v3 Backfill — Final Fix (2026-04-22)

**Supersedes** `2026-04-20-discovery-backfill-addendum.md`. That addendum
described the ROW_NUMBER → GROUP BY pivot which was itself the proximate
cause of the Phase B2 failures. This document is the authoritative
post-mortem and runbook for the backfill going forward.

## TL;DR for the next agent

- Backfill path is now `02a_sort_bucket.ts` (64 per-process bucket sorts)
  → **`02c_merge_one_bucket.ts`** (plain `INSERT`, no GROUP BY, no
  indexes) → **`02d_dedup_and_index.ts`** (CTAS dedup + swap + rebuild
  indexes on already-deduped data).
- Orchestrator: **`scripts/backfill/finish_backfill.sh`** (env-driven,
  idempotent).
- Live listener path (`goldskyListener.ts` → `runV3DuckDBMigrations`) is
  unchanged and still creates the UNIQUE INDEX from day 1. **Do not**
  point live ingest at the no-index variant.
- `02b_merge_buckets.ts` and `buildSortedParquetToActivitySql` are
  DEPRECATED; they trigger the DuckDB bug at production scale.

## Root cause

Phase B2 failed three times on the Hetzner box (46.62.231.173,
`ubuntu-8gb-hel1-1`, 8 GB RAM) with spurious `Constraint Error: Duplicate
key` faults on bucket-0 `INSERT`. Representative failures across the
three attempts: `000004e9…` li:106, `0001b36e…` li:524, `06da345d…`
li:611.

For each failing key the diagnostic SQL returned `failing_key_rows: 1` on
the source parquet — the supposed duplicate key appears **exactly once**
in the input. A `GROUP BY tx_hash, log_index` cannot mathematically emit
a duplicate from a source where the key is unique, so the constraint
error was not a true duplicate. The error is a known DuckDB regression in
the aggregate-insert → unique-index-maintenance pipeline at scale:

- [duckdb/duckdb#11102](https://github.com/duckdb/duckdb/issues/11102)
- [duckdb/duckdb#16520](https://github.com/duckdb/duckdb/issues/16520)

Both are still open against the bulk GROUP BY-into-indexed-table path as
of DuckDB 1.4.4.

## Solution: no-index-during-load

1. **Table creation (no indexes).** `finish_backfill.sh` calls
   `runV3DuckDBMigrationsBackfillNoIndex` exactly once. This executes
   only `V3_ACTIVITY_TABLE_DDL` (the `CREATE TABLE` statement). The
   `V3_ACTIVITY_INDEX_DDL` list (unique + aux indexes) is deliberately
   not applied yet.
2. **Phase B1 — raw per-bucket loads.** For each of the 64 bucket
   parquets produced by `02a`, spawn a fresh `02c_merge_one_bucket.ts`
   process. `02c` now uses `buildSortedParquetToActivityRawSql(path)`:

   ```sql
   INSERT INTO discovery_activity_v3
   SELECT transaction_hash AS tx_hash,
          log_index,
          lower(user_address) AS user_address,
          ... -- plain projection, no GROUP BY, no DISTINCT
   FROM read_parquet(?, preserve_insertion_order = true)
   ```

   As a belt-and-braces guard `02c` also runs
   `DROP INDEX IF EXISTS idx_activity_v3_dedup / user_ts / token_ts`
   before the insert, so any stale index from a previous partial run
   cannot interfere. After each insert, checkpoint and `rm` the bucket
   parquet.
3. **Phase B2 — dedup + swap + rebuild indexes.**
   `02d_dedup_and_index.ts` runs once at the end:

   1. CTAS dedup into a brand-new indexless table (via
      `buildActivityDedupCtasSql`):

      ```sql
      CREATE TABLE discovery_activity_v3_dedup AS
      SELECT
        tx_hash,
        log_index,
        arg_min(user_address, ts_unix)    AS user_address,
        arg_min(token_id,     ts_unix)    AS token_id,
        arg_min(market,       ts_unix)    AS market,
        arg_min(side,         ts_unix)    AS side,
        arg_min(size_raw,     ts_unix)    AS size_raw,
        arg_min(price_e6,     ts_unix)    AS price_e6,
        arg_min(ts_unix,      ts_unix)    AS ts_unix,
        arg_min(block_number, ts_unix)    AS block_number
      FROM discovery_activity_v3
      GROUP BY tx_hash, log_index;
      ```

      `arg_min(col, ts_unix)` preserves the prior "earliest wins"
      semantics.
   2. Swap (`ACTIVITY_DEDUP_SWAP_SQL`):
      `DROP TABLE discovery_activity_v3;
       ALTER TABLE discovery_activity_v3_dedup RENAME TO discovery_activity_v3;`
   3. Rebuild indexes on already-deduped data via
      `buildActivityIndexSqlList()`:
      - `CREATE UNIQUE INDEX idx_activity_v3_dedup ON (tx_hash, log_index)`
      - `CREATE INDEX idx_activity_v3_user_ts ON (user_address, ts_unix)`
      - `CREATE INDEX idx_activity_v3_token_ts ON (token_id, ts_unix)`

   The unique index is created on data that is already deduped by the
   CTAS, so it cannot hit the DuckDB bug.

## Why this works when the old path does not

- The old path combined two things DuckDB struggles with together at
  scale: streaming aggregate insert AND unique-index maintenance. Either
  one is fine on its own.
- The new path does only plain inserts during load (no aggregate, no
  index). Dedup happens once, in isolation, as a CTAS — no index to
  interfere. Index creation happens once, on static already-deduped data
  — no concurrent writes, no aggregation.
- Row count invariant: raw loads produce the full 927M-row table; the
  CTAS collapses to the same deduped count the old path produced on the
  rare buckets that succeeded.

## Files

### Modified

- `src/discovery/v3/duckdbSchema.ts`
  - Split `V3_DUCKDB_DDL` into `V3_ACTIVITY_TABLE_DDL` (single CREATE
    TABLE string) + `V3_ACTIVITY_INDEX_DDL` (array of CREATE INDEX
    strings).
  - Added `runV3DuckDBMigrationsBackfillNoIndex(duckdb)` — executes only
    the table DDL.
  - Added `buildActivityIndexSqlList()` — returns the 3 CREATE INDEX
    statements to rebuild after dedup.
  - `runV3DuckDBMigrations` (used by `goldskyListener.ts`) is unchanged.

- `src/discovery/v3/backfillQueries.ts`
  - Added `buildSortedParquetToActivityRawSql(parquetPath)` — plain
    INSERT, no GROUP BY, no DISTINCT.
  - Added `buildActivityDedupCtasSql()` — CTAS dedup with
    `arg_min(col, ts_unix)`.
  - Added `ACTIVITY_DEDUP_SWAP_SQL` constant (DROP + RENAME).
  - `buildSortedParquetToActivitySql` is now `@deprecated`.

- `scripts/backfill/02c_merge_one_bucket.ts`
  - Now uses `buildSortedParquetToActivityRawSql`.
  - Defensive `DROP INDEX IF EXISTS` for all three activity indexes
    before the insert.
  - Preserves prior behaviour: checkpoint, delete bucket parquet on
    success.

- `tests/v3-backfill-mapping.test.ts`
  - New `runNoIndexLoadAndDedup()` helper mirrors the production flow
    exactly.
  - Rewrote the 3 bucket-path tests to exercise the new flow.
  - Updated SQL assertions against the new builders.

### New

- `scripts/backfill/02d_dedup_and_index.ts` — CTAS dedup → swap →
  rebuild indexes. Supports `--dry-run`.
- `scripts/backfill/finish_backfill.sh` — end-to-end orchestrator.
  Env-driven (`SORTED_PARQUET_DIR` default
  `/mnt/HC_Volume_105468668/bucket_parquets`). Runs the `02c` loop, then
  `02d`, then `03-06`. `chmod +x` already applied.
- `tests/v3-backfill-scale-integration.ts` — 2M-row scale smoke test.
  Not auto-run (file name lacks `.test.ts`); invoke manually with
  `npx tsx tests/v3-backfill-scale-integration.ts`.

### Deprecated (kept on disk, not used in production)

- `scripts/backfill/02b_merge_buckets.ts`
- `buildSortedParquetToActivitySql` in `backfillQueries.ts`

## Test results

- Full suite (`npx tsx --test tests/*.test.ts`): **246/246 pass, 0 fail,
  ~21 s**.
- Scale smoke test (`tests/v3-backfill-scale-integration.ts`) at 2M rows
  with ~600 duplicates: raw insert, CTAS dedup, swap, unique index
  rebuild all succeed; post-load duplicate INSERT is correctly rejected
  by the rebuilt unique constraint.
- Local DuckDB reproductions under `/home/user/workspace/`:
  - `repro.py` — small-scale repro (control).
  - `repro2.py` — 14.5M-row repro at Hetzner-like memory.
  - `repro3.py` — proves the no-index-during-load fix end-to-end.

## Operational runbook (Hetzner)

```bash
cd /mnt/HC_Volume_105468668/repo-v3 && \
git fetch origin discovery-v3-final-fix && \
git reset --hard origin/discovery-v3-final-fix && \
tmux new -s final -d "bash scripts/backfill/finish_backfill.sh 2>&1 | tee /root/backfill_FINAL_$(date +%Y%m%d_%H%M%S).log"
```

Pre-existing env (already set on the box):

- `DUCKDB_MEMORY_LIMIT_GB=6`
- `DUCKDB_THREADS=2`
- `DUCKDB_TEMP_DIR=/mnt/HC_Volume_105468668/duckdb_tmp`
- `DUCKDB_MAX_TEMP_DIR_GB=60`
- `SORTED_PARQUET_DIR=/mnt/HC_Volume_105468668/bucket_parquets`

Prerequisites assumed on the box:

- All 64 bucket parquets present at `$SORTED_PARQUET_DIR/sorted_events_bucket_NNNN.parquet`
  (already the case — confirmed 2026-04-22).
- `discovery_v3.duckdb` empty (was nuked after the last failure — OK,
  `finish_backfill.sh` will recreate the table).
- Live `polymar+` processes (`dist/index.js`, `discoveryWorker.js`) are
  not touched by the backfill — leave them running.

If `finish_backfill.sh` is interrupted:

- Mid-`02c`: re-run. `02c` only deletes a bucket parquet after its INSERT
  commits, so partially loaded buckets get a full re-insert into the
  existing table. The extra rows will be deduped in `02d`.
- Mid-`02d`: re-run. `02d` drops the `_dedup` table if present and
  redoes the CTAS + swap from scratch.

## Do-not-regress checklist

- [ ] Never re-introduce `GROUP BY tx_hash, log_index` on a bucket insert
      into an indexed `discovery_activity_v3`.
- [ ] Never point the live listener at the no-index table DDL — live
      dedup needs the UNIQUE INDEX from day 1.
- [ ] Never remove `runV3DuckDBMigrations` or change its semantics.
- [ ] Never skip the CTAS dedup in `02d`: without it, the subsequent
      `CREATE UNIQUE INDEX` will fail on the real 5,894 duplicate keys
      per bucket.
