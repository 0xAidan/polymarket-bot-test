/**
 * One-off: refresh reference display stats for a single proxy wallet in SQLite.
 * Usage: npx tsx scripts/backfill/patch_one_wallet_display.ts 0xabc...
 */
import Database from 'better-sqlite3';
import { fetchReferenceDisplayStats } from '../../src/discovery/v3/publishEnrichment.js';
import { fetchTradedCount } from '../../src/discovery/v3/dataApiValidator.js';
import { runV3SqliteMigrations } from '../../src/discovery/v3/schema.js';

const address = process.argv[2]?.trim().toLowerCase();
if (!address?.startsWith('0x')) {
  console.error('usage: patch_one_wallet_display.ts <proxy_wallet>');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || './data';
const db = new Database(`${dataDir}/copytrade.db`);
runV3SqliteMigrations(db);

const [ref, pred] = await Promise.all([
  fetchReferenceDisplayStats(address),
  fetchTradedCount(address),
]);
const now = Math.floor(Date.now() / 1000);
db.prepare(
  `UPDATE discovery_wallet_scores_v3 SET
     realized_pnl = COALESCE(?, realized_pnl),
     volume_total = COALESCE(?, volume_total),
     predictions_count = COALESCE(?, predictions_count),
     updated_at = ?
   WHERE proxy_wallet = ?`
).run(ref.profilePnlUsd, ref.profileVolumeUsd, pred, now, address);

console.log(JSON.stringify({ address, ...ref, predictionsCount: pred }, null, 2));
db.close();
