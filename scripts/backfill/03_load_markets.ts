/**
 * Phase 1.5 step 3: load markets.parquet → markets_v3.
 *
 * `outcome_prices` is a Python-list string (`"['0.53', '0.47']"`) not JSON.
 * We rewrite single-quotes to double-quotes and map `None` → `null`.
 */
import { existsSync } from 'fs';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrationsBackfillNoIndex } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { buildMarketsIngestSql } from '../../src/discovery/v3/backfillQueries.js';

function parseArgs(argv: string[]): { limit?: number; sourceUrl?: string } {
  const out: { limit?: number; sourceUrl?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--source-url') out.sourceUrl = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const local = './data/markets.parquet';
  const sourceRef = args.sourceUrl
    ? `read_parquet('${args.sourceUrl}')`
    : existsSync(local)
      ? `read_parquet('${local}')`
      : null;
  if (!sourceRef) {
    console.error('[03] markets.parquet missing and --source-url not provided; run 00_fetch_parquet.ts');
    process.exit(2);
  }
  const db = openDuckDB(getDuckDBPath());
  try {
    await db.exec("INSTALL httpfs; LOAD httpfs;");
    // Use the no-index migration — the backfilled discovery_activity_v3
    // has ~800M rows and DuckDB 1.4.x CREATE INDEX would OOM.
    // See src/discovery/v3/duckdbSchema.ts for the full rationale.
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => db.exec(sql));
    console.log(`[03] source: ${sourceRef}`);
    const before = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM markets_v3'))[0].c;
    await db.exec('DELETE FROM markets_v3');
    await db.exec(buildMarketsIngestSql({ sourceRef, limit: args.limit }));
    const after = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM markets_v3'))[0].c;
    console.log(`[03] markets_v3: ${before} → ${after} rows`);
  } finally {
    await db.close();
  }
  console.log('[03] done.');
}

main().catch((err) => {
  console.error('[03] failed:', err);
  process.exit(1);
});
