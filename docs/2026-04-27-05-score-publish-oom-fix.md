# 05_score_and_publish OOM Fix - 2026-04-27

**Branch:** fix/05-score-publish-oom
**Status:** Ready for merge

## Problem

Running `npx tsx --env-file=.env scripts/backfill/05_score_and_publish.ts` on the
8 GB Hetzner staging box OOM'd with:

```
[05] selecting latest snapshot per wallet...
[05] failed: Out of Memory Error: could not allocate block of size 256.0 KiB (5.5 GiB/5.5 GiB used)
  code: 'DUCKDB_NODEJS_ERROR', errorType: 'Out of Memory'
```

Changing DUCKDB_MEMORY_LIMIT_GB or other env vars did NOT fix this.
This was a query-shape problem, not a config problem.

## Root Cause

The original script used `duck.query()` to load the ENTIRE snapshot result set
into Node heap via a window function query:

  SELECT *, ROW_NUMBER() OVER (PARTITION BY proxy_wallet ORDER BY snapshot_day DESC)
  FROM discovery_feature_snapshots_v3

ROW_NUMBER() forces DuckDB to materialise the full working set in RAM before
returning a single row. With millions of wallet rows, this exhausts the memory
limit before any data reaches Node. Adjusting memory limits cannot fix this -
raising it is impossible on 8 GB, lowering it makes it OOM sooner.

## Fix

The script was rewritten to use a 3-step streaming approach:

1. COPY the deduped latest-snapshot rows to a temp Parquet file using DuckDB's
   native streaming COPY path. This spills to disk (respecting DUCKDB_MAX_TEMP_DIR_GB)
   instead of materialising in RAM.

2. Batch-read from the Parquet file: Node heap holds at most SCORE_BATCH_SIZE rows
   (default 5000) at once. Full wallet universe is never loaded into Node memory.

3. Score each batch in TypeScript and upsert into SQLite.

4. Delete temp Parquet in finally{} block regardless of success/failure.

## Env Vars Required on 8 GB Box

  DUCKDB_MEMORY_LIMIT_GB=3
  DUCKDB_MAX_TEMP_DIR_GB=20
  DUCKDB_THREADS=2
  SCORE_BATCH_SIZE=5000  (optional, default is 5000)

Previously DUCKDB_MAX_TEMP_DIR_GB was irrelevant for step 05 because the query
never reached the spill path - it OOM'd first. Now it controls the COPY spill
and MUST be set.

## Run Command (staging)

  DUCKDB_MEMORY_LIMIT_GB=3 DUCKDB_MAX_TEMP_DIR_GB=20 DUCKDB_THREADS=2 \
    npx tsx --env-file=.env scripts/backfill/05_score_and_publish.ts

## Do's and Don'ts for Future Agents

- DO ensure DUCKDB_MAX_TEMP_DIR_GB is set before running any backfill step that
  does large sorts/partitions on the 8 GB Hetzner box.
- DO NOT use duck.query() to load multi-million-row result sets into Node heap.
  Use COPY-to-Parquet + batched reads for any heavy DuckDB query.
- DO NOT re-introduce a single duck.query() call for the full snapshot select.
  This will always OOM on the current hardware.
- Script is idempotent - safe to re-run. It deletes all scores before writing.
