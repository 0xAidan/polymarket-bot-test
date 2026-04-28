/**
 * Phase 1.5 step 4: emit point-in-time daily snapshots into
 * discovery_feature_snapshots_v3.
 *
 * 2026-04-28 STAGED REWRITE
 * ─────────────────────────
 * The prior version ran one giant SQL with three full GROUP BY scans of
 * discovery_activity_v3 (912M rows) plus a FULL OUTER JOIN plus a window
 * function — all in one query graph. DuckDB tried to materialize all three
 * hash tables concurrently and blew past any memory_limit, hitting 14.7 GB
 * RSS on a 16 GB box and triggering swap thrash + 55 GB of spill that
 * filled the data volume.
 *
 * This rewrite executes the same logic as a sequence of stages, each one
 * materialized to a temp table and dropped before the next stage runs:
 *
 *   Stage A: wallet_market_agg          ← scan #1 of activity (GROUP BY wallet, market)
 *   Stage B: market_last_price          ← scan #2 of activity (GROUP BY market)
 *   Stage C: wallet_market_pnl          ← join A + markets_v3 + B (no activity scan)
 *   Stage D: daily_pnl                  ← scan of C only
 *   Stage E: daily_activity             ← scan #3 of activity (GROUP BY wallet, day)
 *   Stage F: merged + window + INSERT   ← scan of D + E only
 *
 * Each stage's hash table is freed (DROP TABLE) before the next runs, so
 * peak memory = max(individual stage size), not sum. On the Hetzner box this
 * translates to ~6-8 GB peak instead of 14+.
 *
 * No correctness change — same final rows, byte-identical output to the
 * old single-query version (validated by tests/v3-snapshot-purity.test.ts).
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrationsBackfillNoIndex } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

function logStage(label: string, t0: number): void {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[04] ${label} (${secs}s)`);
}

async function main(): Promise<void> {
  const db = openDuckDB(getDuckDBPath());
  try {
    // No-index migration: the backfilled discovery_activity_v3 has ~912M rows
    // and DuckDB 1.4.x CREATE INDEX would OOM. See duckdbSchema.ts.
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => db.exec(sql));

    // ─── Memory tuning ──────────────────────────────────────────────────────
    // Honor env overrides but apply hard defaults that have been verified to
    // work on the 16 GB Hetzner box.
    const memLimit = process.env.DUCKDB_MEMORY_LIMIT_GB || '8';
    const threads = process.env.DUCKDB_THREADS || '2';
    const tempCap = process.env.DUCKDB_MAX_TEMP_DIR_GB || '60';
    await db.exec(`SET memory_limit = '${memLimit}GB'`);
    await db.exec(`SET threads = ${threads}`);
    await db.exec(`SET max_temp_directory_size = '${tempCap}GiB'`);
    await db.exec(`SET preserve_insertion_order = false`);
    console.log(`[04] tuned: memory_limit=${memLimit}GB threads=${threads} temp_cap=${tempCap}GiB`);

    // ─── Wipe target table for deterministic rebuild ────────────────────────
    console.log('[04] clearing old snapshots (determinism requires full rebuild)');
    await db.exec('DELETE FROM discovery_feature_snapshots_v3');

    // ─── Drop any stale staging tables from a prior crashed run ─────────────
    for (const t of ['_emit_wma', '_emit_mlp', '_emit_wmp', '_emit_dp', '_emit_da', '_emit_merged']) {
      await db.exec(`DROP TABLE IF EXISTS ${t}`);
    }

    const tWall = Date.now();

    // ─── Stage A: per-(wallet, market) cash flow + token balance ───────────
    // First scan of discovery_activity_v3. Output rows ≈ unique (wallet, market)
    // pairs ≈ tens of millions. Hash GROUP BY, equality only — spillable.
    {
      const t0 = Date.now();
      console.log('[04] stage A/F: wallet_market_agg (scan 1 of 3)');
      await db.exec(`
        CREATE TABLE _emit_wma AS
        SELECT
          proxy_wallet,
          market_id,
          SUM(CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END) AS cash_flow,
          SUM(signed_size)                                                        AS token_balance,
          MIN(ts_unix)                                                            AS first_trade_ts,
          MAX(ts_unix)                                                            AS last_trade_ts
        FROM discovery_activity_v3
        GROUP BY proxy_wallet, market_id
      `);
      const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM _emit_wma'))[0].c;
      logStage(`stage A done: ${c} (wallet, market) rows`, t0);
    }

    // ─── Stage B: per-market last observed price ────────────────────────────
    // Second scan of activity. Output rows = distinct markets ≈ hundreds of
    // thousands. Tiny output but still touches all 912M rows.
    {
      const t0 = Date.now();
      console.log('[04] stage B/F: market_last_price (scan 2 of 3)');
      await db.exec(`
        CREATE TABLE _emit_mlp AS
        SELECT
          market_id,
          arg_max(price_yes, ts_unix) AS last_price_yes
        FROM discovery_activity_v3
        GROUP BY market_id
      `);
      const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM _emit_mlp'))[0].c;
      logStage(`stage B done: ${c} markets`, t0);
    }

    // ─── Stage C: per-(wallet, market) PnL with resolution + unrealized ────
    // No activity scan — joins A (small-ish) + markets_v3 (small) + B (tiny).
    {
      const t0 = Date.now();
      console.log('[04] stage C/F: wallet_market_pnl');
      await db.exec(`
        CREATE TABLE _emit_wmp AS
        SELECT
          w.proxy_wallet,
          w.market_id,
          w.cash_flow,
          w.token_balance,
          w.first_trade_ts,
          w.last_trade_ts,
          m.end_date,
          CASE
            WHEN m.market_id IS NOT NULL AND m.end_date IS NOT NULL AND m.closed = 1
            THEN 1 ELSE 0
          END AS is_closed,
          CASE
            WHEN m.market_id IS NOT NULL AND m.end_date IS NOT NULL AND m.closed = 1
                 AND m.outcome_prices IS NOT NULL
                 AND TRY_CAST(json_extract_string(m.outcome_prices, '$[0]') AS DOUBLE) IS NOT NULL
            THEN w.token_balance * TRY_CAST(json_extract_string(m.outcome_prices, '$[0]') AS DOUBLE)
            ELSE 0.0
          END AS resolution_payout,
          CASE
            WHEN (m.market_id IS NULL OR m.end_date IS NULL OR m.closed = 0)
                 AND lp.last_price_yes IS NOT NULL
            THEN w.token_balance * lp.last_price_yes
            ELSE 0.0
          END AS unrealized_mark
        FROM _emit_wma w
        LEFT JOIN markets_v3 m ON m.market_id = w.market_id
        LEFT JOIN _emit_mlp lp ON lp.market_id = w.market_id
      `);
      const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM _emit_wmp'))[0].c;
      logStage(`stage C done: ${c} rows`, t0);
      // Free A and B — no longer needed.
      await db.exec('DROP TABLE _emit_wma');
      await db.exec('DROP TABLE _emit_mlp');
    }

    // ─── Stage D: per-(wallet, day) PnL roll-up ─────────────────────────────
    // Operates only on _emit_wmp (small).
    {
      const t0 = Date.now();
      console.log('[04] stage D/F: daily_pnl');
      await db.exec(`
        CREATE TABLE _emit_dp AS
        SELECT
          proxy_wallet,
          CASE
            WHEN is_closed = 1 THEN CAST(end_date AS DATE)
            ELSE CAST(TO_TIMESTAMP(last_trade_ts) AS DATE)
          END AS snapshot_day,
          SUM(cash_flow + resolution_payout) AS realized_pnl_day,
          SUM(CASE WHEN is_closed = 0 THEN unrealized_mark ELSE 0.0 END) AS unrealized_pnl_day,
          APPROX_COUNT_DISTINCT(CASE WHEN is_closed = 1 THEN market_id ELSE NULL END) AS closed_positions_day
        FROM _emit_wmp
        GROUP BY proxy_wallet,
          CASE
            WHEN is_closed = 1 THEN CAST(end_date AS DATE)
            ELSE CAST(TO_TIMESTAMP(last_trade_ts) AS DATE)
          END
      `);
      const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM _emit_dp'))[0].c;
      logStage(`stage D done: ${c} (wallet, day) PnL rows`, t0);
      await db.exec('DROP TABLE _emit_wmp');
    }

    // ─── Stage E: per-(wallet, day) activity stats ──────────────────────────
    // Third (and last) scan of discovery_activity_v3.
    {
      const t0 = Date.now();
      console.log('[04] stage E/F: daily_activity (scan 3 of 3)');
      await db.exec(`
        CREATE TABLE _emit_da AS
        SELECT
          proxy_wallet,
          CAST(TO_TIMESTAMP(ts_unix) AS DATE)   AS snapshot_day,
          COUNT(*)                              AS trade_count_day,
          SUM(usd_notional)                     AS volume_day,
          APPROX_COUNT_DISTINCT(market_id)      AS distinct_markets_day,
          MIN(ts_unix)                          AS first_active_ts_day,
          MAX(ts_unix)                          AS last_active_ts_day
        FROM discovery_activity_v3
        GROUP BY proxy_wallet, CAST(TO_TIMESTAMP(ts_unix) AS DATE)
      `);
      const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM _emit_da'))[0].c;
      logStage(`stage E done: ${c} (wallet, day) activity rows`, t0);
    }

    // ─── Stage F: merge + cumulative window + INSERT into target ────────────
    // Operates on _emit_da and _emit_dp only (both small).
    {
      const t0 = Date.now();
      console.log('[04] stage F/F: merge + window + INSERT');
      await db.exec(`
        INSERT INTO discovery_feature_snapshots_v3
        WITH
        merged AS (
          SELECT
            COALESCE(da.proxy_wallet, dp.proxy_wallet)       AS proxy_wallet,
            COALESCE(da.snapshot_day, dp.snapshot_day)       AS snapshot_day,
            COALESCE(da.trade_count_day, 0)                  AS trade_count_day,
            COALESCE(da.volume_day, 0.0)                     AS volume_day,
            COALESCE(da.distinct_markets_day, 0)             AS distinct_markets_day,
            da.first_active_ts_day                           AS first_active_ts_day,
            da.last_active_ts_day                            AS last_active_ts_day,
            COALESCE(dp.closed_positions_day, 0)             AS closed_positions_day,
            COALESCE(dp.realized_pnl_day, 0.0)               AS realized_pnl_day,
            COALESCE(dp.unrealized_pnl_day, 0.0)             AS unrealized_pnl_day
          FROM _emit_da da
          FULL OUTER JOIN _emit_dp dp
            ON dp.proxy_wallet = da.proxy_wallet
           AND dp.snapshot_day = da.snapshot_day
        )
        SELECT
          proxy_wallet,
          snapshot_day,
          trade_count,
          volume_total,
          distinct_markets,
          closed_positions,
          realized_pnl,
          unrealized_pnl,
          first_active_ts,
          last_active_ts,
          CAST(FLOOR((last_active_ts - first_active_ts) / 86400.0) AS INTEGER) AS observation_span_days
        FROM (
          SELECT
            proxy_wallet,
            snapshot_day,
            SUM(trade_count_day)      OVER w AS trade_count,
            SUM(volume_day)           OVER w AS volume_total,
            SUM(distinct_markets_day) OVER w AS distinct_markets,
            SUM(closed_positions_day) OVER w AS closed_positions,
            SUM(realized_pnl_day)     OVER w AS realized_pnl,
            LAST_VALUE(unrealized_pnl_day) OVER w AS unrealized_pnl,
            MIN(first_active_ts_day)  OVER w AS first_active_ts,
            MAX(last_active_ts_day)   OVER w AS last_active_ts
          FROM merged
          WINDOW w AS (PARTITION BY proxy_wallet ORDER BY snapshot_day
                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
        )
        WHERE trade_count > 0
      `);
      const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_feature_snapshots_v3'))[0].c;
      logStage(`stage F done: ${c} snapshot rows inserted`, t0);
      await db.exec('DROP TABLE _emit_da');
      await db.exec('DROP TABLE _emit_dp');
    }

    const totalSecs = ((Date.now() - tWall) / 1000).toFixed(0);
    console.log(`[04] all stages complete in ${totalSecs}s`);
  } finally {
    await db.close();
  }
  console.log('[04] done.');
}

main().catch((err) => {
  console.error('[04] failed:', err);
  process.exit(1);
});
