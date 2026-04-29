/**
 * Phase 1.5 step 4 — Stage F resume script.
 *
 * Background
 * ──────────
 * The full 04_emit_snapshots.ts ran stages A–E to completion (1.7 h of work,
 * spanning 133M (wallet, market) rows and 25.7M (wallet, day) PnL rows), then
 * stage F (merge + window + INSERT) OOM'd at 5.5 GiB during the cumulative
 * window function over the full merged dataset.
 *
 * The staging tables _emit_da and _emit_dp are persisted in the DuckDB file
 * (they're regular tables, not TEMP), so we can resume from them without
 * redoing A–E.
 *
 * Fix: chunk the window by hash(proxy_wallet) % N. Because the window is
 * PARTITION BY proxy_wallet, wallets in different buckets never share a
 * window partition — the chunked output is byte-identical to the unchunked
 * version, but each chunk only sorts/windows ~1/N of the data.
 *
 * Knobs (env, all optional):
 *   DUCKDB_MEMORY_LIMIT_GB   default 5
 *   DUCKDB_THREADS           default 2
 *   DUCKDB_MAX_TEMP_DIR_GB   default 40
 *   STAGE_F_CHUNKS           default 16
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

function logStage(label: string, t0: number): void {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[04F] ${label} (${secs}s)`);
}

async function main(): Promise<void> {
  const db = openDuckDB(getDuckDBPath());
  try {
    const memLimit = process.env.DUCKDB_MEMORY_LIMIT_GB || '5';
    const threads = process.env.DUCKDB_THREADS || '2';
    const tempCap = process.env.DUCKDB_MAX_TEMP_DIR_GB || '40';
    const N = Math.max(2, parseInt(process.env.STAGE_F_CHUNKS || '16', 10));
    await db.exec(`SET memory_limit = '${memLimit}GB'`);
    await db.exec(`SET threads = ${threads}`);
    await db.exec(`SET max_temp_directory_size = '${tempCap}GiB'`);
    await db.exec(`SET preserve_insertion_order = false`);
    console.log(
      `[04F] tuned: memory_limit=${memLimit}GB threads=${threads} ` +
        `temp_cap=${tempCap}GiB chunks=${N}`,
    );

    // Sanity-check the staging tables actually exist
    const stagingCheck = await db.query<{ name: string }>(`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_name IN ('_emit_da', '_emit_dp')
    `);
    const found = new Set(stagingCheck.map((r) => r.name));
    if (!found.has('_emit_da') || !found.has('_emit_dp')) {
      throw new Error(
        `staging tables missing — expected _emit_da and _emit_dp, found [${[...found].join(', ')}]. ` +
          `Re-run 04_emit_snapshots.ts from scratch.`,
      );
    }
    const daRows = (
      await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM _emit_da')
    )[0].c;
    const dpRows = (
      await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM _emit_dp')
    )[0].c;
    console.log(`[04F] staging found: _emit_da=${daRows} rows, _emit_dp=${dpRows} rows`);

    // Wipe target table — we're rebuilding it deterministically
    console.log('[04F] clearing discovery_feature_snapshots_v3 for full rebuild');
    await db.exec('DELETE FROM discovery_feature_snapshots_v3');

    // ─── Stage F (chunked) ──────────────────────────────────────────────────
    // For each bucket i in [0, N), only consider wallets where
    // hash(proxy_wallet) % N = i. The window function PARTITION BY proxy_wallet
    // is fully contained within each bucket, so output is identical to the
    // unchunked version.
    const tWall = Date.now();
    let totalInserted = 0;
    for (let i = 0; i < N; i++) {
      const t0 = Date.now();
      await db.exec(`
        INSERT INTO discovery_feature_snapshots_v3
        WITH
        merged AS (
          SELECT
            COALESCE(da.proxy_wallet, dp.proxy_wallet)   AS proxy_wallet,
            COALESCE(da.snapshot_day, dp.snapshot_day)   AS snapshot_day,
            COALESCE(da.trade_count_day, 0)              AS trade_count_day,
            COALESCE(da.volume_day, 0.0)                 AS volume_day,
            COALESCE(da.distinct_markets_day, 0)         AS distinct_markets_day,
            da.first_active_ts_day                       AS first_active_ts_day,
            da.last_active_ts_day                        AS last_active_ts_day,
            COALESCE(dp.closed_positions_day, 0)         AS closed_positions_day,
            COALESCE(dp.realized_pnl_day, 0.0)           AS realized_pnl_day,
            COALESCE(dp.unrealized_pnl_day, 0.0)         AS unrealized_pnl_day
          FROM (SELECT * FROM _emit_da WHERE hash(proxy_wallet) % ${N} = ${i}) da
          FULL OUTER JOIN
               (SELECT * FROM _emit_dp WHERE hash(proxy_wallet) % ${N} = ${i}) dp
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
      const cumulative = (
        await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_feature_snapshots_v3')
      )[0].c;
      const inserted = Number(cumulative) - totalInserted;
      totalInserted = Number(cumulative);
      logStage(`  F chunk ${i + 1}/${N}: +${inserted} rows (total ${totalInserted})`, t0);
    }
    logStage(`stage F done: ${totalInserted} snapshot rows`, tWall);

    // ─── Cleanup staging tables ─────────────────────────────────────────────
    console.log('[04F] dropping staging tables');
    await db.exec('DROP TABLE IF EXISTS _emit_da');
    await db.exec('DROP TABLE IF EXISTS _emit_dp');
    console.log('[04F] done.');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[04F] failed:', err);
  process.exit(1);
});
