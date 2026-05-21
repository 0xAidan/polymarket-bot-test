/**
 * One-time repair: Goldsky gap-fill rows used exchange-leg sides (taker SELL when
 * user BUY). Goldsky rows have block_number = 0. Swaps side + negates signed_size.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/backfill/fix_goldsky_side_semantics.ts
 *   npx tsx --env-file=.env scripts/backfill/fix_goldsky_side_semantics.ts --dry-run
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const db = await openDuckDB(getDuckDBPath());
  try {
    const before = await db.query<Record<string, unknown>>(`
      SELECT COUNT(*)::BIGINT AS n
      FROM discovery_activity_v3
      WHERE block_number = 0
    `);
    console.log('[fix_goldsky_side] goldsky rows (block_number=0):', before[0]?.n);

    if (dryRun) {
      const sample = await db.query(`
        SELECT proxy_wallet, side, signed_size, usd_notional
        FROM discovery_activity_v3
        WHERE block_number = 0
        LIMIT 3
      `);
      console.log('[fix_goldsky_side] dry-run sample:', sample);
      return;
    }

    await db.exec(`
      UPDATE discovery_activity_v3
      SET
        side = CASE side WHEN 'BUY' THEN 'SELL' ELSE 'BUY' END,
        signed_size = -signed_size
      WHERE block_number = 0
    `);
    console.log('[fix_goldsky_side] UPDATE complete');
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
