/**
 * Phase 1.5 step 2d: dedup discovery_activity_v3 and rebuild indexes.
 *
 * Must be run AFTER all 64 bucket parquets have been raw-inserted via
 * 02c_merge_one_bucket.ts. The table at this point contains duplicate
 * (tx_hash, log_index) rows (cross-bucket collisions and within-bucket
 * repeats).
 *
 * Steps:
 *   1. CREATE TABLE discovery_activity_v3_dedup AS
 *        SELECT arg_min(col, ts_unix) ... FROM discovery_activity_v3
 *        GROUP BY tx_hash, log_index
 *   2. DROP TABLE discovery_activity_v3
 *   3. ALTER TABLE ..._dedup RENAME TO discovery_activity_v3
 *   4. CREATE UNIQUE INDEX idx_activity_v3_dedup (tx_hash, log_index)
 *   5. CREATE INDEX idx_activity_v3_wallet_ts, idx_activity_v3_market_ts
 *   6. CHECKPOINT
 *
 * Why this works when the old single-step INSERT+dedup+index path did NOT:
 *   - Step 1 writes to a brand-new table with no indexes — DuckDB's buggy
 *     "unique index maintenance during streaming aggregate insert" path is
 *     never triggered.
 *   - Step 4 builds the unique index on already-deduped data so it cannot
 *     report a false-positive duplicate.
 *
 * Flags:
 *   --dry-run    Print pre-dedup/post-dedup row counts without altering
 *                the DB (useful to verify the CTAS result before committing).
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import {
  ACTIVITY_DEDUP_SWAP_SQL,
  buildActivityDedupCtasSql,
} from '../../src/discovery/v3/backfillQueries.js';
import { buildActivityIndexSqlList } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const db = openDuckDB(getDuckDBPath());
  try {
    const pre = (
      await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3')
    )[0].c;
    console.log(`[02d] pre-dedup rows: ${pre}`);

    // Clean slate for the ephemeral dedup table in case a prior attempt left it.
    await db.exec('DROP TABLE IF EXISTS discovery_activity_v3_dedup');

    const t0 = Date.now();
    console.log('[02d] building dedup CTAS …');
    await db.exec(buildActivityDedupCtasSql());
    await db.exec('CHECKPOINT');
    const post = (
      await db.query<{ c: number }>(
        'SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3_dedup'
      )
    )[0].c;
    console.log(
      `[02d] post-dedup rows: ${post} (dropped ${pre - post} duplicate rows in ${Math.round(
        (Date.now() - t0) / 1000
      )}s)`
    );

    if (dryRun) {
      console.log('[02d] --dry-run: leaving both tables in place, exiting');
      return;
    }

    console.log('[02d] swapping deduped table into place …');
    for (const sql of ACTIVITY_DEDUP_SWAP_SQL) await db.exec(sql);
    await db.exec('CHECKPOINT');

    console.log('[02d] rebuilding indexes …');
    for (const sql of buildActivityIndexSqlList()) {
      const ti = Date.now();
      await db.exec(sql);
      console.log(`[02d]   index built in ${Math.round((Date.now() - ti) / 1000)}s: ${sql}`);
    }
    await db.exec('CHECKPOINT');

    const final = (
      await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3')
    )[0].c;
    console.log(`[02d] final row count: ${final}`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[02d] failed:', err);
  process.exit(1);
});
