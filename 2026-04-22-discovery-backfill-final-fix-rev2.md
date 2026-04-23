# Discovery v3 Backfill — Final Fix rev2 (2026-04-22)

**Supersedes** `2026-04-22-discovery-backfill-final-fix.md` (rev1) and
`2026-04-20-discovery-backfill-addendum.md`. This is the authoritative
post-mortem and runbook for the v3 backfill going forward.

## TL;DR for the next agent

- Backfill path is `02a_sort_bucket.ts` (64 per-process bucket sorts) →
  **`02c_merge_one_bucket.ts`** (INSERT with **bucket-local** GROUP BY
  dedup directly from parquet, into an **index-less** table) →
  **`02d_dedup_and_index.ts`** (defensive duplicate-key scan, then build
  UNIQUE + aux indexes).
- Orchestrator: **`scripts/backfill/finish_backfill.sh`** (env-driven,
  idempotent).
- Live listener path (`goldskyListener.ts` → `runV3DuckDBMigrations`) is
  unchanged and still creates the UNIQUE INDEX from day 1. **Do not**
  point live ingest at `…NoIndex`.
- Deprecated (keep for reference only, never use): `02b_merge_buckets.ts`,
  `buildSortedParquetToActivitySql`, `buildSortedParquetToActivityRawSql`,
  `buildActivityDedupCtasSql`, `ACTIVITY_DEDUP_SWAP_SQL`.

## Two problems, not one

This is the third complete rewrite of Phase B. The backfill has two
independent DuckDB pitfalls at Hetzner scale (8 GB RAM, 75 GB free temp,
927M source rows, ~956M rows after per-bucket expansion):

### Problem 1 — spurious Duplicate key faults

The original `02b_merge_buckets.ts` did
`INSERT … SELECT … GROUP BY tx_hash, log_index` into a table with a
UNIQUE INDEX. DuckDB's aggregate-insert → unique-index-maintenance
pipeline raised `Constraint Error: Duplicate key` on keys that appeared
**exactly once** in the source parquet (confirmed via diagnostic
`failing_key_rows: 1`). Known DuckDB regressions:
[duckdb#11102](https://github.com/duckdb/duckdb/issues/11102),
[duckdb#16520](https://github.com/duckdb/duckdb/issues/16520).

### Problem 2 — temp-directory exhaustion

rev1 of the final fix separated load from dedup: raw INSERT per bucket
(956M rows total in the table), then a single global CTAS
`CREATE TABLE _dedup AS SELECT … GROUP BY tx_hash, log_index FROM
discovery_activity_v3`. That CTAS needs enough spill room for the full
GROUP BY state over 956M rows; at ~75 GB free disk it died with

```
Out of Memory Error: failed to offload data block of size 256.0 KiB
(75.9 GiB/75.9 GiB used). This limit was set by the
'max_temp_directory_size' setting.
```

## Solution (rev2): bucket-local dedup during the load INSERT

1. **Table creation (no indexes).** `finish_backfill.sh` calls
   `runV3DuckDBMigrationsBackfillNoIndex` exactly once. Only
   `V3_ACTIVITY_TABLE_DDL` runs; `V3_ACTIVITY_INDEX_DDL` is held until
   Phase B2.
2. **Phase B1 — bucket-local dedup-insert per bucket.** For each of the
   64 bucket parquets produced by `02a`, spawn a fresh
   `02c_merge_one_bucket.ts` process. `02c` uses
   `buildSortedParquetToActivityDedupedSql`:

   ```sql
   INSERT INTO discovery_activity_v3
   WITH raw AS (
     SELECT
       "user" AS proxy_wallet, market_id, condition_id, event_id,
       CAST(timestamp    AS UBIGINT) AS ts_unix,
       CAST(block_number AS UBIGINT) AS block_number,
       transaction_hash               AS tx_hash,
       CAST(log_index    AS UINTEGER) AS log_index,
       LOWER(role) AS role,
       CASE WHEN token_amount > 0 THEN 'BUY' ELSE 'SELL' END AS side,
       CAST(price        AS DOUBLE)   AS price_yes,
       CAST(usd_amount   AS DOUBLE)   AS usd_notional,
       CAST(token_amount AS DOUBLE)   AS signed_size,
       ABS(CAST(token_amount AS DOUBLE)) AS abs_size
     FROM read_parquet('<bucket_NNNN.parquet>')
   )
   SELECT
     arg_min(proxy_wallet, ts_unix) AS proxy_wallet,
     arg_min(market_id,    ts_unix) AS market_id,
     arg_min(condition_id, ts_unix) AS condition_id,
     arg_min(event_id,     ts_unix) AS event_id,
     MIN(ts_unix)                   AS ts_unix,
     arg_min(block_number, ts_unix) AS block_number,
     tx_hash, log_index,
     arg_min(role,         ts_unix) AS role,
     arg_min(side,         ts_unix) AS side,
     arg_min(price_yes,    ts_unix) AS price_yes,
     arg_min(usd_notional, ts_unix) AS usd_notional,
     arg_min(signed_size,  ts_unix) AS signed_size,
     arg_min(abs_size,     ts_unix) AS abs_size
   FROM raw
   GROUP BY tx_hash, log_index
   ```

   Key properties:
   - **Aggregate runs against the parquet only** (the `raw` CTE), so the
     GROUP BY is a fresh scan, not a re-read of an ever-growing table.
   - **Target table has no indexes** during backfill, so the insert side
     does not trigger the constraint-maintenance pipeline that was the
     source of the spurious Duplicate key errors.
   - **Spill is bounded to one bucket** (~14.5 M rows, ~1.1 GB parquet →
     a few GB of GROUP BY state), well inside the memory + temp envelope
     on the 8 GB box.
   - `arg_min(col, ts_unix)` preserves the prior "earliest wins"
     semantics.
   - Defensive `DROP INDEX IF EXISTS` before the insert (if a prior
     partial run left indexes, kill them now).
   - `CHECKPOINT` after, then delete the bucket parquet.

3. **Phase B2 — build indexes.** `02d_dedup_and_index.ts` runs once at
   the end:

   1. Optional defensive scan:
      `SELECT COUNT(*) FROM (SELECT tx_hash, log_index FROM
      discovery_activity_v3 GROUP BY 1,2 HAVING COUNT(*) > 1)`.
      Must be zero (by construction); if not, it refuses to proceed.
      Pass `--skip-dupe-check` to bypass.
   2. Rebuild indexes via `buildActivityIndexSqlList()`:
      - `CREATE UNIQUE INDEX idx_activity_v3_dedup ON (tx_hash, log_index)`
      - `CREATE INDEX idx_activity_v3_wallet_ts ON (proxy_wallet, ts_unix)`
      - `CREATE INDEX idx_activity_v3_market_ts ON (market_id, ts_unix)`

   The unique index is created on data that is already deduped, so it
   cannot hit the DuckDB constraint-maintenance bug.

## Correctness argument for bucket-local dedup

`02a` hash-bucketizes on `abs(hash(transaction_hash)) % 64`. The hash
function is deterministic, so every row with the same `transaction_hash`
lands in the same bucket. `(tx_hash, log_index)` is therefore a
bucket-local identity: all duplicates of any key are co-located in one
bucket. Per-bucket GROUP BY is then mathematically equivalent to global
GROUP BY. This is the same invariant that justified the legacy `02b`
per-bucket LAG dedup and is unit-tested in
`tests/v3-backfill-mapping.test.ts` via the
`bucketed path == single-sort path` assertion.

## Files

### Modified

- `src/discovery/v3/backfillQueries.ts`
  - Added `buildSortedParquetToActivityDedupedSql(parquetPath)` — the
    one the new `02c` uses.
  - `buildSortedParquetToActivityRawSql`, `buildActivityDedupCtasSql`,
    and `ACTIVITY_DEDUP_SWAP_SQL` are now all `@deprecated`.
- `src/discovery/v3/duckdbSchema.ts` — unchanged from rev1
  (`runV3DuckDBMigrationsBackfillNoIndex` + `buildActivityIndexSqlList`
  still the supported surface).
- `scripts/backfill/02c_merge_one_bucket.ts` — uses
  `buildSortedParquetToActivityDedupedSql`. Still defensively drops
  indexes before the insert.
- `scripts/backfill/02d_dedup_and_index.ts` — rewritten; is now a
  "build indexes" step only, with an optional defensive dedup-check.
- `scripts/backfill/finish_backfill.sh` — comments updated; flow
  unchanged.
- `tests/v3-backfill-mapping.test.ts` — `runNoIndexLoadAndDedup` helper
  now exercises the new per-bucket dedup path (no CTAS); SQL plan
  assertions updated to require GROUP BY + arg_min in the dedup-insert
  builder and to ensure the legacy raw builder is still pure projection.
- `tests/v3-backfill-scale-integration.ts` — exercises the new flow
  at 2M rows.
- `CODEBASE_GUIDE.md` — "Current production" section + pitfalls
  updated.

### Deprecated (kept on disk, not used in production)

- `scripts/backfill/02b_merge_buckets.ts`
- `buildSortedParquetToActivitySql` (legacy LAG dedup builder)
- `buildSortedParquetToActivityRawSql` (rev1 raw-only builder)
- `buildActivityDedupCtasSql`, `ACTIVITY_DEDUP_SWAP_SQL` (rev1 global
  CTAS path)

## Test results

- Full suite (`npx tsx --test tests/*.test.ts`): **246/246 pass, 0 fail,
  ~19 s**.
- Scale smoke test (`tests/v3-backfill-scale-integration.ts`) at 2M rows
  with ~600 duplicates: dedup-insert → index rebuild succeeds end-to-end;
  post-load duplicate INSERT is correctly rejected by the unique
  constraint.

## Operational runbook (Hetzner)

Prerequisite: `users.parquet` must be present at
`/mnt/HC_Volume_105468668/repo-v3/data/users.parquet` (symlinked to
`/mnt/HC_Volume_105468668/backfill/users.parquet`). The 64 bucket
parquets may be absent (02a will re-create them).

```bash
# Start fresh: nuke any partial DB + bucket parquets, start Phase A+B from scratch
ssh root@46.62.231.173

cd /mnt/HC_Volume_105468668/repo-v3
git fetch origin discovery-v3-rebuild
git reset --hard origin/discovery-v3-rebuild
git log -1 --oneline   # should show the rev2 merge commit

# Clean slate (DB file + any stray bucket parquets + duckdb temp dir)
rm -f /mnt/HC_Volume_105468668/discovery_v3.duckdb
rm -f /mnt/HC_Volume_105468668/discovery_v3.duckdb.wal
rm -f /mnt/HC_Volume_105468668/bucket_parquets/*.parquet
rm -rf /mnt/HC_Volume_105468668/duckdb_tmp/*

# Regenerate the 64 sorted bucket parquets (02a). Run in tmux — this takes hours.
export DUCKDB_MEMORY_LIMIT_GB=6
export DUCKDB_THREADS=2
export DUCKDB_TEMP_DIR=/mnt/HC_Volume_105468668/duckdb_tmp
export DUCKDB_MAX_TEMP_DIR_GB=60
export SORTED_PARQUET_DIR=/mnt/HC_Volume_105468668/bucket_parquets

tmux new -s sort -d "for b in \$(seq 0 63); do \
  f=\$(printf \"\$SORTED_PARQUET_DIR/sorted_events_bucket_%04d.parquet\" \$b); \
  [ -s \"\$f\" ] && { echo skip \$b; continue; }; \
  echo bucket \$b; \
  npx tsx scripts/backfill/02a_sort_bucket.ts --bucket \$b --total 64 --out \"\$f\" \
    || { echo FAIL \$b; exit 1; }; \
done | tee /root/backfill_02a_\$(date +%Y%m%d_%H%M%S).log"

# Watch:
tmux attach -t sort

# When 02a is done (64 bucket parquets present), run finish_backfill.sh:
tmux new -s finish -d "bash scripts/backfill/finish_backfill.sh 2>&1 | tee /root/backfill_FINAL_rev2_\$(date +%Y%m%d_%H%M%S).log"
tmux attach -t finish
```

### Resume semantics

- Mid-`02a`: rerun the loop. Each `02a` invocation skips buckets whose
  parquet already exists.
- Mid-`02c`: rerun `finish_backfill.sh`. `02c` only deletes a bucket
  parquet after its INSERT commits. Interrupted buckets will have
  already-inserted (and deduped) rows in the table AND still have their
  parquet on disk, so rerunning will re-insert the same deduped rows —
  producing duplicates in the cumulative table. `02d`'s defensive dupe
  scan will catch this; if it trips, the safest recovery is:

  ```
  rm -f /mnt/HC_Volume_105468668/discovery_v3.duckdb*
  # 02c loop will redo every bucket that still has a parquet
  ```

  (All source data is recoverable from `users.parquet` + 02a if the
  parquets were deleted.)
- Mid-`02d`: rerun `finish_backfill.sh`. Index creation is idempotent
  (`IF NOT EXISTS` is not used, but a second run will no-op against an
  existing identical index; if DuckDB complains on reattempt, drop the
  three indexes manually then rerun).

## Do-not-regress checklist

- [ ] Never re-introduce `INSERT … GROUP BY` into
      `discovery_activity_v3` while the table has a UNIQUE INDEX.
- [ ] Never point the live listener at the no-index table DDL — live
      dedup needs the UNIQUE INDEX from day 1.
- [ ] Never remove `runV3DuckDBMigrations` or change its semantics.
- [ ] Never reintroduce a global
      `CREATE TABLE _dedup AS … GROUP BY …` over
      `discovery_activity_v3`. It blows the temp budget. Keep dedup
      per-bucket.
- [ ] Never skip the per-bucket GROUP BY in `02c`: without it, post-load
      `CREATE UNIQUE INDEX` will fail on the ~5,894 real duplicate keys
      per bucket.
