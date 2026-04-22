/**
 * Phase 1.5 step 2b: merge N bucket parquets into discovery_activity_v3.
 *
 * Reads every sorted bucket parquet and streams LAG-deduped rows into the
 * live DuckDB database. Each bucket is handled in ONE INSERT so we don't
 * accumulate commit-time buffer pressure across buckets the way we did
 * when the sort + insert was looped inside a single process.
 *
 * Flags:
 *   --total N           (required) total number of buckets in the full run
 *   --dir PATH          directory containing sorted_events_bucket_NNNN.parquet
 *                       (defaults to $SORTED_PARQUET_DIR or ./data)
 *   --keep              keep bucket parquets after merging (default: delete)
 *   --partial           merge ONLY buckets that currently exist on disk.
 *                       Without this flag, 02b refuses to run if any of the
 *                       0..total-1 buckets is missing (safety). Use --partial
 *                       to free disk mid-run: merge what's there, delete them,
 *                       re-run 02a to fill the gaps, then run 02b again.
 *                       Correctness holds because hash-partitioning guarantees
 *                       all duplicates of a key land in the same bucket, so
 *                       per-bucket LAG dedup is equivalent to global dedup
 *                       regardless of merge order.
 */
import { existsSync, statSync, unlinkSync } from 'fs';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrations } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { buildSortedParquetToActivitySql } from '../../src/discovery/v3/backfillQueries.js';

function parseArgs(argv: string[]): { total: number; dir: string; keep: boolean; partial: boolean } {
  let total: number | undefined;
  let dir: string | undefined;
  let keep = false;
  let partial = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--total') total = Number(argv[++i]);
    else if (a === '--dir') dir = argv[++i];
    else if (a === '--keep') keep = true;
    else if (a === '--partial') partial = true;
  }
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 1)
    throw new Error('--total must be a positive integer');
  const resolvedDir = dir || process.env.SORTED_PARQUET_DIR || process.env.DUCKDB_TEMP_DIR || './data';
  return { total, dir: resolvedDir, keep, partial };
}

function bucketPath(dir: string, b: number): string {
  return `${dir}/sorted_events_bucket_${String(b).padStart(4, '0')}.parquet`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = getDuckDBPath();

  // Which buckets exist on disk right now?
  const present: number[] = [];
  const missing: number[] = [];
  for (let b = 0; b < args.total; b++) {
    if (existsSync(bucketPath(args.dir, b))) present.push(b);
    else missing.push(b);
  }

  if (!args.partial && missing.length > 0) {
    // Full-run safety: refuse to merge a partial set to avoid silently producing
    // a backfill with missing rows. Pass --partial to override (intentional
    // mid-run disk-relief merge).
    console.error(`[02b] refusing to merge: missing ${missing.length} bucket parquets in ${args.dir}:`);
    console.error(`[02b]   ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}`);
    console.error(`[02b] re-run 02a for those buckets, then retry 02b.`);
    console.error(`[02b] OR pass --partial to merge only the ${present.length} buckets that exist now`);
    console.error(`[02b]    (safe: hash-partition means all dupes of a key are in the same bucket,`);
    console.error(`[02b]     so merging in any order across multiple 02b runs is equivalent).`);
    process.exit(2);
  }

  if (present.length === 0) {
    console.error(`[02b] no bucket parquets found in ${args.dir}; nothing to merge`);
    process.exit(2);
  }

  const db = openDuckDB(dbPath);
  try {
    await runV3DuckDBMigrations((sql) => db.exec(sql));

    const before = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'))[0].c;
    console.log(`[02b] existing rows in discovery_activity_v3: ${before}`);
    if (args.partial) {
      console.log(
        `[02b] PARTIAL merge: ${present.length}/${args.total} bucket parquets present in ${args.dir}`
      );
      if (missing.length > 0) {
        const preview = missing.slice(0, 20).join(', ') + (missing.length > 20 ? ', ...' : '');
        console.log(`[02b]   missing (will be filled by later 02a/02b runs): ${preview}`);
      }
    } else {
      console.log(`[02b] merging ALL ${args.total} bucket parquets from ${args.dir} ...`);
    }

    const tTotal = Date.now();
    let mergedCount = 0;
    for (const b of present) {
      const path = bucketPath(args.dir, b);
      const sz = statSync(path).size;
      const tb = Date.now();
      await db.exec(buildSortedParquetToActivitySql(path));
      await db.exec('CHECKPOINT');
      const after = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'))[0].c;
      mergedCount++;
      console.log(
        `[02b]   bucket ${b} (${mergedCount}/${present.length}) merged in ${Math.round((Date.now() - tb) / 1000)}s` +
        ` \u2014 parquet ${(sz / 1e9).toFixed(2)} GB, total activity rows: ${after}`
      );
      if (!args.keep) unlinkSync(path);
    }
    console.log(
      `[02b] ${args.partial ? 'partial ' : ''}merge done in ${Math.round((Date.now() - tTotal) / 1000)}s` +
      ` (${mergedCount} buckets)`
    );
    await db.exec('CHECKPOINT');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[02b] failed:', err);
  process.exit(1);
});
