/**
 * Phase 1.5 step 4: emit point-in-time daily snapshots into
 * discovery_feature_snapshots_v3. See `src/discovery/v3/backfillQueries.ts`
 * for the SQL. Deterministic: running twice produces identical output.
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrationsBackfillNoIndex } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { buildSnapshotEmitSql } from '../../src/discovery/v3/backfillQueries.js';

async function main(): Promise<void> {
  const db = openDuckDB(getDuckDBPath());
  try {
    // Use the no-index migration — the backfilled discovery_activity_v3
    // has ~800M rows and DuckDB 1.4.x CREATE INDEX would OOM.
    // See src/discovery/v3/duckdbSchema.ts for the full rationale.
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => db.exec(sql));

    // 04 is the heaviest query in the pipeline: it does a full-table scan
    // + hash join over ~912M activity rows. On the 8GB Hetzner box the
    // prior run OOM'd after spilling >55 GiB of temp. The three knobs
    // below are DuckDB's own recommendations for large INSERT…SELECT
    // (see duckdb.org/docs/stable/guides/performance/how_to_tune_workloads):
    //   1. preserve_insertion_order=false  — lets DuckDB stream
    //      intermediate results instead of buffering them in insertion
    //      order (huge memory win for this shape of query).
    //   2. max_temp_directory_size=100GiB  — raise the spill cap from
    //      the auto-default so large hash-join materialisation can
    //      spill freely on the 66–90 GB free tier.
    //   3. threads=2 (already via DUCKDB_THREADS env) — fewer threads
    //      means fewer concurrent spill chunks.
    await db.exec("SET preserve_insertion_order = false");
    await db.exec("SET max_temp_directory_size = '100GiB'");

    console.log('[04] clearing old snapshots (determinism requires full rebuild)');
    await db.exec('DELETE FROM discovery_feature_snapshots_v3');
    console.log('[04] emitting snapshots… (preserve_insertion_order=false, temp cap 100GiB)');
    const t0 = Date.now();
    await db.exec(buildSnapshotEmitSql());
    const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_feature_snapshots_v3'))[0].c;
    console.log(`[04] wrote ${c} snapshot rows in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    await db.close();
  }
  console.log('[04] done.');
}

main().catch((err) => {
  console.error('[04] failed:', err);
  process.exit(1);
});
