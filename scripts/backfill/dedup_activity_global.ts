/**
 * Idempotent global dedup for discovery_activity_v3.
 *
 * Removes duplicate (tx_hash, log_index) rows and caps outlier notionals
 * across the full table (not only the gap window). Run after gap-fill or
 * before re-emitting snapshots when integrity checks report dupes.
 *
 *   npx tsx scripts/backfill/dedup_activity_global.ts
 *
 * Env: GAP_MAX_NOTIONAL_USD (default 250000) — same cap as dedup_gap_activity.ts
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

const MAX_NOTIONAL = Number(process.env.GAP_MAX_NOTIONAL_USD ?? 250_000);

async function main(): Promise<void> {
  const duck = await openDuckDB(getDuckDBPath());
  try {
    const [dupeBefore] = await duck.query<{ c: bigint }>(
      `SELECT COUNT(*)::BIGINT AS c FROM (
         SELECT tx_hash, log_index FROM discovery_activity_v3
         GROUP BY 1, 2 HAVING COUNT(*) > 1
       ) t`
    );
    console.log(`[dedup-global] duplicate key groups before: ${dupeBefore.c}`);

    const [rowBefore] = await duck.query<{ c: bigint }>(
      'SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'
    );
    console.log(`[dedup-global] rows before: ${rowBefore.c}`);

    await duck.exec(`
      CREATE OR REPLACE TEMP TABLE _activity_clean AS
      SELECT * EXCLUDE (rn)
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY tx_hash, log_index
            ORDER BY ts_unix, proxy_wallet
          ) AS rn
        FROM discovery_activity_v3
        WHERE usd_notional <= ${MAX_NOTIONAL}
          AND abs_size <= ${MAX_NOTIONAL}
      )
      WHERE rn = 1
    `);

    await duck.exec('DELETE FROM discovery_activity_v3');
    await duck.exec(`
      INSERT INTO discovery_activity_v3
      SELECT
        proxy_wallet, market_id, condition_id, event_id, ts_unix, block_number,
        tx_hash, log_index, role, side, price_yes, usd_notional, signed_size, abs_size
      FROM _activity_clean
    `);

    const [dupeAfter] = await duck.query<{ c: bigint }>(
      `SELECT COUNT(*)::BIGINT AS c FROM (
         SELECT tx_hash, log_index FROM discovery_activity_v3
         GROUP BY 1, 2 HAVING COUNT(*) > 1
       ) t`
    );
    const [rowAfter] = await duck.query<{ c: bigint }>(
      'SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'
    );
    console.log(
      `[dedup-global] rows after: ${rowAfter.c} (removed ${Number(rowBefore.c) - Number(rowAfter.c)}), ` +
      `duplicate groups after: ${dupeAfter.c}`
    );
  } finally {
    await duck.close();
  }
}

main().catch((err) => {
  console.error('[dedup-global] failed:', err);
  process.exit(1);
});
