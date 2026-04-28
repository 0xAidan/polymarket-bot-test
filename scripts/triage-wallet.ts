#!/usr/bin/env tsx
/**
 * One-off triage for a single wallet that fails the verify harness.
 * Lists every trade we have (with V1/V2 tag) and dumps the API's view
 * so we can see exactly which trade(s) are missing.
 *
 * Usage: npx tsx scripts/triage-wallet.ts 0x592e...
 */
import { openDuckDB } from '../src/discovery/v3/duckdbClient.ts';

const V2_CUTOVER_TS = 1745827200;
const wallet = process.argv[2];
if (!wallet) { console.error('usage: tsx triage-wallet.ts <wallet>'); process.exit(1); }

const dbPath = process.env.DUCKDB_PATH || '/mnt/HC_Volume_105468668/discovery_v3.duckdb';
const db = openDuckDB(dbPath);

console.log(`\n── Our trades for ${wallet} ─────────────────────────────────────────`);
const rows = await db.query<any>(`
  SELECT ts_unix, market_id, side, role, price_yes, usd_notional, signed_size, tx_hash, log_index
  FROM discovery_activity_v3
  WHERE proxy_wallet = '${wallet}'
  ORDER BY ts_unix, log_index
`);
let v1Vol = 0, v2Vol = 0;
for (const r of rows) {
  const era = Number(r.ts_unix) >= V2_CUTOVER_TS ? 'V2' : 'V1';
  const ts = new Date(Number(r.ts_unix) * 1000).toISOString();
  if (era === 'V1') v1Vol += Number(r.usd_notional); else v2Vol += Number(r.usd_notional);
  console.log(`  ${era} ${ts} ${r.side.padEnd(4)} px=${Number(r.price_yes).toFixed(4)} usd=${Number(r.usd_notional).toFixed(2)} mkt=${String(r.market_id).slice(0,16)}... tx=${String(r.tx_hash).slice(0,10)}.${r.log_index}`);
}
console.log(`\n  totals: ${rows.length} trades, V1=$${v1Vol.toFixed(2)}, V2=$${v2Vol.toFixed(2)}, all=$${(v1Vol+v2Vol).toFixed(2)}`);

await db.close();

console.log(`\n── Polymarket Data API view ─────────────────────────────────────────`);
let apiVol = 0, apiCount = 0;
let offset = 0;
const apiRows: any[] = [];
while (offset < 5000) {
  const url = `https://data-api.polymarket.com/activity?user=${wallet}&type=TRADE&limit=500&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`  API ${res.status}`); break; }
  const batch: any[] = await res.json();
  if (!batch.length) break;
  apiRows.push(...batch);
  apiCount += batch.length;
  for (const t of batch) apiVol += Number(t.usdcSize ?? 0);
  if (batch.length < 500) break;
  offset += 500;
}
console.log(`  ${apiCount} trades, total usdcSize=$${apiVol.toFixed(2)}`);
for (const t of apiRows) {
  const ts = new Date(Number(t.timestamp) * 1000).toISOString();
  const era = Number(t.timestamp) >= V2_CUTOVER_TS ? 'V2' : 'V1';
  console.log(`  ${era} ${ts} ${String(t.side).padEnd(4)} px=${Number(t.price ?? 0).toFixed(4)} usd=${Number(t.usdcSize ?? 0).toFixed(2)} cond=${String(t.conditionId ?? '').slice(0,16)}... tx=${String(t.transactionHash ?? '').slice(0,10)}`);
}

console.log(`\n── Diff ─────────────────────────────────────────────────────────────`);
const ourTxSet = new Set(rows.map(r => `${String(r.tx_hash).toLowerCase()}.${r.log_index}`));
const ourTxOnlySet = new Set(rows.map(r => String(r.tx_hash).toLowerCase()));
const missing = apiRows.filter(t => !ourTxOnlySet.has(String(t.transactionHash ?? '').toLowerCase()));
console.log(`  trades in API but not in our DB (by tx_hash): ${missing.length}`);
for (const t of missing) {
  const era = Number(t.timestamp) >= V2_CUTOVER_TS ? 'V2' : 'V1';
  console.log(`    ${era} ${new Date(Number(t.timestamp) * 1000).toISOString()} ${t.side} usd=${Number(t.usdcSize).toFixed(2)} tx=${t.transactionHash}`);
}
