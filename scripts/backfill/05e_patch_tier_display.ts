/**
 * Refresh display stats for top-N wallets per tier from Polymarket reference APIs.
 */
import Database from 'better-sqlite3';
import { fetchReferenceDisplayStats } from '../../src/discovery/v3/publishEnrichment.js';
import { fetchTradedCount } from '../../src/discovery/v3/dataApiValidator.js';
import { runV3SqliteMigrations } from '../../src/discovery/v3/schema.js';

const dataDir = process.env.DATA_DIR || './data';
const perTier = Number(process.env.PATCH_TIER_LIMIT ?? 15);

async function main(): Promise<void> {
  const db = new Database(`${dataDir}/copytrade.db`);
  runV3SqliteMigrations(db);
  const now = Math.floor(Date.now() / 1000);

  for (const tier of ['alpha', 'whale', 'specialist']) {
    const rows = db
      .prepare(
        `SELECT proxy_wallet FROM discovery_wallet_scores_v3
         WHERE tier = ? ORDER BY tier_rank ASC LIMIT ?`
      )
      .all(tier, perTier) as Array<{ proxy_wallet: string }>;

    for (const row of rows) {
      const [ref, pred] = await Promise.all([
        fetchReferenceDisplayStats(row.proxy_wallet),
        fetchTradedCount(row.proxy_wallet),
      ]);
      if (ref.profilePnlUsd == null && ref.profileVolumeUsd == null) continue;
      db.prepare(
        `UPDATE discovery_wallet_scores_v3 SET
           realized_pnl = COALESCE(?, realized_pnl),
           volume_total = COALESCE(?, volume_total),
           predictions_count = COALESCE(?, predictions_count),
           updated_at = ?
         WHERE proxy_wallet = ?`
      ).run(
        ref.profilePnlUsd,
        ref.profileVolumeUsd,
        pred,
        now,
        row.proxy_wallet
      );
      console.log(
        `[patch] ${tier} ${row.proxy_wallet} pnl=${ref.profilePnlUsd} vol=${ref.profileVolumeUsd} pred=${pred}`
      );
    }
  }
  db.close();
}

main().catch((err) => {
  console.error('[patch] failed:', err);
  process.exit(1);
});
