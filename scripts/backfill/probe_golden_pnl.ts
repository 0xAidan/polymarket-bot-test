/**
 * Quick golden-wallet PnL probe (DuckDB snapshot + Polymarket reference).
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import {
  fetchReferenceLifetimePnlUsd,
  fetchTradedCount,
} from '../../src/discovery/v3/dataApiValidator.js';

const WALLETS = [
  { label: 'dvisik', address: '0x2055b6a642839e86644d381c619aabc0afec1d9d', profilePnl: -646 },
  { label: 'c000OLI', address: '0xfedc381bf3fb5d20433bb4a0216b15dbbc5c6398', profilePnl: 83_535 },
];

async function main(): Promise<void> {
  const db = await openDuckDB(getDuckDBPath());
  try {
    for (const w of WALLETS) {
      const addr = w.address.toLowerCase();
      const [ref, traded, snap, decomp, sides] = await Promise.all([
        fetchReferenceLifetimePnlUsd(addr),
        fetchTradedCount(addr),
        db.query<Record<string, unknown>>(`
          SELECT realized_pnl, unrealized_pnl, volume_total, closed_positions, trade_count
          FROM discovery_feature_snapshots_v3
          WHERE LOWER(proxy_wallet) = '${addr}'
          ORDER BY snapshot_day DESC LIMIT 1
        `),
        db.query<Record<string, unknown>>(`
          WITH wma AS (
            SELECT
              SUM(CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END) AS cash_flow,
              SUM(usd_notional) AS vol,
              SUM(CASE WHEN side = 'BUY' THEN abs_size ELSE -abs_size END) AS token_balance
            FROM discovery_activity_v3
            WHERE LOWER(proxy_wallet) = '${addr}'
          )
          SELECT ROUND(cash_flow, 2) AS cash_flow, ROUND(vol, 2) AS volume,
                 ROUND(token_balance, 2) AS net_token_balance
          FROM wma
        `),
        db.query<Record<string, unknown>>(`
          SELECT side, COUNT(*)::INT AS n,
                 ROUND(SUM(usd_notional), 2) AS vol
          FROM discovery_activity_v3
          WHERE LOWER(proxy_wallet) = '${addr}'
          GROUP BY side
        `),
      ]);
      console.log('\n===', w.label, '===');
      console.log('profile target PnL', w.profilePnl);
      console.log('API reference lifetime', ref);
      console.log('API traded', traded);
      console.log('DuckDB latest snapshot', snap[0]);
      console.log('activity cash_flow / volume', decomp[0]);
      console.log('side breakdown', sides);
    }
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
