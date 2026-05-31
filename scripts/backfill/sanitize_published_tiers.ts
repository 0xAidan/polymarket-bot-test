/**
 * Fix published SQLite tier cards: drop corrupt rows, reference-patch top-N,
 * ensure golden wallets exist and pass promotion gate.
 */
import Database from 'better-sqlite3';
import {
  validateWalletPromotionGate,
  fetchTradedCount,
} from '../../src/discovery/v3/dataApiValidator.js';
import {
  fetchPublishProfileMetaLite,
  fetchReferenceDisplayStats,
} from '../../src/discovery/v3/publishEnrichment.js';
import { corruptionHeuristicReason } from '../../src/discovery/v3/publishQualityGate.js';
import { runV3SqliteMigrations } from '../../src/discovery/v3/schema.js';

const TIERS = ['alpha', 'whale', 'specialist'] as const;
const PATCH_LIMIT = Number(process.env.PATCH_TIER_LIMIT ?? 50);
const ALPHA_GATE_TOP = Number(process.env.SANITIZE_ALPHA_GATE_TOP ?? 10);

const GOLDEN: Array<{ label: string; address: string; tier: string; rank: number }> = [
  { label: 'dvisik', address: '0x2055b6a642839e86644d381c619aabc0afec1d9d', tier: 'whale', rank: 2 },
  { label: 'c000OLI', address: '0xfedc381bf3fb5d20433bb4a0216b15dbbc5c6398', tier: 'whale', rank: 3 },
];

const dataDir = process.env.DATA_DIR || './data';
const db = new Database(`${dataDir}/copytrade.db`);
runV3SqliteMigrations(db);
const now = Math.floor(Date.now() / 1000);

const delHeuristic = db.prepare(
  `DELETE FROM discovery_wallet_scores_v3 WHERE proxy_wallet = ?`
);
const updateDisplay = db.prepare(
  `UPDATE discovery_wallet_scores_v3 SET
     realized_pnl = COALESCE(?, realized_pnl),
     volume_total = COALESCE(?, volume_total),
     predictions_count = COALESCE(?, predictions_count),
     profile_name = COALESCE(?, profile_name),
     updated_at = ?
   WHERE proxy_wallet = ? AND tier = ?`
);
const upsertGolden = db.prepare(
  `INSERT INTO discovery_wallet_scores_v3
     (proxy_wallet, tier, tier_rank, score, volume_total, trade_count,
      distinct_markets, closed_positions, realized_pnl, hit_rate,
      last_active_ts, reasons_json, updated_at, predictions_count, profile_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(proxy_wallet, tier) DO UPDATE SET
     tier_rank = excluded.tier_rank,
     realized_pnl = excluded.realized_pnl,
     volume_total = excluded.volume_total,
     predictions_count = excluded.predictions_count,
     profile_name = excluded.profile_name,
     updated_at = excluded.updated_at`
);

async function patchWallet(tier: string, address: string): Promise<void> {
  const [lite, ref, pred] = await Promise.all([
    fetchPublishProfileMetaLite(address),
    fetchReferenceDisplayStats(address),
    fetchTradedCount(address),
  ]);
  updateDisplay.run(
    ref.profilePnlUsd,
    ref.profileVolumeUsd,
    pred,
    lite.profileName,
    now,
    address.toLowerCase(),
    tier
  );
}

async function main(): Promise<void> {
  const allRows = db
    .prepare(
      `SELECT proxy_wallet, tier, tier_rank, volume_total, trade_count, realized_pnl, predictions_count
       FROM discovery_wallet_scores_v3
       WHERE tier IN ('alpha','whale','specialist')`
    )
    .all() as Array<{
    proxy_wallet: string;
    tier: string;
    tier_rank: number;
    volume_total: number;
    trade_count: number;
    realized_pnl: number;
    predictions_count: number | null;
  }>;

  let deleted = 0;
  for (const row of allRows) {
    const reason = corruptionHeuristicReason({
      proxy_wallet: row.proxy_wallet,
      tier: row.tier,
      volume_total: row.volume_total,
      trade_count: row.trade_count,
      realized_pnl: row.realized_pnl,
      predictions_count: row.predictions_count,
    });
    if (reason) {
      delHeuristic.run(row.proxy_wallet);
      deleted++;
      console.log(`[sanitize] deleted ${row.tier} ${row.proxy_wallet}: ${reason}`);
    }
  }
  console.log(`[sanitize] deleted ${deleted} corrupt rows`);

  for (const tier of TIERS) {
    const top = db
      .prepare(
        `SELECT proxy_wallet FROM discovery_wallet_scores_v3
         WHERE tier = ? ORDER BY tier_rank ASC LIMIT ?`
      )
      .all(tier, PATCH_LIMIT) as Array<{ proxy_wallet: string }>;
    console.log(`[sanitize] patching ${top.length} ${tier} wallets…`);
    for (const row of top) {
      await patchWallet(tier, row.proxy_wallet);
    }
  }

  for (const g of GOLDEN) {
    const [lite, ref, pred] = await Promise.all([
      fetchPublishProfileMetaLite(g.address),
      fetchReferenceDisplayStats(g.address),
      fetchTradedCount(g.address),
    ]);
    upsertGolden.run(
      g.address.toLowerCase(),
      g.tier,
      g.rank,
      50,
      ref.profileVolumeUsd ?? 0,
      0,
      1,
      0,
      ref.profilePnlUsd ?? 0,
      null,
      now,
      '["golden"]',
      now,
      pred,
      lite.profileName
    );
    console.log(`[sanitize] golden ${g.label} pnl=${ref.profilePnlUsd} vol=${ref.profileVolumeUsd} pred=${pred}`);
  }

  const alphaTop = db
    .prepare(
      `SELECT proxy_wallet, volume_total, trade_count, realized_pnl
       FROM discovery_wallet_scores_v3 WHERE tier = 'alpha' ORDER BY tier_rank ASC LIMIT ?`
    )
    .all(ALPHA_GATE_TOP) as Array<{
    proxy_wallet: string;
    volume_total: number;
    trade_count: number;
    realized_pnl: number;
  }>;

  for (const row of alphaTop) {
    await patchWallet('alpha', row.proxy_wallet);
    const refreshed = db
      .prepare(
        `SELECT volume_total, trade_count, realized_pnl FROM discovery_wallet_scores_v3
         WHERE proxy_wallet = ? AND tier = 'alpha'`
      )
      .get(row.proxy_wallet) as typeof row | undefined;
    if (!refreshed) continue;
    const gate = await validateWalletPromotionGate(row.proxy_wallet, {
      volume_total: refreshed.volume_total,
      trade_count: refreshed.trade_count,
      realized_pnl: refreshed.realized_pnl,
    });
    if (!gate.ok) {
      delHeuristic.run(row.proxy_wallet);
      console.log(`[sanitize] removed alpha top ${row.proxy_wallet}: ${gate.reason}`);
    }
  }

  db.close();
  console.log('[sanitize] done');
}

main().catch((err) => {
  console.error('[sanitize] failed:', err);
  process.exit(1);
});
