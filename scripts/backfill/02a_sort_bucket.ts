/**
 * Phase 1.5 step 2a: sort ONE hash bucket of users.parquet to its own parquet.
 *
 * One invocation = one bucket = one fresh node process. The runner script
 * (run_backfill_FINAL.sh) calls this once per bucket. Benefits vs looping
 * inside a single node process:
 *
 *   - Each bucket starts with a clean DuckDB buffer manager. No accumulated
 *     pinned pages from prior buckets \u2014 avoids the "failed to pin block"
 *     commit OOMs we hit when looping inside one process.
 *   - Resumable: the runner can skip buckets whose output parquet already
 *     exists. A bucket failure restarts from that bucket, not from scratch.
 *   - No committed rows in discovery_activity_v3 until the final merge step,
 *     so the DB stays small until the end.
 *
 * Flags:
 *   --bucket B          (required) which bucket to produce, 0 <= B < N
 *   --total N           (required) total number of buckets
 *   --out PATH          (required) output parquet path for this bucket
 *   --limit N           optional row cap (sandbox sampling)
 *   --source-url URL    optional httpfs parquet URL; defaults to ./data/users.parquet
 *   --force             overwrite an existing output parquet
 */
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { buildSortBucketFromParquetToParquetSql } from '../../src/discovery/v3/backfillQueries.js';

interface Args {
  bucket: number;
  total: number;
  out: string;
  limit?: number;
  sourceUrl?: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bucket') out.bucket = Number(argv[++i]);
    else if (a === '--total') out.total = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--source-url') out.sourceUrl = argv[++i];
    else if (a === '--force') out.force = true;
  }
  if (typeof out.bucket !== 'number' || !Number.isInteger(out.bucket))
    throw new Error('--bucket is required');
  if (typeof out.total !== 'number' || !Number.isInteger(out.total) || out.total < 1)
    throw new Error('--total must be a positive integer');
  if (out.bucket < 0 || out.bucket >= out.total)
    throw new Error(`--bucket must be in [0, ${out.total}), got ${out.bucket}`);
  if (!out.out) throw new Error('--out is required');
  return out as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(args.out), { recursive: true });

  if (existsSync(args.out)) {
    if (!args.force) {
      const sz = statSync(args.out).size;
      console.log(`[02a] bucket ${args.bucket}/${args.total} output already exists at ${args.out} (${(sz / 1e9).toFixed(2)} GB), skipping (use --force to overwrite)`);
      return;
    }
    console.log(`[02a] --force: removing existing ${args.out}`);
    unlinkSync(args.out);
  }

  const localPath = './data/users.parquet';
  const sourceRef = args.sourceUrl
    ? `read_parquet('${args.sourceUrl}')`
    : existsSync(localPath)
      ? `read_parquet('${localPath}')`
      : `read_parquet('${localPath}')`;

  // Use an in-memory DuckDB connection. We only need the parquet reader +
  // external sort \u2014 no persistent state lives past this process.
  const db = openDuckDB(':memory:');
  try {
    await db.exec('INSTALL httpfs; LOAD httpfs;');
    const t0 = Date.now();
    console.log(`[02a] bucket ${args.bucket + 1}/${args.total}: sort direct from ${sourceRef} \u2192 ${args.out}`);
    await db.exec(
      buildSortBucketFromParquetToParquetSql(args.bucket, args.total, sourceRef, args.out, args.limit)
    );
    const bytes = statSync(args.out).size;
    console.log(`[02a] bucket ${args.bucket + 1}/${args.total} done in ${Math.round((Date.now() - t0) / 1000)}s \u2014 ${(bytes / 1e9).toFixed(2)} GB`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[02a] failed:', err);
  process.exit(1);
});
