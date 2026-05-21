/**
 * Compare Polymarket Data API PnL breakdowns vs profile acceptance targets.
 */
import { fetchPaginatedJson, fetchReferenceLifetimePnlUsd, fetchTradedCount } from '../../src/discovery/v3/dataApiValidator.js';

const DATA_API = 'https://data-api.polymarket.com';

const WALLETS = [
  { label: 'dvisik', address: '0x2055b6a642839e86644d381c619aabc0afec1d9d', profilePnl: -646 },
  { label: 'c000OLI', address: '0xfedc381bf3fb5d20433bb4a0216b15dbbc5c6398', profilePnl: 83_535 },
];

async function sumClosed(addr: string): Promise<number> {
  const { rows, httpError } = await fetchPaginatedJson<{ realizedPnl?: number }>(
    (offset, limit) =>
      `${DATA_API}/closed-positions?user=${encodeURIComponent(addr)}&limit=${limit}&offset=${offset}`,
    50,
    400,
    fetch
  );
  if (httpError) throw new Error(httpError);
  return rows.reduce((s, r) => s + Number(r.realizedPnl ?? 0), 0);
}

async function sumOpenCashPnl(addr: string): Promise<number> {
  const { rows, httpError } = await fetchPaginatedJson<{ cashPnl?: number }>(
    (offset, limit) =>
      `${DATA_API}/positions?user=${encodeURIComponent(addr)}&limit=${limit}&offset=${offset}`,
    500,
    40,
    fetch
  );
  if (httpError) throw new Error(httpError);
  return rows.reduce((s, r) => s + Number(r.cashPnl ?? 0), 0);
}

async function main(): Promise<void> {
  for (const w of WALLETS) {
    const addr = w.address.toLowerCase();
    const [closed, open, lifetime, traded] = await Promise.all([
      sumClosed(addr),
      sumOpenCashPnl(addr),
      fetchReferenceLifetimePnlUsd(addr),
      fetchTradedCount(addr),
    ]);
    console.log('\n===', w.label, '===');
    console.log({
      profileTarget: w.profilePnl,
      closedOnly: Math.round(closed * 100) / 100,
      openCashPnl: Math.round(open * 100) / 100,
      closedPlusOpen: Math.round((closed + open) * 100) / 100,
      lifetimeFn: lifetime,
      traded,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
