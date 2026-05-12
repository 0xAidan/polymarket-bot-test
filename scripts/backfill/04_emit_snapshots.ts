/**
 * Phase 1.5 step 4: emit point-in-time daily snapshots into
 * discovery_feature_snapshots_v3.
 *
 * 2026-04-28 CHUNKED-STAGED REWRITE (v3)
 * ──────────────────────────────────────
 * History:
 *  v1 (original): single giant SQL with 3 concurrent activity-table GROUP BY
 *      scans + FULL OUTER JOIN + window. Hit 14.7 GB RSS on the 16 GB Hetzner
 *      box, 55 GB spill, OOM-thrashed.
 *  v2 (staged):   split into 6 sequential stages with DROP TABLE between
 *      them. Reduced peak memory but stage A's GROUP BY over 912M rows still
 *      spilled ~75 GB on its own — too much for the 127 GB-free volume once
 *      the live db is also there.
 *  v3 (this version): for the three full-activity-table stages (A, B, E),
 *      chunk the input by hash buckets so no single GROUP BY is more than
 *      ~1/N of the table. Per-chunk spill stays small (~3–5 GB), and each
 *      chunk's hash table is freed before the next. Total wall time ~= same
 *      as v2 (we still scan the table N times per stage, but each scan is
 *      filter-pushed-down to that bucket's rows — DuckDB still reads the
 *      whole table physically, but only hashes 1/N of it).
 *
 *      Wallet-based stages (A, E): bucket = hash(proxy_wallet) % N
 *      Market-based stage (B):     bucket = hash(market_id)    % N
 *
 *      Results from each chunk INSERT into a single accumulator table per
 *      stage (_emit_wma, _emit_mlp, _emit_da). Final stages (C, D, F)
 *      operate on those accumulators only — no activity scan.
 *
 * Knobs (env, all optional):
 *   DUCKDB_MEMORY_LIMIT_GB   default 6
 *   DUCKDB_THREADS           default 2
 *   DUCKDB_MAX_TEMP_DIR_GB   default 40
 *   EMIT_CHUNKS              default 16   (number of hash buckets per stage)
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
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => db.exec(sql));

    // ─── Memory tuning ──────────────────────────────────────────────────────
    const memLimit = process.env.DUCKDB_MEMORY_LIMIT_GB || '6';
    const threads = process.env.DUCKDB_THREADS || '2';
    const tempCap = process.env.DUCKDB_MAX_TEMP_DIR_GB || '40';
    const N = Math.max(2, parseInt(process.env.EMIT_CHUNKS || '16', 10));
    await db.exec(`SET memory_limit = '${memLimit}GB'`);
    await db.exec(`SET threads = ${threads}`);
    await db.exec(`SET max_temp_directory_size = '${tempCap}GiB'`);
    await db.exec(`SET preserve_insertion_order = false`);
    console.log(
      `[04] tuned: memory_limit=${memLimit}GB threads=${threads} ` +
        `temp_cap=${tempCap}GiB chunks=${N}`,
    );

    // ─── Wipe target table for deterministic rebuild ────────────────────────
    console.log('[04] clearing old snapshots (determinism requires full rebuild)');
    await db.exec('DELETE FROM discovery_feature_snapshots_v3');

    // ─── Drop any stale staging tables from a prior crashed run ─────────────
    for (const t of ['_emit_wma', '_emit_mlp', '_emit_wmp', '_emit_dp', '_emit_da']) {
      await db.exec(`DROP TABLE IF EXISTS ${t}`);
    }

    const tWall = Date.now();

    // ─── Stage A: per-(wallet, market) cash flow + token balance ───────────
    // Chunked by hash(proxy_wallet) % N. Each chunk does its own GROUP BY,
    // INSERTs into _emit_wma, then frees its hash table before the next
    // chunk runs. Per-chunk spill stays bounded.
    {
      const tStage = Date.now();
      console.log(`[04] stage A/F: wallet_market_agg in ${N} chunks`);
      await db.exec(`
        CREATE TABLE _emit_wma (
          proxy_wallet     VARCHAR,
          market_id        VARCHAR,
          cash_flow        DOUBLE,
          token_balance    DOUBLE,
          first_trade_ts   UBIGINT,
          last_trade_ts    UBIGINT
        )
      `);
      for (let i = 0; i < N; i++) {
        const t0 = Date.now();
        await db.exec(`
          INSERT INTO _emit_wma
          SELECT
            proxy_wallet,
            market_id,
            SUM(CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END) AS cash_flow,
            SUM(signed_size)                                                        AS token_balance,
            MIN(ts_unix)                                                            AS first_trade_ts,
            MAX(ts_unix)                                                            AS last_trade_ts
          FROM discovery_activity_v3
          WHERE hash(proxy_wallet) % ${N} = ${i}
          GROUP BY proxy_wallet, market_id
        `);
        logStage(`  A chunk ${i + 1}/${N}`, t0);
      }
      const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM _emit_wma'))[0].c;
      logStage(`stage A done: ${c} (wallet, market) rows`, tStage);
    }

    // ─── Stage B: per-market last observed price ────────────────────────────
    // Chunked by hash(market_id) % N. Output is small (~hundreds of
    // thousands of markets total) but hash table during build can be large.
    {
      const tStage = Date.now();
      console.log(`[04] stage B/F: market_last_price in ${N} chunks`);
      await db.exec(`
        CREATE TABLE _emit_mlp (
          market_id      VARCHAR,
          last_price_yes DOUBLE
        )
      `);
      for (let i = 0; i < N; i++) {
        const t0 = Date.now();
        await db.exec(`
          INSERT INTO _emit_mlp
          SELECT
            market_id,
            arg_max(price_yes, ts_unix) AS last_price_yes
          FROM discovery_activity_v3
          WHERE hash(market_id) % ${N} = ${i}
          GROUP BY market_id
        `);
        logStage(`  B chunk ${i + 1}/${N}`, t0);
      }
      const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM _emit_mlp'))[0].c;
      logStage(`stage B done: ${c} markets`, tStage);
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
      await db.exec('DROP TABLE _emit_wma');
      await db.exec('DROP TABLE _emit_mlp');
    }

    // ─── Stage D: per-(wallet, day) PnL roll-up ─────────────────────────────
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
    // Chunked by hash(proxy_wallet) % N.
    {
      const tStage = Date.now();
      console.log(`[04] stage E/F: daily_activity in ${N} chunks`);
      await db.exec(`
        CREATE TABLE _emit_da (
          proxy_wallet         VARCHAR,
          snapshot_day         DATE,
          trade_count_day      BIGINT,
          volume_day           DOUBLE,
          distinct_markets_day BIGINT,
          first_active_ts_day  UBIGINT,
          last_active_ts_day   UBIGINT
        )
      `);
      for (let i = 0; i < N; i++) {
        const t0 = Date.now();
        await db.exec(`
          INSERT INTO _emit_da
          SELECT
            proxy_wallet,
            CAST(TO_TIMESTAMP(ts_unix) AS DATE)   AS snapshot_day,
            COUNT(*)                              AS trade_count_day,
            SUM(usd_notional)                     AS volume_day,
            APPROX_COUNT_DISTINCT(market_id)      AS distinct_markets_day,
            MIN(ts_unix)                          AS first_active_ts_day,
            MAX(ts_unix)                          AS last_active_ts_day
          FROM discovery_activity_v3
          WHERE hash(proxy_wallet) % ${N} = ${i}
          GROUP BY proxy_wallet, CAST(TO_TIMESTAMP(ts_unix) AS DATE)
        `);
        logStage(`  E chunk ${i + 1}/${N}`, t0);
      }
      const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM _emit_da'))[0].c;
      logStage(`stage E done: ${c} (wallet, day) activity rows`, tStage);
    }

    // ─── Stage F: merge + cumulative window + INSERT into target ────────────
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
