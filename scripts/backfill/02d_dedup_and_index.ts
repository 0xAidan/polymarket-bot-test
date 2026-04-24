/**
 * Phase 1.5 step 2d: verify + checkpoint (NO index creation).
 *
 * Must be run AFTER all 64 bucket parquets have been dedup-inserted via
 * 02c_merge_one_bucket.ts. Because 02c does bucket-local dedup (valid
 * because 02a bucketizes on abs(hash(tx_hash)) % N so all copies of any
 * key live in one bucket), the table is already globally deduplicated on
 * arrival.
 *
 * History:
 *   rev1 (pre-2026-04-22): did a global CTAS dedup at the end. OOM'd the
 *     75GB temp dir on the 8GB Hetzner box — see #89.
 *   rev2 (2026-04-22): moved dedup into per-bucket 02c load; 02d built
 *     UNIQUE + 2 auxiliary ART indexes. That also OOM'd because DuckDB
 *     1.4.x requires the entire ART index to fit in memory during
 *     CREATE INDEX. For ~800M rows the required memory is ~100GB;
 *     we have 6GB. See duckdb.org/docs/current/sql/indexes.html
 *     and duckdb/duckdb issues #15420, #16229.
 *   rev3 (2026-04-23, this file): index creation removed entirely. The
 *     downstream pipeline (04 snapshots, 05 score, 06 validate) does not
 *     need ART indexes on discovery_activity_v3 — 04 scans the full table
 *     with hash joins, and 05/06 only touch discovery_feature_snapshots_v3
 *     which has a native PRIMARY KEY. The UNIQUE constraint on
 *     (tx_hash, log_index) is enforced mathematically by 02c's bucket-local
 *     GROUP BY and verified defensively below. Live online dedup uses
 *     SQLite, not this DuckDB path.
 *
 * Steps:
 *   1. Report total row count.
 *   2. Verify no duplicate (tx_hash, log_index) pairs exist (defensive).
 *   3. CHECKPOINT.
 *
 * Flags:
 *   --skip-dupe-check    Skip the upfront duplicate-key scan (faster,
 *                        use only if you trust 02c finished every bucket).
 *   --dry-run            Verify row count + dupe scan and exit without
 *                        mutating the DB.
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
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
          '[02d] FATAL: duplicate (tx_hash, log_index) pairs exist. ' +
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
      console.log('[02d] --dry-run: verification complete; exiting without CHECKPOINT');
      return;
    }

    console.log('[02d] CHECKPOINT …');
    const tc = Date.now();
    await db.exec('CHECKPOINT');
    console.log(`[02d] CHECKPOINT complete in ${Math.round((Date.now() - tc) / 1000)}s`);

    const final = (
      await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3')
    )[0].c;
    console.log(`[02d] final row count: ${final}`);
    console.log(
      '[02d] NOTE: ART indexes intentionally NOT created. See script header ' +
        'and src/discovery/v3/duckdbSchema.ts for the 2026-04-23 rationale.'
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[02d] failed:', err);
  process.exit(1);
});
