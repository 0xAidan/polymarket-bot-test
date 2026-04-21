/**
 * Phase 1.5 step 2: load users.parquet → discovery_activity_v3.
 *
 * Flags:
 *   --limit N               cap rows (sandbox sampling)
 *   --source-url URL        read parquet via httpfs instead of ./data/users.parquet
 *   --sample-report         print schema + first few rows + eligibility-gate dry run
 */
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrations } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import {
  buildEventIngestSqlAntiJoin,
  buildEventIngestSqlAntiJoinChunked,
  buildStagingCreateSql,
  buildStagingDropSql,
  buildStagingIngestSql,
  buildStagingSortToParquetSql,
  buildStagingSortBucketToParquetSql,
  buildSortedParquetToActivitySql,
} from '../../src/discovery/v3/backfillQueries.js';
import { existsSync as fileExists, unlinkSync, statSync } from 'fs';
import { isEligible } from '../../src/discovery/v3/eligibility.js';

type Mode = 'legacy' | 'chunked' | 'staging';

function parseArgs(argv: string[]): {
  limit?: number;
  sourceUrl?: string;
  sampleReport: boolean;
  buckets: number;
  mode: Mode;
} {
  const out: {
    limit?: number;
    sourceUrl?: string;
    sampleReport: boolean;
    buckets: number;
    mode: Mode;
  } = { sampleReport: false, buckets: 1, mode: 'staging' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--source-url') out.sourceUrl = argv[++i];
    else if (a === '--sample-report') out.sampleReport = true;
    else if (a === '--buckets') out.buckets = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--mode') {
      const m = argv[++i];
      if (m === 'legacy' || m === 'chunked' || m === 'staging') out.mode = m;
      else throw new Error(`--mode must be legacy|chunked|staging, got ${m}`);
    }
  }
  const envBuckets = Number(process.env.DUCKDB_INGEST_BUCKETS);
  if (!Number.isNaN(envBuckets) && envBuckets > 1 && out.buckets === 1) out.buckets = Math.floor(envBuckets);
  if (out.buckets > 1 && out.mode === 'staging') out.mode = 'chunked';
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = getDuckDBPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const localPath = './data/users.parquet';
  const sourceRef =
    args.sourceUrl
      ? `read_parquet('${args.sourceUrl}')`
      : existsSync(localPath)
        ? `read_parquet('${localPath}')`
        : null;

  if (!sourceRef) {
    console.error(
      `[02] no source: ${localPath} missing and --source-url not provided.\n` +
        `    run 00_fetch_parquet.ts, or pass --source-url https://huggingface.co/datasets/SII-WANGZJ/Polymarket_data/resolve/main/users.parquet`
    );
    process.exit(2);
  }

  console.log(`[02] source: ${sourceRef}, dest duckdb: ${dbPath}, limit: ${args.limit ?? 'unlimited'}`);
  const db = openDuckDB(dbPath);
  try {
    await db.exec("INSTALL httpfs; LOAD httpfs;");
    await runV3DuckDBMigrations((sql) => db.exec(sql));

    const before = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'))[0].c;
    console.log(`[02] existing rows in discovery_activity_v3: ${before}`);

    const t0 = Date.now();
    if (args.mode === 'legacy') {
      console.log('[02] mode=legacy (single anti-join, OOM-prone at scale)');
      await db.exec(buildEventIngestSqlAntiJoin(sourceRef, args.limit));
    } else if (args.mode === 'chunked') {
      console.log(`[02] mode=chunked, ${args.buckets} buckets`);
      for (let b = 0; b < args.buckets; b++) {
        const tb = Date.now();
        const sql = buildEventIngestSqlAntiJoinChunked(sourceRef, b, args.buckets, args.limit);
        await db.exec(sql);
        const cur = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'))[0].c;
        console.log(`[02] bucket ${b + 1}/${args.buckets} done in ${Math.round((Date.now() - tb) / 1000)}s — total rows: ${cur}`);
      }
    } else {
      // mode=staging: bucketed sort-based ingest
      //   Phase A : parquet → staging_events_v3 (streaming, bounded RAM)
      //   Phase B : for each of N hash buckets on transaction_hash:
      //               - COPY (sorted bucket slice) → sorted_B.parquet
      //               - INSERT LAG-deduped rows → discovery_activity_v3
      //               - rm sorted_B.parquet
      //
      // Why bucket: 900M+ rows need ~100 GB of sort spill, which does not fit
      // on the 93 GB production volume beside users.parquet + the staging DB.
      // Splitting into N=64 buckets keeps per-bucket sort state at ~1.5 GB.
      //
      // Correctness: abs(hash(transaction_hash)) % N is deterministic, so all
      // rows that share a transaction_hash (and therefore all duplicate
      // (tx_hash, log_index) pairs) land in the same bucket. Per-bucket
      // LAG-dedup on sorted input is therefore equivalent to global dedup.
      const totalBuckets = Math.max(1, Number(process.env.DUCKDB_SORT_BUCKETS) || 64);
      console.log(`[02] mode=staging (bucketed: stage → ${totalBuckets}× [sort → LAG dedup → rm])`);

      const sortedParquetDir = process.env.SORTED_PARQUET_DIR
        || process.env.DUCKDB_TEMP_DIR
        || './data';
      const bucketParquetPath = (b: number) => `${sortedParquetDir}/sorted_events_bucket_${String(b).padStart(4, '0')}.parquet`;

      // Clean up any stale bucket parquets from a prior failed run.
      for (let b = 0; b < totalBuckets; b++) {
        const p = bucketParquetPath(b);
        if (fileExists(p)) {
          console.log(`[02] removing stale ${p}`);
          unlinkSync(p);
        }
      }
      // Also remove a legacy single sorted parquet if present.
      const legacySortedParquet = process.env.SORTED_PARQUET_PATH
        || `${sortedParquetDir}/sorted_events.parquet`;
      if (fileExists(legacySortedParquet)) {
        console.log(`[02] removing stale ${legacySortedParquet}`);
        unlinkSync(legacySortedParquet);
      }

      await db.exec(buildStagingDropSql());
      await db.exec(buildStagingCreateSql());

      const tA = Date.now();
      console.log('[02] phase A: streaming parquet → staging_events_v3 ...');
      await db.exec(buildStagingIngestSql(sourceRef, args.limit));
      const stagedRows = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM staging_events_v3'))[0].c;
      console.log(`[02] phase A done in ${Math.round((Date.now() - tA) / 1000)}s — staged ${stagedRows} rows`);

      const tB = Date.now();
      console.log(`[02] phase B: sorting + dedup — ${totalBuckets} buckets ...`);
      for (let b = 0; b < totalBuckets; b++) {
        const bucketPath = bucketParquetPath(b);
        const tb0 = Date.now();

        await db.exec(buildStagingSortBucketToParquetSql(b, totalBuckets, bucketPath));
        const bucketBytes = statSync(bucketPath).size;

        await db.exec(buildSortedParquetToActivitySql(bucketPath));

        if (fileExists(bucketPath)) unlinkSync(bucketPath);

        const after = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'))[0].c;
        console.log(
          `[02]   bucket ${b + 1}/${totalBuckets} done in ${Math.round((Date.now() - tb0) / 1000)}s` +
          ` — parquet ${(bucketBytes / 1e9).toFixed(2)} GB, total activity rows: ${after}`
        );
      }
      console.log(`[02] phase B done in ${Math.round((Date.now() - tB) / 1000)}s`);

      console.log('[02] dropping staging_events_v3 to reclaim disk ...');
      await db.exec(buildStagingDropSql());
      await db.exec('CHECKPOINT');
    }
    const after = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'))[0].c;
    const inserted = Number(after) - Number(before);
    console.log(`[02] inserted ${inserted} rows in ${Math.round((Date.now() - t0) / 1000)}s`);

    if (args.sampleReport) {
      const sample = await db.query(
        `SELECT proxy_wallet, market_id, ts_unix, role, side, price_yes, usd_notional, signed_size
           FROM discovery_activity_v3 ORDER BY ts_unix DESC LIMIT 5`
      );
      console.log('[02] sample rows:');
      for (const row of sample) console.log('   ', JSON.stringify(row));

      const perWallet = await db.query<{
        proxy_wallet: string;
        trade_count: number;
        distinct_markets: number;
        first_ts: number;
        last_ts: number;
      }>(`SELECT proxy_wallet,
                 COUNT(*)::BIGINT              AS trade_count,
                 COUNT(DISTINCT market_id)::BIGINT AS distinct_markets,
                 MIN(ts_unix)::BIGINT          AS first_ts,
                 MAX(ts_unix)::BIGINT          AS last_ts
            FROM discovery_activity_v3 GROUP BY proxy_wallet`);

      const now = Math.floor(Date.now() / 1000);
      let eligibleCount = 0;
      for (const w of perWallet) {
        const span = (Number(w.last_ts) - Number(w.first_ts)) / 86400;
        const r = isEligible({
          observation_span_days: span,
          distinct_markets: Number(w.distinct_markets),
          trade_count: Number(w.trade_count),
          closed_positions: 5, // not computable without markets — optimistic assumption for dry run
          last_active_ts: Number(w.last_ts),
          now_ts: now,
        });
        if (r.eligible) eligibleCount++;
      }
      const total = perWallet.length;
      const rejRate = total === 0 ? 0 : 1 - eligibleCount / total;
      console.log(`[02] sample eligibility dry-run: ${eligibleCount}/${total} (rejection rate ${(rejRate * 100).toFixed(1)}%, closed_positions gate bypassed)`);
    }
  } finally {
    await db.close();
  }
  console.log('[02] done.');
}

main().catch((err) => {
  console.error('[02] failed:', err);
  process.exit(1);
});
