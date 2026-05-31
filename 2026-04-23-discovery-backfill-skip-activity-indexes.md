# Discovery v3 backfill — rev3 fix (skip activity indexes)

Date: 2026-04-23
Branch: `discovery-v3-skip-activity-indexes` → PR into `discovery-v3-rebuild` (NOT main).

## TL;DR

Backfill on the Hetzner 8 GB box must never build ART indexes on
`discovery_activity_v3` (UNIQUE or otherwise). DuckDB 1.4.x requires the
entire ART index to fit in memory during `CREATE [UNIQUE] INDEX`, which
for ~800M rows needs ~100GB of RAM (official DuckDB docs; duckdb/duckdb
issues [#15420](https://github.com/duckdb/duckdb/issues/15420) and
[#16229](https://github.com/duckdb/duckdb/issues/16229) — both open on
1.4.x). Non-unique ART uses the same code path and does not help.

Previous attempts failed for this reason (rev2 OOM'd mid-`CREATE UNIQUE
INDEX` after a 13 GB DB contamination was resolved).

## Why no functional regression

1. **Backfill uniqueness**: 02a bucketizes on `abs(hash(tx_hash)) % N`,
   so every duplicate `(tx_hash, log_index)` lives in exactly one bucket.
   02c's `buildSortedParquetToActivityDedupedSql` does a bucket-local
   `GROUP BY tx_hash, log_index` with `arg_min(..., ts_unix)`. This is
   mathematically equivalent to global dedup. 02d does a defensive
   `GROUP BY ... HAVING COUNT(*) > 1` scan to confirm.
2. **Downstream queries**: 04's snapshot SQL is a full-table scan + hash
   join (no point lookup). 05 and 06 only read
   `discovery_feature_snapshots_v3`, which has a native `PRIMARY KEY
   (proxy_wallet, snapshot_day)` — small, fits.
3. **Live prod unaffected**: `goldskyListener.insertNormalizedRows` uses
   the UNIQUE constraint to swallow overlap duplicates at the
   backfill→live boundary. Live DuckDB is tiny (continuous tail, not
   2.5 years of history), so the index builds fine. The full DDL
   (`runV3DuckDBMigrations` / `V3_ACTIVITY_INDEX_DDL`) is unchanged for
   that path.

## Code changes

- `src/discovery/v3/duckdbSchema.ts`
  Keeps `V3_ACTIVITY_INDEX_DDL` + full `runV3DuckDBMigrations` for prod.
  Documents that `runV3DuckDBMigrationsBackfillNoIndex` is the backfill
  entry point and why.
- `scripts/backfill/02d_dedup_and_index.ts`
  Now a verify + CHECKPOINT step only. No index creation.
- `scripts/backfill/03_load_markets.ts`,
  `scripts/backfill/04_emit_snapshots.ts`,
  `scripts/backfill/05_score_and_publish.ts`
  Switched to `runV3DuckDBMigrationsBackfillNoIndex`.
- `scripts/backfill/finish_backfill.sh`
  Header + 02d banner updated to reflect verify-only semantics.
- `tests/v3-schema.test.ts`
  Pins BOTH invariants: prod DDL has 3 activity indexes + UNIQUE works;
  backfill migration skips them and permits duplicate inserts.
- `CODEBASE_GUIDE.md`
  New pitfall entry + rev3 section.

## Test results

```
# tests 247
# pass 247
# fail 0
```

`tsc --noEmit` clean.

## Runbook

On the Hetzner box:

```bash
export DUCKDB_PATH=/mnt/HC_Volume_105468668/discovery_v3.duckdb
export DUCKDB_MEMORY_LIMIT_GB=6
export DUCKDB_THREADS=2
export DUCKDB_TEMP_DIR=/mnt/HC_Volume_105468668/duckdb_tmp
export DUCKDB_MAX_TEMP_DIR_GB=60
export SORTED_PARQUET_DIR=/mnt/HC_Volume_105468668/bucket_parquets

# 1. Pre-flight: ensure old DB paths are gone
rm -f /mnt/HC_Volume_105468668/discovery_v3.duckdb*
rm -f /mnt/HC_Volume_105468668/repo-v3/data/discovery_v3.duckdb*

# 2. If any of buckets 0000..0054 are missing (see summary — rev2
#    contamination cleanup left only 0055..0063), regenerate them via
#    the usual 02a path from cwd=repo-v3.

# 3. Execute the full finish flow with a log.
cd /mnt/HC_Volume_105468668/repo-v3
bash scripts/backfill/finish_backfill.sh 2>&1 | tee /tmp/finish-$(date -u +%Y%m%dT%H%M%SZ).log
```

Expected signals:
- `[02c] bucket N dedup-merged ... cumulative activity rows (DEDUPED): X`
  for each bucket — the word `DEDUPED` confirms rev2 dedup path.
- `[02d] total rows: ~800M` followed by `[02d] dupe scan complete ... 0
  duplicate key groups` and `[02d] NOTE: ART indexes intentionally NOT
  created.`
- 03/04/05/06 proceed normally. 04 writes `discovery_feature_snapshots_v3`.
