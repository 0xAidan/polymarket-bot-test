/**
 * Phase 1.5 step 5: read the most recent snapshot per wallet from DuckDB,
 * apply eligibility gates, compute tier scores, write top-N per tier to
 * the SQLite hot read model (`discovery_wallet_scores_v3`).
 *
 * 2026-04-27 fix — "05-score-and-publish-oom":
 *   On the 8GB Hetzner staging box this script OOM'd inside DuckDB with
 *
 *     Out of Memory Error: could not allocate block of size 256.0 KiB
 *     (5.5 GiB/5.5 GiB used)
 *
 *   Three independent issues were compounding; all three are fixed here:
 *
 *   (1) The original "latest snapshot per wallet" query used
 *       ROW_NUMBER() OVER (PARTITION BY proxy_wallet ORDER BY snapshot_day DESC)
 *       wrapped in WHERE rn = 1. That window function forces DuckDB to
 *       materialise the entire partitioned + sorted result before it can
 *       drop non-latest rows — a multi-GB peak on the v3 snapshot table.
 *       Replaced with a streaming hash aggregate using ARG_MAX(struct,
 *       snapshot_day): one row per wallet, no global sort, no window
 *       materialisation.
 *
 *   (2) The DuckDB pragmas that 04_emit_snapshots.ts set after its OOM
 *       (preserve_insertion_order=false, max_temp_directory_size='100GiB')
 *       were missing here. Without max_temp_directory_size pinned,
 *       DuckDB defaults the spill cap to ~90% of FREE disk at spill time,
 *       which on a crowded volume computes a tiny (~7 GB) cap and the
 *       sort hits OOM instead of spilling. Mirrored 04's settings so any
 *       remaining large operator can spill freely on the staging volume.
 *
 *   (3) The result of the latest-snapshot query was buffered into a single
 *       JS array via DuckDB's `conn.all(...)`, doubling peak memory while
 *       DuckDB was still holding its own working set. We now stream the
 *       latest-snapshot rows into JS in keyset-paginated batches off a
 *       small temp table (one row per wallet, fits easily in RAM) and
 *       only assemble the array in JS — DuckDB releases its working set
 *       before we ever materialise on the Node side.
 *
 *   Eligibility filtering and tier scoring are unchanged: scoreTiers
 *   computes z-scores across the entire eligible cohort and keeps a
 *   global top-N per tier, so it must run once over the full set.
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

// Streaming read batch size for pulling rows from DuckDB into JS.
// 100k rows × ~120B/row ≈ 12 MiB per batch — comfortable on the 8GB box
// even with DuckDB at its memory_limit. Override with V3_SCORE_READ_BATCH
// for tuning without code changes.
const READ_BATCH_SIZE = Number(process.env.V3_SCORE_READ_BATCH ?? 100_000);

async function main(): Promise<void> {
  const duck = openDuckDB(getDuckDBPath());

  try {
    // Use the no-index migration — the backfilled discovery_activity_v3
    // has ~800M rows and DuckDB 1.4.x CREATE INDEX would OOM.
    // See src/discovery/v3/duckdbSchema.ts for the full rationale.
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => duck.exec(sql));
<<<<<<< HEAD
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
=======
>>>>>>> origin

    // Mirror 04_emit_snapshots' pragmas so any large operator (the
    // ARG_MAX hash aggregate below, or its temp materialisation) can
    // spill freely instead of hitting DuckDB's memory_limit. Same
    // rationale as 04 — see that file's header comment for the full
    // story on preserve_insertion_order and max_temp_directory_size.
    await duck.exec('SET preserve_insertion_order = false');
    await duck.exec("SET max_temp_directory_size = '100GiB'");

    // (1) Build a one-row-per-wallet "latest snapshot" temp table using
    // ARG_MAX over GROUP BY. DuckDB executes this as a streaming hash
    // aggregate — no global sort, no window materialisation — which is
    // what blew up on the 8GB box with the previous ROW_NUMBER() form.
    //
    // ARG_MAX(expr, key) returns expr from the row that has the maximum
    // key inside each group. We pack every column into a STRUCT so a
    // single aggregate produces the whole "winner" row per wallet.
    console.log('[05] building latest-snapshot temp table (ARG_MAX hash aggregate)…');
    const t0 = Date.now();
    await duck.exec('DROP TABLE IF EXISTS tmp_latest_snapshots_v3');
    await duck.exec(
      `CREATE TEMP TABLE tmp_latest_snapshots_v3 AS
       SELECT
         proxy_wallet,
         (ARG_MAX(
            STRUCT_PACK(
              snapshot_day          := snapshot_day,
              trade_count           := trade_count,
              volume_total          := volume_total,
              distinct_markets      := distinct_markets,
              closed_positions      := closed_positions,
              realized_pnl          := realized_pnl,
              unrealized_pnl        := unrealized_pnl,
              first_active_ts       := first_active_ts,
              last_active_ts        := last_active_ts,
              observation_span_days := observation_span_days
            ),
            snapshot_day
          )) AS s
       FROM discovery_feature_snapshots_v3
       GROUP BY proxy_wallet`
    );
    const totalRow = await duck.query<{ c: number | bigint }>(
      'SELECT COUNT(*)::BIGINT AS c FROM tmp_latest_snapshots_v3'
    );
    const total = Number(totalRow[0]?.c ?? 0);
    console.log(`[05] latest-snapshot temp table: ${total} wallets in ${Math.round((Date.now() - t0) / 1000)}s`);

    // (3) Stream the temp table out in keyset batches sorted by
    // proxy_wallet (lexicographic, deterministic, no NULLs because the
    // column is NOT NULL in the source schema). We never SELECT * from
    // the whole temp table in one shot, so the JS array grows linearly
    // without a doubled-up "DuckDB result + JS array" peak.
    console.log(`[05] streaming wallets into JS (batch=${READ_BATCH_SIZE})…`);
    interface LatestRow { proxy_wallet: string; s: Record<string, unknown> }
    const rows: V3FeatureSnapshot[] = [];
    let cursor: string | null = null;
    for (;;) {
      const batch: LatestRow[] = await duck.query<LatestRow>(
        cursor === null
          ? `SELECT proxy_wallet, s
             FROM tmp_latest_snapshots_v3
             ORDER BY proxy_wallet
             LIMIT ${READ_BATCH_SIZE}`
          : `SELECT proxy_wallet, s
             FROM tmp_latest_snapshots_v3
             WHERE proxy_wallet > ?
             ORDER BY proxy_wallet
             LIMIT ${READ_BATCH_SIZE}`,
        cursor === null ? [] : [cursor]
      );
      if (batch.length === 0) break;
      for (const row of batch) {
        const s = row.s as Record<string, unknown>;
        rows.push({
          proxy_wallet:          row.proxy_wallet,
          snapshot_day:          String(s.snapshot_day),
          trade_count:           Number(s.trade_count),
          volume_total:          Number(s.volume_total),
          distinct_markets:      Number(s.distinct_markets),
          closed_positions:      Number(s.closed_positions),
          realized_pnl:          Number(s.realized_pnl),
          unrealized_pnl:        Number(s.unrealized_pnl),
          first_active_ts:       Number(s.first_active_ts),
          last_active_ts:        Number(s.last_active_ts),
          observation_span_days: Number(s.observation_span_days),
        });
      }
      cursor = batch[batch.length - 1].proxy_wallet;
      if (batch.length < READ_BATCH_SIZE) break;
    }
    // Drop the temp table eagerly so DuckDB releases its memory before
    // tier scoring runs in JS (z-scores + percentile ranks are O(N)
    // with small constants — a few hundred MB at most for the eligible
    // cohort, but we'd rather not have DuckDB holding RAM in parallel).
    await duck.exec('DROP TABLE IF EXISTS tmp_latest_snapshots_v3');

    console.log(`[05] scoring ${rows.length} wallets`);
    const now = Math.floor(Date.now() / 1000);
    const { scores, stats } = scoreTiers(
      rows.map((r) => ({ snapshot: r, now_ts: now }))
    );
    console.log(
      `[05] eligibility: ${stats.eligible}/${stats.total} (rejection ${(stats.rejection_rate * 100).toFixed(1)}%)`
    );

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
