/**
 * Periodic worker that re-emits snapshots and rescores wallets that have
 * accumulated new activity since the last run. Scheduled hourly by default.
 *
 * This is intentionally stateless w.r.t. which wallets "changed" — the
 * snapshot emit query reads all (wallet, active_day) pairs from DuckDB and
 * is cheap thanks to indexed GROUP BY. For massive datasets this becomes an
 * incremental materialization.
 */
import type Database from 'better-sqlite3';
import { DuckDBClient } from './duckdbClient.js';
import { buildSnapshotEmitSql } from './backfillQueries.js';
import { scoreTiers } from './tierScoring.js';
import { runV3SqliteMigrations } from './schema.js';
import type { V3FeatureSnapshot } from './types.js';

export interface RefreshWorkerOptions {
  duck: DuckDBClient;
  sqlite: Database.Database;
  intervalMs?: number;
  topN?: number;
  log?: (msg: string) => void;
}

export interface RefreshResult {
  snapshotRows: number;
  scored: number;
  eligible: number;
}

export async function runRefreshOnce(options: RefreshWorkerOptions): Promise<RefreshResult> {
  const log = options.log ?? (() => {});
  const { duck, sqlite } = options;

  runV3SqliteMigrations(sqlite);
  await duck.exec('DELETE FROM discovery_feature_snapshots_v3');
  await duck.exec(buildSnapshotEmitSql());

  const snapshotCount = (
    await duck.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_feature_snapshots_v3')
  )[0]?.c ?? 0;
  log(`[v3-refresh] snapshots=${snapshotCount}`);

  const rows = await duck.query<V3FeatureSnapshot>(
    `SELECT
       proxy_wallet,
       CAST(snapshot_day AS VARCHAR) AS snapshot_day,
       CAST(trade_count AS BIGINT) AS trade_count,
       volume_total,
       CAST(distinct_markets AS BIGINT) AS distinct_markets,
       CAST(closed_positions AS BIGINT) AS closed_positions,
       realized_pnl, unrealized_pnl,
       CAST(first_active_ts AS BIGINT) AS first_active_ts,
       CAST(last_active_ts  AS BIGINT) AS last_active_ts,
       CAST(observation_span_days AS INTEGER) AS observation_span_days
     FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY proxy_wallet ORDER BY snapshot_day DESC) AS rn
       FROM discovery_feature_snapshots_v3
     ) t WHERE rn = 1`
  );

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
    })),
    options.topN ?? 500
  );

  const tx = sqlite.transaction((list: typeof scores) => {
    sqlite.prepare('DELETE FROM discovery_wallet_scores_v3').run();
    const ins = sqlite.prepare(
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
  log(`[v3-refresh] wrote ${scores.length} rows (eligible ${stats.eligible}/${stats.total})`);
  return { snapshotRows: Number(snapshotCount), scored: scores.length, eligible: stats.eligible };
}

export interface RefreshLoopHandle {
  stop(): void;
}

export function startRefreshLoop(options: RefreshWorkerOptions): RefreshLoopHandle {
  const interval = options.intervalMs ?? 60 * 60 * 1000;
  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await runRefreshOnce(options);
    } catch (err) {
      (options.log ?? console.error)(`[v3-refresh] error: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, interval);
  // Fire one immediately on start, but don't block the caller.
  void tick();
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
