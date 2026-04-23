/**
 * Phase 1.5 step 2d: build UNIQUE + auxiliary indexes on discovery_activity_v3.
 *
 * Must be run AFTER all 64 bucket parquets have been dedup-inserted via
 * 02c_merge_one_bucket.ts. Because 02c now does bucket-local dedup (valid
 * because 02a bucketizes on abs(hash(tx_hash)) % N so all copies of any key
 * live in one bucket), the table is already globally deduplicated on arrival
 * and no CTAS dedup step is needed. This script's sole responsibility is
 * creating the indexes the live query path expects.
 *
 * History: an earlier revision of this script did `CREATE TABLE
 * discovery_activity_v3_dedup AS SELECT ... GROUP BY tx_hash, log_index FROM
 * discovery_activity_v3` to globally dedup 956M rows at the end. That CTAS
 * exceeded the 75 GB temp-directory budget on the Hetzner 8 GB box and
 * crashed with "failed to offload data block … max_temp_directory_size".
 * Moving dedup into the per-bucket load bounds spill to ~14M rows/bucket and
 * avoids the issue entirely.
 *
 * Steps:
 *   1. Verify no duplicate (tx_hash, log_index) keys exist (defensive).
 *   2. CREATE UNIQUE INDEX idx_activity_v3_dedup (tx_hash, log_index)
 *   3. CREATE INDEX idx_activity_v3_wallet_ts, idx_activity_v3_market_ts
 *   4. CHECKPOINT
 *
 * Flags:
 *   --skip-dupe-check    Skip the upfront duplicate-key scan (faster,
 *                        use only if you trust 02c finished every bucket).
 *   --dry-run            Verify row count + dupe scan, print the index DDL,
 *                        and exit without mutating the DB.
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { buildActivityIndexSqlList } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

function parseArgs(argv: string[]): { dryRun: boolean; skipDupeCheck: boolean } {
  let dryRun = false;
  let skipDupeCheck = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--skip-dupe-check') skipDupeCheck = true;
  }
  return { dryRun, skipDupeCheck };
}

async function main(): Promise<void> {
  const { dryRun, skipDupeCheck } = parseArgs(process.argv.slice(2));
  const db = openDuckDB(getDuckDBPath());
  try {
    const total = (
      await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3')
    )[0].c;
    console.log(`[02d] total rows: ${total}`);

    if (!skipDupeCheck) {
      const t0 = Date.now();
      console.log('[02d] scanning for duplicate (tx_hash, log_index) pairs (defensive) …');
      const dupes = (
        await db.query<{ n: number }>(
          `SELECT COUNT(*)::BIGINT AS n FROM (
             SELECT tx_hash, log_index
             FROM discovery_activity_v3
             GROUP BY tx_hash, log_index
             HAVING COUNT(*) > 1
           )`
        )
      )[0].n;
      console.log(
        `[02d] dupe scan complete in ${Math.round((Date.now() - t0) / 1000)}s: ${dupes} duplicate key groups`
      );
      if (Number(dupes) > 0) {
        console.error(
          '[02d] REFUSING to build UNIQUE INDEX: duplicate (tx_hash, log_index) pairs exist. ' +
            'This should be impossible if 02c (bucket-local dedup) completed on every bucket. ' +
            'Investigate with:  SELECT tx_hash, log_index, COUNT(*) c FROM discovery_activity_v3 ' +
            'GROUP BY 1,2 HAVING c > 1 LIMIT 20;'
        );
        process.exit(2);
      }
    } else {
      console.log('[02d] --skip-dupe-check: trusting 02c bucket-local dedup');
    }

    if (dryRun) {
      console.log('[02d] --dry-run: would execute the following index DDL:');
      for (const sql of buildActivityIndexSqlList()) console.log(`   ${sql}`);
      console.log('[02d] --dry-run: exiting without changes');
      return;
    }

    console.log('[02d] building indexes …');
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
