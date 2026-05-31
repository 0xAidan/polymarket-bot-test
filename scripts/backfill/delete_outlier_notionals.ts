/**
 * Delete activity rows with absurd usd_notional / abs_size (global, all timestamps).
 * Gap dedup only rewrites the May 2026 window; historical gap-fill and parquet
 * loads can still contain multi-million-dollar single rows.
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

const MAX_NOTIONAL = Number(process.env.GAP_MAX_NOTIONAL_USD ?? 250_000);

async function main(): Promise<void> {
  const duck = await openDuckDB(getDuckDBPath());
  try {
    const mem = process.env.DUCKDB_MEMORY_LIMIT_GB ?? '8';
    await duck.exec(`SET memory_limit = '${mem}GB'`);
    await duck.exec('SET threads = 2');

    const [before] = await duck.query<{ total: bigint; bad: bigint }>(
      `SELECT COUNT(*)::BIGINT AS total,
              COUNT(*) FILTER (WHERE usd_notional > ${MAX_NOTIONAL} OR abs_size > ${MAX_NOTIONAL})::BIGINT AS bad
       FROM discovery_activity_v3`
    );
    console.log(`[outliers] rows before: total=${before.total} bad=${before.bad}`);

    await duck.exec(
      `DELETE FROM discovery_activity_v3
       WHERE usd_notional > ${MAX_NOTIONAL} OR abs_size > ${MAX_NOTIONAL}`
    );

    const [after] = await duck.query<{ total: bigint; bad: bigint }>(
      `SELECT COUNT(*)::BIGINT AS total,
              COUNT(*) FILTER (WHERE usd_notional > ${MAX_NOTIONAL} OR abs_size > ${MAX_NOTIONAL})::BIGINT AS bad
       FROM discovery_activity_v3`
    );
    console.log(
      `[outliers] rows after: total=${after.total} removed=${Number(before.total) - Number(after.total)} bad=${after.bad}`
    );
  } finally {
    await duck.close();
  }
}

main().catch((err) => {
  console.error('[outliers] failed:', err);
  process.exit(1);
});
