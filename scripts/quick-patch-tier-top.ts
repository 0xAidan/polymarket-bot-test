/**
 * Fast demo patch: refresh Polymarket reference stats for top N per tier only.
 */
import Database from 'better-sqlite3';
import { fetchReferenceDisplayStats } from '../src/discovery/v3/publishEnrichment.js';
import { fetchTradedCount } from '../src/discovery/v3/dataApiValidator.js';
import { fetchPublishProfileMetaLite } from '../src/discovery/v3/publishEnrichment.js';
import { runV3SqliteMigrations } from '../src/discovery/v3/schema.js';

const TIERS = ['alpha', 'whale', 'specialist'] as const;
const LIMIT = Number(process.env.PATCH_TIER_LIMIT ?? 15);
const CONCURRENCY = Number(process.env.PATCH_CONCURRENCY ?? 2);

const dataDir = process.env.DATA_DIR || './data';
const db = new Database(`${dataDir}/copytrade.db`);
runV3SqliteMigrations(db);
const now = Math.floor(Date.now() / 1000);

const update = db.prepare(
  `UPDATE discovery_wallet_scores_v3 SET
     realized_pnl = COALESCE(?, realized_pnl),
     volume_total = COALESCE(?, volume_total),
     predictions_count = COALESCE(?, predictions_count),
     profile_name = COALESCE(?, profile_name),
     updated_at = ?
   WHERE proxy_wallet = ? AND tier = ?`
);

async function patchTier(tier: string): Promise<void> {
  const rows = db
    .prepare(
      `SELECT proxy_wallet FROM discovery_wallet_scores_v3
       WHERE tier = ? ORDER BY tier_rank ASC LIMIT ?`
    )
    .all(tier, LIMIT) as Array<{ proxy_wallet: string }>;

  console.log(`[quick-patch] ${tier}: ${rows.length} wallets`);
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async ({ proxy_wallet }) => {
        const lite = await fetchPublishProfileMetaLite(proxy_wallet);
        let ref = await fetchReferenceDisplayStats(proxy_wallet);
        for (let attempt = 0; attempt < 3 && ref.profilePnlUsd == null; attempt++) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          ref = await fetchReferenceDisplayStats(proxy_wallet);
        }
        const pred = await fetchTradedCount(proxy_wallet);
        update.run(
          ref.profilePnlUsd,
          ref.profileVolumeUsd,
          pred,
          lite.profileName,
          now,
          proxy_wallet.toLowerCase(),
          tier
        );
        console.log(
          `  ${proxy_wallet.slice(0, 10)} pnl=${ref.profilePnlUsd?.toFixed(0) ?? 'n/a'} vol=${ref.profileVolumeUsd?.toFixed(0) ?? 'n/a'}`
        );
      })
    );
  }
}

async function main(): Promise<void> {
  for (const tier of TIERS) {
    await patchTier(tier);
  }
  db.close();
  console.log('[quick-patch] done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
