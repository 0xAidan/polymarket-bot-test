/**
 * Dump tier score breakdown for top-N, random sample, and optional address list.
 *
 * Usage:
 *   npx tsx scripts/diagnostics/score_breakdown_dump.ts
 *   npx tsx scripts/diagnostics/score_breakdown_dump.ts --top 50 --random 50
 *   npx tsx scripts/diagnostics/score_breakdown_dump.ts --addresses 0xabc...,0xdef...
 */
import Database from 'better-sqlite3';
import { join } from 'path';
import { config } from '../../src/config.js';

interface ScoreRow {
  proxy_wallet: string;
  tier: string;
  tier_rank: number;
  score: number;
  volume_total: number;
  trade_count: number;
  realized_pnl: number;
  hit_rate: number | null;
  copyable: number | null;
  maker_ratio: number | null;
  distinct_markets: number;
  closed_positions: number;
}

const parseArg = (flag: string, fallback: string): string => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || !process.argv[idx + 1]) return fallback;
  return process.argv[idx + 1];
};

const sqlitePath = join(config.dataDir, 'copytrade.db');

const topN = Number(parseArg('--top', '50'));
const randomN = Number(parseArg('--random', '50'));
const addressArg = parseArg('--addresses', '');

const db = new Database(sqlitePath, { readonly: true });

const fetchTierRows = (tier: string, limit: number, order: 'top' | 'random'): ScoreRow[] => {
  const orderClause = order === 'top'
    ? 'ORDER BY tier_rank ASC'
    : 'ORDER BY RANDOM()';
  return db.prepare(
    `SELECT proxy_wallet, tier, tier_rank, score, volume_total, trade_count,
            realized_pnl, hit_rate, copyable, maker_ratio, distinct_markets, closed_positions
     FROM discovery_wallet_scores_v3
     WHERE tier = ?
     ${orderClause}
     LIMIT ?`
  ).all(tier, limit) as ScoreRow[];
};

const printSection = (title: string, rows: ScoreRow[]): void => {
  console.log(`\n=== ${title} (${rows.length}) ===`);
  for (const r of rows) {
    const roiProxy = r.closed_positions > 0 ? (r.realized_pnl / Math.max(1, r.volume_total)) : 0;
    console.log([
      `#${r.tier_rank}`,
      r.proxy_wallet.slice(0, 10) + '…',
      `score=${r.score.toFixed(1)}`,
      `pnl=$${r.realized_pnl.toFixed(0)}`,
      `vol=$${r.volume_total.toFixed(0)}`,
      `trades=${r.trade_count}`,
      `hit=${r.hit_rate == null ? 'n/a' : (r.hit_rate * 100).toFixed(1) + '%'}`,
      `copyable=${r.copyable ?? 1}`,
      `maker=${r.maker_ratio == null ? 'n/a' : r.maker_ratio.toFixed(2)}`,
      `roi~=${(roiProxy * 100).toFixed(2)}%`,
    ].join(' | '));
  }
};

for (const tier of ['alpha', 'whale', 'specialist']) {
  printSection(`${tier.toUpperCase()} top ${topN}`, fetchTierRows(tier, topN, 'top'));
  printSection(`${tier.toUpperCase()} random ${randomN}`, fetchTierRows(tier, randomN, 'random'));
}

if (addressArg) {
  const addresses = addressArg.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  const rows = db.prepare(
    `SELECT proxy_wallet, tier, tier_rank, score, volume_total, trade_count,
            realized_pnl, hit_rate, copyable, maker_ratio, distinct_markets, closed_positions
     FROM discovery_wallet_scores_v3
     WHERE lower(proxy_wallet) IN (${addresses.map(() => '?').join(',')})`
  ).all(...addresses) as ScoreRow[];
  printSection('Requested addresses', rows);
}

const smellStats = db.prepare(
  `SELECT tier,
          COUNT(*) AS n,
          SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS negative_pnl,
          SUM(CASE WHEN score >= 90 THEN 1 ELSE 0 END) AS score_90_plus,
          SUM(CASE WHEN copyable = 0 THEN 1 ELSE 0 END) AS non_copyable
   FROM discovery_wallet_scores_v3
   WHERE tier_rank <= ?
   GROUP BY tier`
).all(topN) as Array<{ tier: string; n: number; negative_pnl: number; score_90_plus: number; non_copyable: number }>;

console.log('\n=== Smell test summary (top ranks) ===');
for (const s of smellStats) {
  console.log(
    `${s.tier}: top${topN} negative_pnl=${s.negative_pnl}/${s.n} ` +
    `score>=90=${s.score_90_plus}/${s.n} non_copyable=${s.non_copyable}/${s.n}`
  );
}

db.close();
