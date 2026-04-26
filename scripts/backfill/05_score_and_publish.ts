/**
 * Phase 1.5 step 5: read the most recent snapshot per wallet from DuckDB,
 * apply eligibility gates, compute tier scores, write top-N per tier to
 * the SQLite hot read model (`discovery_wallet_scores_v3`).
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrationsBackfillNoIndex } from '../../src/discovery/v3/duckdbSchema.js';
import { runV3SqliteMigrations } from '../../src/discovery/v3/schema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { scoreTiers } from '../../src/discovery/v3/tierScoring.js';
import type { V3FeatureSnapshot } from '../../src/discovery/v3/types.js';

function getSqlitePath(): string {
  const dataDir = process.env.DATA_DIR || './data';
  return join(dataDir, 'copytrade.db');
}

async function main(): Promise<void> {
  const duck = openDuckDB(getDuckDBPath());
  await duck.exec(`SET memory_limit = '6GB'; SET threads = 2; SET temp_directory = '/mnt/HC_Volume_105468668/duckdb_tmp'; SET max_temp_directory_size = '60GB'; SET preserve_insertion_order = false;`);

  try {
    // Use the no-index migration — the backfilled discovery_activity_v3
    // has ~800M rows and DuckDB 1.4.x CREATE INDEX would OOM.
    // See src/discovery/v3/duckdbSchema.ts for the full rationale.
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => duck.exec(sql));
    console.log('[05] selecting latest snapshot per wallet…');
    const rows = await duck.query<V3FeatureSnapshot>(
      `SELECT
         proxy_wallet,
         CAST(snapshot_day AS VARCHAR)                AS snapshot_day,
         CAST(trade_count AS BIGINT)                  AS trade_count,
         volume_total,
         CAST(distinct_markets AS BIGINT)             AS distinct_markets,
         CAST(closed_positions AS BIGINT)             AS closed_positions,
         CAST(realized_pnl AS DOUBLE)                 AS realized_pnl,
         CAST(unrealized_pnl AS DOUBLE)               AS unrealized_pnl,
         CAST(first_active_ts AS BIGINT)              AS first_active_ts,
         CAST(last_active_ts AS BIGINT)               AS last_active_ts,
         CAST(observation_span_days AS INTEGER)       AS observation_span_days
       FROM (
         SELECT *,
                ROW_NUMBER() OVER (PARTITION BY proxy_wallet ORDER BY snapshot_day DESC) AS rn
         FROM discovery_feature_snapshots_v3
       ) t
       WHERE rn = 1`
    );
    console.log(`[05] scoring ${rows.length} wallets`);

    const now = Math.floor(Date.now() / 1000);
    const { scores, stats } = scoreTiers(
      rows.map((r) => ({
        snapshot: {
          ...r,
          trade_count: Number(r.trade_count),
          distinct_markets: Number(r.distinct_markets),
          closed_positions: Number(r.closed_positions),
          first_active_ts: Number(r.first_active_ts),
          last_active_ts: Number(r.last_active_ts),
          observation_span_days: Number(r.observation_span_days),
        },
        now_ts: now,
      }))
    );
    console.log(`[05] eligibility: ${stats.eligible}/${stats.total} (rejection ${(stats.rejection_rate * 100).toFixed(1)}%)`);

    const sqlitePath = getSqlitePath();
    mkdirSync(dirname(sqlitePath), { recursive: true });
    const db = new Database(sqlitePath);
    try {
      db.pragma('journal_mode = WAL');
      runV3SqliteMigrations(db);
      const tx = db.transaction((list: typeof scores) => {
        db.prepare('DELETE FROM discovery_wallet_scores_v3').run();
        const ins = db.prepare(
          `INSERT INTO discovery_wallet_scores_v3
             (proxy_wallet, tier, tier_rank, score, volume_total, trade_count,
              distinct_markets, closed_positions, realized_pnl, hit_rate,
              last_active_ts, reasons_json, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        );
        for (const s of list) {
          ins.run(
            s.proxy_wallet, s.tier, s.tier_rank, s.score, s.volume_total,
            s.trade_count, s.distinct_markets, s.closed_positions,
            s.realized_pnl, s.hit_rate, s.last_active_ts, s.reasons_json, s.updated_at
          );
        }
      });
      tx(scores);
      console.log(`[05] wrote ${scores.length} score rows to ${sqlitePath}`);
    } finally {
      db.close();
    }
  } finally {
    await duck.close();
  }
  console.log('[05] done.');
}

main().catch((err) => {
  console.error('[05] failed:', err);
  process.exit(1);
});
