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
import { scoreTiers, shouldIncludeInTierRankings } from './tierScoring.js';
import { runV3SqliteMigrations } from './schema.js';
import { runV3SnapshotAdditiveColumnMigrations } from './duckdbSchema.js';
import { buildCompositeScoringQuery, type CompositeScoredRow } from './compositeQueries.js';
import { determineDittoState } from './dittoEngine.js';
import { finalizeScoresForPublish } from './finalizePublishScores.js';
import {
  buildProbabilisticAccuracySql,
  buildMarketEdgeCLVSql,
  buildNicheKnowledgeSql,
  buildCopyabilityFilterSql,
} from './pillarFeatures.js';
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
  // Ensure the new snapshot columns exist before writing (idempotent ALTER TABLE IF NOT EXISTS).
  await runV3SnapshotAdditiveColumnMigrations((sql) => duck.exec(sql));
  await duck.exec('DELETE FROM discovery_feature_snapshots_v3');
  await duck.exec(buildSnapshotEmitSql());

  const snapshotCount = (
    await duck.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_feature_snapshots_v3')
  )[0]?.c ?? 0;
  log(`[v3-refresh] snapshots=${snapshotCount}`);

  // Use ARG_MAX hash-aggregate (not ROW_NUMBER window) to find the latest
  // snapshot per wallet. ROW_NUMBER forces a global sort + materialisation
  // of the entire partitioned result before filtering — can OOM on large
  // snapshot tables. ARG_MAX is a streaming hash aggregate: one pass,
  // O(distinct wallets) memory, no sort, same result.
  await duck.exec('DROP TABLE IF EXISTS _refresh_latest_snap');
  await duck.exec(`
    CREATE TEMP TABLE _refresh_latest_snap AS
    SELECT
      proxy_wallet,
      ARG_MAX(STRUCT_PACK(
        snapshot_day          := CAST(snapshot_day AS VARCHAR),
        trade_count           := CAST(trade_count AS BIGINT),
        volume_total          := volume_total,
        distinct_markets      := CAST(distinct_markets AS BIGINT),
        closed_positions      := CAST(closed_positions AS BIGINT),
        realized_pnl          := realized_pnl,
        unrealized_pnl        := unrealized_pnl,
        first_active_ts       := CAST(first_active_ts AS BIGINT),
        last_active_ts        := CAST(last_active_ts AS BIGINT),
        observation_span_days := CAST(observation_span_days AS INTEGER),
        trade_count_90d       := CAST(COALESCE(trade_count_90d, 0) AS BIGINT),
        volume_90d            := COALESCE(volume_90d, 0.0),
        realized_pnl_90d      := COALESCE(realized_pnl_90d, 0.0),
        closed_positions_positive := CAST(COALESCE(closed_positions_positive, 0) AS BIGINT)
      ), snapshot_day) AS s
    FROM discovery_feature_snapshots_v3
    GROUP BY proxy_wallet
  `);
  interface LatestSnapRow { proxy_wallet: string; s: Record<string, unknown> }
  // Stream in batches to avoid loading all 2M+ snapshots into Node heap at once.
  const READ_BATCH_SIZE = 100_000;
  const rows: V3FeatureSnapshot[] = [];
  let cursor = '';
  for (;;) {
    const cursorClause = cursor
      ? `WHERE proxy_wallet > '${cursor.replace(/'/g, "''")}'`
      : '';
    const batch = await duck.query<LatestSnapRow>(
      `SELECT proxy_wallet, s FROM _refresh_latest_snap ${cursorClause} ORDER BY proxy_wallet LIMIT ${READ_BATCH_SIZE}`
    );
    if (batch.length === 0) break;
    for (const row of batch) {
      const s = row.s as Record<string, unknown>;
      rows.push({
        proxy_wallet:             row.proxy_wallet,
        snapshot_day:             String(s.snapshot_day),
        trade_count:              Number(s.trade_count),
        volume_total:             Number(s.volume_total),
        distinct_markets:         Number(s.distinct_markets),
        closed_positions:         Number(s.closed_positions),
        realized_pnl:             Number(s.realized_pnl),
        unrealized_pnl:           Number(s.unrealized_pnl),
        first_active_ts:          Number(s.first_active_ts),
        last_active_ts:           Number(s.last_active_ts),
        observation_span_days:    Number(s.observation_span_days),
        trade_count_90d:          Number(s.trade_count_90d),
        volume_90d:               Number(s.volume_90d),
        realized_pnl_90d:         Number(s.realized_pnl_90d),
        closed_positions_positive: Number(s.closed_positions_positive),
      });
    }
    cursor = batch[batch.length - 1].proxy_wallet;
    if (batch.length < READ_BATCH_SIZE) break;
  }
  await duck.exec('DROP TABLE IF EXISTS _refresh_latest_snap');

  const now = Math.floor(Date.now() / 1000);

  const compScores = await duck.query<CompositeScoredRow>(
    buildCompositeScoringQuery(now, 999_999)
  );
  const compMap = new Map(compScores.map(s => [s.proxy_wallet, s]));

  // ── Pillar: Brier score (probabilistic accuracy on resolved positions) ─────
  log('[v3-refresh] computing Brier scores…');
  interface BrierRow { proxy_wallet: string; brier_score: number | null }
  const brierRows = await duck.query<BrierRow>(buildProbabilisticAccuracySql());
  const brierMap = new Map(brierRows.map(r => [r.proxy_wallet, r.brier_score]));
  log(`[v3-refresh] brier: ${brierMap.size} wallets with resolved positions`);

  // ── Pillar: CLV (closing-line value, 10% TABLESAMPLE) ─────────────────────
  log('[v3-refresh] computing CLV scores (sampled)…');
  interface ClvRow {
    proxy_wallet: string;
    avg_clv_1h: number | null;
    pct_positive_clv_1h: number | null;
  }
  const clvRows = await duck.query<ClvRow>(buildMarketEdgeCLVSql());
  const clvMap = new Map(clvRows.map(r => [r.proxy_wallet, r]));
  log(`[v3-refresh] clv: ${clvMap.size} wallets with CLV data`);

  // ── Pillar: Niche knowledge (top category per wallet) ─────────────────────
  log('[v3-refresh] computing niche knowledge scores…');
  interface NicheRow {
    proxy_wallet: string;
    category: string;
    cat_pnl: number;
    cat_volume_share: number;
  }
  const nicheRows = await duck.query<NicheRow>(buildNicheKnowledgeSql());
  // Keep only the top category per wallet (first row per wallet since SQL orders by cat_volume DESC)
  const nicheMap = new Map<string, NicheRow>();
  for (const row of nicheRows) {
    if (!nicheMap.has(row.proxy_wallet)) nicheMap.set(row.proxy_wallet, row);
  }
  log(`[v3-refresh] niche: ${nicheMap.size} wallets with category data`);

  // ── Copyability filter (market makers / algo traders) ─────────────────────
  log('[v3-refresh] computing copyability filter…');
  interface CopyRow { proxy_wallet: string; maker_ratio: number; copyable: number }
  const copyRows = await duck.query<CopyRow>(buildCopyabilityFilterSql());
  const copyMap = new Map(copyRows.map(r => [r.proxy_wallet, r]));
  const excludedCount = copyRows.filter(r => r.copyable === 0).length;
  log(`[v3-refresh] copyability: ${excludedCount} wallets excluded (maker/algo), ${copyMap.size} total`);

  const scoreableRows = rows.filter((r) => shouldIncludeInTierRankings(r.proxy_wallet, copyMap));
  if (scoreableRows.length < rows.length) {
    log(`[v3-refresh] tier scoring excludes ${rows.length - scoreableRows.length} non-copyable wallets`);
  }

  const { scores, stats } = scoreTiers(
    scoreableRows.map((r) => {
      const snap = {
        ...r,
        trade_count: Number(r.trade_count),
        distinct_markets: Number(r.distinct_markets),
        closed_positions: Number(r.closed_positions),
        first_active_ts: Number(r.first_active_ts),
        last_active_ts: Number(r.last_active_ts),
        observation_span_days: Number(r.observation_span_days),
      };
      const nicheRow = nicheMap.get(r.proxy_wallet);
      return {
        snapshot: snap,
        now_ts: now,
        niche: nicheRow
          ? { top_category: nicheRow.category, cat_volume_share: nicheRow.cat_volume_share, cat_pnl: nicheRow.cat_pnl }
          : undefined,
      };
    }),
    options.topN ?? 500
  );

  for (const s of scores) {
    const c = compMap.get(s.proxy_wallet);
    s.composite_score   = c?.composite_score   ?? null;
    s.momentum_score    = c?.momentum_score    ?? null;
    s.consistency_score = c?.consistency_score ?? null;

    // Brier / CLV / Niche / Copyability pillar columns
    s.brier_score           = brierMap.get(s.proxy_wallet) ?? null;
    const clv               = clvMap.get(s.proxy_wallet);
    s.avg_clv_1h            = clv?.avg_clv_1h ?? null;
    s.pct_positive_clv_1h   = clv?.pct_positive_clv_1h ?? null;
    const niche             = nicheMap.get(s.proxy_wallet);
    s.top_category          = niche?.category ?? null;
    s.cat_volume_share      = niche?.cat_volume_share ?? null;
    const copy              = copyMap.get(s.proxy_wallet);
    s.maker_ratio           = copy?.maker_ratio ?? null;
    s.copyable              = copy?.copyable ?? 1; // default copyable if no data

    if (c) {
      s.ditto_state = determineDittoState({
        // Use lifetime trade_count from the snapshot, not trades_7d from composite.
        // trades_7d can be 0 during quiet weeks, incorrectly triggering NEW_UNRANKED
        // for wallets that have a long history.
        trade_count: s.trade_count,
        pnl_7d: c.pnl_7d,
        momentum_z: c.momentum_z,
        bet_size_cv: c.bet_size_cv,
        tier_score: s.score,
      });
    } else {
      s.ditto_state = null;
    }
  }

  const { scores: publishScores, profileMeta, excluded } = await finalizeScoresForPublish(scores, {
    log: (msg) => log(msg),
  });
  if (excluded.length > 0) {
    for (const ex of excluded.slice(0, 10)) {
      log(`[v3-refresh] gate excluded ${ex.tier} ${ex.wallet}: ${ex.reason}`);
    }
    if (excluded.length > 10) {
      log(`[v3-refresh] … and ${excluded.length - 10} more excluded`);
    }
  }

  const tx = sqlite.transaction((list: typeof scores) => {
    sqlite.prepare('DELETE FROM discovery_wallet_scores_v3').run();
    const ins = sqlite.prepare(
      `INSERT INTO discovery_wallet_scores_v3
         (proxy_wallet, tier, tier_rank, score, volume_total, trade_count,
          distinct_markets, closed_positions, realized_pnl, hit_rate,
          last_active_ts, reasons_json, updated_at,
          composite_score, momentum_score, consistency_score, ditto_state,
          brier_score, avg_clv_1h, pct_positive_clv_1h,
          top_category, cat_volume_share, maker_ratio, copyable,
          predictions_count, profile_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const s of list) {
      const meta = profileMeta.get(s.proxy_wallet);
      ins.run(
        s.proxy_wallet, s.tier, s.tier_rank, s.score, s.volume_total,
        s.trade_count, s.distinct_markets, s.closed_positions,
        s.realized_pnl, s.hit_rate, s.last_active_ts, s.reasons_json, s.updated_at,
        s.composite_score     ?? null, s.momentum_score       ?? null,
        s.consistency_score   ?? null, s.ditto_state           ?? null,
        s.brier_score         ?? null, s.avg_clv_1h             ?? null,
        s.pct_positive_clv_1h ?? null,
        s.top_category        ?? null, s.cat_volume_share       ?? null,
        s.maker_ratio         ?? null, s.copyable               ?? 1,
        meta?.predictionsCount ?? null,
        meta?.profileName ?? null
      );
    }
  });
  tx(publishScores);
  log(
    `[v3-refresh] wrote ${publishScores.length} rows (eligible ${stats.eligible}/${stats.total}, ` +
      `gate excluded ${excluded.length})`
  );
  return { snapshotRows: Number(snapshotCount), scored: publishScores.length, eligible: stats.eligible };
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
