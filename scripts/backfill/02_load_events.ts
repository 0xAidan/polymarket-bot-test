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
import { buildEventIngestSqlAntiJoin, buildEventIngestSqlAntiJoinChunked } from '../../src/discovery/v3/backfillQueries.js';
import { isEligible } from '../../src/discovery/v3/eligibility.js';

function parseArgs(argv: string[]): { limit?: number; sourceUrl?: string; sampleReport: boolean; buckets: number } {
  const out: { limit?: number; sourceUrl?: string; sampleReport: boolean; buckets: number } = { sampleReport: false, buckets: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--source-url') out.sourceUrl = argv[++i];
    else if (a === '--sample-report') out.sampleReport = true;
    else if (a === '--buckets') out.buckets = Math.max(1, Number(argv[++i]) || 1);
  }
  const envBuckets = Number(process.env.DUCKDB_INGEST_BUCKETS);
  if (!Number.isNaN(envBuckets) && envBuckets > 1 && out.buckets === 1) out.buckets = Math.floor(envBuckets);
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
    if (args.buckets <= 1) {
      await db.exec(buildEventIngestSqlAntiJoin(sourceRef, args.limit));
    } else {
      console.log(`[02] chunked ingest: ${args.buckets} buckets (reduces temp-directory spill by ~${args.buckets}x)`);
      for (let b = 0; b < args.buckets; b++) {
        const tb = Date.now();
        const sql = buildEventIngestSqlAntiJoinChunked(sourceRef, b, args.buckets, args.limit);
        await db.exec(sql);
        const cur = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'))[0].c;
        console.log(`[02] bucket ${b + 1}/${args.buckets} done in ${Math.round((Date.now() - tb) / 1000)}s — total rows: ${cur}`);
      }
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
