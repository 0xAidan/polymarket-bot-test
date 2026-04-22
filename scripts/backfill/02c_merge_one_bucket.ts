/**
 * Phase 1.5 step 2c: merge ONE bucket parquet into discovery_activity_v3,
 * in a fresh node process.
 *
 * Why this exists: 02b_merge_buckets.ts does all 64 merges in one long-running
 * process, but DuckDB's buffer manager accumulates pinned pages across commits
 * within a single process, eventually hitting "failed to pin block" even with
 * generous memory_limit. Same root cause that forced 02a to go per-process.
 *
 * One invocation = one bucket merge + checkpoint + exit. The launcher loops
 * over buckets and calls this per bucket. Fresh buffer manager every iteration.
 *
 * Flags:
 *   --bucket B          (required) which bucket index to merge, 0..N-1
 *   --path PATH         (required) parquet path for this bucket
 *   --keep              keep the parquet after merge (default: delete)
 */
import { existsSync, statSync, unlinkSync } from 'fs';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrations } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { buildSortedParquetToActivitySql } from '../../src/discovery/v3/backfillQueries.js';

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
    await runV3DuckDBMigrations((sql) => db.exec(sql));
    const t0 = Date.now();
    await db.exec(buildSortedParquetToActivitySql(args.path));
    await db.exec('CHECKPOINT');
    const after = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'))[0].c;
    console.log(
      `[02c] bucket ${args.bucket} merged in ${Math.round((Date.now() - t0) / 1000)}s` +
      ` \u2014 parquet ${(sz / 1e9).toFixed(2)} GB, total activity rows: ${after}`
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
