/**
 * Larger-scale smoke test of the no-index-during-load path. Not part of the
 * default test run (file name lacks .test.ts) — run manually with:
 *
 *   npx tsx tests/v3-backfill-scale-integration.ts
 *
 * Generates a 2M-row sorted bucket parquet with ~600 duplicate keys, then
 * exercises:
 *   1. runV3DuckDBMigrationsBackfillNoIndex (creates table, NO indexes)
 *   2. buildSortedParquetToActivityRawSql (RAW insert, no GROUP BY)
 *   3. buildActivityDedupCtasSql (CTAS dedup into _dedup)
 *   4. ACTIVITY_DEDUP_SWAP_SQL (drop + rename)
 *   5. buildActivityIndexSqlList (create UNIQUE + aux indexes)
 *
 * At this scale, the old INSERT+GROUP BY path into an indexed table is the
 * exact code path that failed in production with spurious Duplicate key
 * errors. We DO NOT run the old path here (it's @deprecated) but the new
 * path must complete cleanly and produce the correct deduped row count.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDuckDB } from '../src/discovery/v3/duckdbClient.js';
import {
  ACTIVITY_DEDUP_SWAP_SQL,
  buildActivityDedupCtasSql,
  buildSortedParquetToActivityRawSql,
} from '../src/discovery/v3/backfillQueries.js';
import {
  buildActivityIndexSqlList,
  runV3DuckDBMigrationsBackfillNoIndex,
} from '../src/discovery/v3/duckdbSchema.js';

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'v3-scale-'));
  const parquet = join(tmp, 'bucket.parquet');
  const dbPath = join(tmp, 'scale.duckdb');
  const N = 2_000_000;
  const DUPES = 600;

  // --- Generate the sorted bucket parquet in a throwaway in-memory DB ---
  const gen = openDuckDB(':memory:');
  try {
    await gen.exec(`CREATE TABLE bucket AS
      SELECT
        'u' || ((i * 31) % 1000)::VARCHAR AS "user",
        'm' || ((i * 17) % 500)::VARCHAR AS market_id,
        'c' || ((i * 13) % 500)::VARCHAR AS condition_id,
        'e' || ((i * 7) % 200)::VARCHAR AS event_id,
        CAST(1700000000 + i AS BIGINT) AS timestamp,
        CAST(i AS BIGINT) AS block_number,
        LPAD(TO_HEX(i * 1234567), 64, '0') AS transaction_hash,
        CAST(i % 2000 AS INTEGER) AS log_index,
        'taker' AS role,
        (random() * 0.99 + 0.005)::DOUBLE AS price,
        (random() * 100 + 1)::DOUBLE AS usd_amount,
        CASE WHEN random() > 0.5 THEN 10.0 ELSE -10.0 END AS token_amount
      FROM range(${N}) t(i);`);
    // Inject duplicates: within-bucket dupes + within-bucket differing-ts rows
    await gen.exec(`INSERT INTO bucket SELECT * FROM bucket USING SAMPLE ${DUPES}`);
    await gen.exec(`INSERT INTO bucket
      SELECT 'u_other', market_id, condition_id, event_id, timestamp + 1, block_number + 1,
             transaction_hash, log_index, role, price, usd_amount, token_amount
      FROM bucket USING SAMPLE ${DUPES}`);
    await gen.exec(`COPY (SELECT * FROM bucket ORDER BY transaction_hash, log_index, timestamp)
      TO '${parquet}' (FORMAT PARQUET, COMPRESSION SNAPPY)`);
    const totalInParquet = (
      await gen.query<{ c: number }>(`SELECT COUNT(*)::BIGINT AS c FROM read_parquet('${parquet}')`)
    )[0].c;
    const distinctKeys = (
      await gen.query<{ c: number }>(
        `SELECT COUNT(*)::BIGINT AS c FROM (SELECT DISTINCT transaction_hash, log_index FROM read_parquet('${parquet}'))`
      )
    )[0].c;
    console.log(`[scale] parquet written: total=${totalInParquet}, distinct_keys=${distinctKeys}`);

    // --- Exercise the new path on disk (so CHECKPOINT + indexes are real) ---
    const db = openDuckDB(dbPath);
    try {
      await runV3DuckDBMigrationsBackfillNoIndex((sql) => db.exec(sql));

      const t1 = Date.now();
      await db.exec(buildSortedParquetToActivityRawSql(parquet));
      await db.exec('CHECKPOINT');
      const pre = (
        await db.query<{ c: number }>(`SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3`)
      )[0].c;
      console.log(
        `[scale] raw insert done in ${Math.round((Date.now() - t1) / 1000)}s, pre-dedup rows=${pre}`
      );

      const t2 = Date.now();
      await db.exec('DROP TABLE IF EXISTS discovery_activity_v3_dedup');
      await db.exec(buildActivityDedupCtasSql());
      await db.exec('CHECKPOINT');
      const post = (
        await db.query<{ c: number }>(
          `SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3_dedup`
        )
      )[0].c;
      console.log(
        `[scale] dedup CTAS done in ${Math.round((Date.now() - t2) / 1000)}s, post-dedup rows=${post}`
      );
      if (post !== distinctKeys) {
        throw new Error(`dedup row count ${post} does not match distinct key count ${distinctKeys}`);
      }

      const t3 = Date.now();
      for (const sql of ACTIVITY_DEDUP_SWAP_SQL) await db.exec(sql);
      await db.exec('CHECKPOINT');
      for (const sql of buildActivityIndexSqlList()) await db.exec(sql);
      await db.exec('CHECKPOINT');
      console.log(`[scale] swap + index rebuild done in ${Math.round((Date.now() - t3) / 1000)}s`);

      // Sanity: inserting a duplicate row now MUST raise.
      try {
        await db.exec(
          `INSERT INTO discovery_activity_v3
           SELECT * FROM discovery_activity_v3 LIMIT 1`
        );
        throw new Error('BUG: duplicate insert did not raise after index rebuild');
      } catch (err) {
        const msg = String(err);
        if (!/Constraint|Duplicate/i.test(msg)) throw err;
        console.log('[scale] unique constraint enforced correctly on post-load INSERT');
      }

      console.log('[scale] OK');
    } finally {
      await db.close();
    }
  } finally {
    await gen.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[scale] FAILED:', err);
  process.exit(1);
});
