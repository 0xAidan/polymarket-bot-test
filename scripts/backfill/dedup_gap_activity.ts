/**
 * Remove duplicate (tx_hash, log_index) rows and obvious API gap outliers
 * from discovery_activity_v3 for the May 2026 gap window.
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

const GAP_MIN_TS = Number(process.env.GAP_MIN_TS ?? 1777911118);
const MAX_NOTIONAL = Number(process.env.GAP_MAX_NOTIONAL_USD ?? 250_000);

async function main(): Promise<void> {
  const duck = await openDuckDB(getDuckDBPath());
  try {
    const before = await duck.query<{ c: bigint }>(
      `SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3 WHERE ts_unix >= ${GAP_MIN_TS}`,
    );
    console.log(`[dedup] gap rows before: ${before[0].c}`);

    await duck.exec(`
      CREATE OR REPLACE TEMP TABLE _gap_clean AS
      SELECT * EXCLUDE (rn)
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY tx_hash, log_index
            ORDER BY ts_unix, proxy_wallet
          ) AS rn
        FROM discovery_activity_v3
        WHERE ts_unix >= ${GAP_MIN_TS}
          AND usd_notional <= ${MAX_NOTIONAL}
          AND abs_size <= ${MAX_NOTIONAL}
      )
      WHERE rn = 1
    `);

    await duck.exec(`DELETE FROM discovery_activity_v3 WHERE ts_unix >= ${GAP_MIN_TS}`);
    await duck.exec(`
      INSERT INTO discovery_activity_v3
      SELECT
        proxy_wallet, market_id, condition_id, event_id, ts_unix, block_number,
        tx_hash, log_index, role, side, price_yes, usd_notional, signed_size, abs_size
      FROM _gap_clean
    `);

    const after = await duck.query<{ c: bigint; max_ts: bigint }>(
      `SELECT COUNT(*)::BIGINT AS c, MAX(ts_unix)::BIGINT AS max_ts
       FROM discovery_activity_v3 WHERE ts_unix >= ${GAP_MIN_TS}`,
    );
    console.log(
      `[dedup] gap rows after: ${after[0].c}, max_ts=${new Date(Number(after[0].max_ts) * 1000).toISOString()}`,
    );
  } finally {
    await duck.close();
  }
}

main().catch((err) => {
  console.error('[dedup] failed:', err);
  process.exit(1);
});
