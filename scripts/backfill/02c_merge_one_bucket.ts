/**
 * Phase 1.5 step 2c: load ONE sorted bucket parquet into discovery_activity_v3
 * with BUCKET-LOCAL DEDUP. Because 02a bucketizes on `abs(hash(tx_hash)) % N`,
 * all copies of a given (tx_hash, log_index) live in the same bucket, so
 * per-bucket dedup is mathematically equivalent to global dedup. This
 * eliminates the need for a global CTAS dedup at the end, which at
 * production scale (956M rows) blows the temp-directory budget.
 *
 * Why not INSERT with GROUP BY into an INDEXED table: DuckDB's bulk
 * aggregate-insert + unique-index-maintenance pipeline raises spurious
 * Duplicate key errors at scale (duckdb#11102 / #16520). We therefore:
 *   - keep the target table INDEX-FREE during backfill (02a migration variant)
 *   - INSERT deduped rows per bucket here
 *   - create the UNIQUE + aux indexes once, AFTER all buckets are loaded
 *     (02d_dedup_and_index.ts — which is now a "build indexes" step only;
 *     the CTAS dedup is no longer needed because rows arrive pre-deduped).
 *
 * Preconditions: the target DB schema must have been created via
 * `runV3DuckDBMigrationsBackfillNoIndex` so `discovery_activity_v3` has NO
 * UNIQUE/auxiliary indexes. The orchestrator script guarantees that.
 *
 * One invocation = one bucket dedup-insert + checkpoint + exit. The launcher
 * loops over buckets and calls this per bucket. Fresh buffer manager every
 * iteration bounds spill to one bucket's GROUP BY state.
 *
 * Flags:
 *   --bucket B          (required) which bucket index to merge, 0..N-1
 *   --path PATH         (required) parquet path for this bucket
 *   --keep              keep the parquet after merge (default: delete)
 */
import { existsSync, statSync, unlinkSync } from 'fs';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrationsBackfillNoIndex } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { buildSortedParquetToActivityDedupedSql } from '../../src/discovery/v3/backfillQueries.js';

function parseArgs(argv: string[]): { bucket: number; path: string; keep: boolean } {
  let bucket: number | undefined;
  let path: string | undefined;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bucket') bucket = Number(argv[++i]);
    else if (a === '--path') path = argv[++i];
    else if (a === '--keep') keep = true;
  }
  if (typeof bucket !== 'number' || !Number.isInteger(bucket) || bucket < 0)
    throw new Error('--bucket is required (non-negative integer)');
  if (!path) throw new Error('--path is required');
  return { bucket, path, keep };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.path)) {
    console.error(`[02c] bucket ${args.bucket}: parquet missing at ${args.path}`);
    process.exit(2);
  }
  const sz = statSync(args.path).size;
  if (sz === 0) {
    console.error(`[02c] bucket ${args.bucket}: parquet is zero bytes (corrupt), skipping-with-fail`);
    process.exit(3);
  }

  const db = openDuckDB(getDuckDBPath());
  try {
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => db.exec(sql));

    // Defensive: if a prior run left unique/aux indexes on this DB, drop them
    // now so this RAW insert can never hit the buggy constraint-check path.
    // Indexes are rebuilt by 02d_dedup_and_index.ts at the end of Phase B.
    await db.exec('DROP INDEX IF EXISTS idx_activity_v3_dedup');
    await db.exec('DROP INDEX IF EXISTS idx_activity_v3_wallet_ts');
    await db.exec('DROP INDEX IF EXISTS idx_activity_v3_market_ts');

    const t0 = Date.now();
    await db.exec(buildSortedParquetToActivityDedupedSql(args.path));
    await db.exec('CHECKPOINT');
    const after = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'))[0].c;
    console.log(
      `[02c] bucket ${args.bucket} dedup-merged in ${Math.round((Date.now() - t0) / 1000)}s` +
      ` \u2014 parquet ${(sz / 1e9).toFixed(2)} GB, cumulative activity rows (DEDUPED): ${after}`
    );
  } finally {
    await db.close();
  }
  if (!args.keep) unlinkSync(args.path);
}

main().catch((err) => {
  console.error('[02c] failed:', err);
  process.exit(1);
});
