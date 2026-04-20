/**
 * Phase 1.5 step 6: 20-wallet spot check against the Polymarket Data API.
 *
 * Picks top-volume, mid-volume, long-tail, and known-alpha wallets from the
 * DuckDB snapshot, then compares derived stats to the live
 * `/v1/activity?user={W}` and `/v1/positions?user={W}` endpoints. Prints a
 * per-wallet diff and a summary. See `src/discovery/v3/dataApiValidator.ts`
 * for the actual comparison logic.
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { validateWalletAgainstDataApi } from '../../src/discovery/v3/dataApiValidator.js';

async function main(): Promise<void> {
  const db = openDuckDB(getDuckDBPath());
  try {
    const wallets = await db.query<{ proxy_wallet: string; volume_total: number; trade_count: number }>(
      `WITH latest AS (
         SELECT * FROM (
           SELECT *,
                  ROW_NUMBER() OVER (PARTITION BY proxy_wallet ORDER BY snapshot_day DESC) AS rn
           FROM discovery_feature_snapshots_v3
         ) t WHERE rn = 1
       ),
       tiers AS (
         SELECT proxy_wallet, volume_total, trade_count,
                NTILE(3) OVER (ORDER BY volume_total DESC) AS tier
         FROM latest
       )
       SELECT proxy_wallet, volume_total, trade_count FROM (
         SELECT proxy_wallet, volume_total, trade_count, tier,
                ROW_NUMBER() OVER (PARTITION BY tier ORDER BY volume_total DESC) AS rn
         FROM tiers
       ) x WHERE rn <= 7
       ORDER BY tier, rn
       LIMIT 20`
    );

    if (wallets.length === 0) {
      console.error('[06] no snapshots found. Run 02/03/04 first.');
      process.exit(2);
    }

    let pass = 0;
    for (const w of wallets) {
      const res = await validateWalletAgainstDataApi(w.proxy_wallet, {
        trade_count: Number(w.trade_count),
        volume_total: Number(w.volume_total),
      });
      const status = res.ok ? 'PASS' : 'FAIL';
      console.log(`[06] ${w.proxy_wallet}  ${status}  ${res.reason ?? ''}`);
      if (res.ok) pass++;
    }
    console.log(`[06] summary: ${pass}/${wallets.length} within tolerance`);
    if (pass < wallets.length) process.exitCode = 3;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[06] failed:', err);
  process.exit(1);
});
