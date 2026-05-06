/**
 * DuckDB queries for computing per-wallet Composite Score raw stats.
 *
 * These queries run against `discovery_activity_v3` and produce the
 * intermediate stats that `compositeScoring.ts` uses to compute pillar scores.
 */

/**
 * Result row returned by buildCompositeScoringQuery. All scoring and
 * percentile ranking is done inside DuckDB so only the final scored rows
 * cross the JS boundary.
 */
export interface CompositeScoredRow {
  proxy_wallet: string;
  composite_score: number;
  momentum_score: number;
  consistency_score: number;
  momentum_z: number;
  bet_size_cv: number;
  pnl_7d: number;
  trades_7d: number;
}

/**
 * Full pipeline query: computes raw stats, applies pillar scoring logic,
 * percentile-ranks across the cohort, and returns the top-N scored wallets —
 * all inside DuckDB. Nothing large crosses the JS heap boundary.
 *
 * Percentile rank formula matches the JS percentileRank helper:
 *   pct = (ROW_NUMBER() OVER (ORDER BY val ASC) - 0.5) / COUNT(*) OVER ()
 * which maps the lowest value to ~0 and highest to ~1 (no hard 0/1 edges).
 *
 * @param nowTsUnix — current Unix timestamp (seconds).
 * @param topN      — max rows to return (use a large number to get all).
 */
export function buildCompositeScoringQuery(nowTsUnix: number, topN: number): string {
  const ts7d  = nowTsUnix - 7  * 86400;
  const ts30d = nowTsUnix - 30 * 86400;

  return `
    WITH bet_stats AS (
      SELECT
        proxy_wallet,
        AVG(usd_notional)                                           AS avg_bet_size,
        STDDEV(usd_notional)                                        AS std_bet_size,
        CASE WHEN AVG(usd_notional) > 0
             THEN STDDEV(usd_notional) / AVG(usd_notional)
             ELSE 0
        END                                                         AS bet_size_cv,
        COUNT(*)                                                    AS total_bets,
        AVG(CASE WHEN ts_unix >= ${ts7d} THEN usd_notional END)    AS avg_bet_7d,
        MAX(usd_notional)                                           AS max_bet_size
      FROM discovery_activity_v3
      GROUP BY proxy_wallet
      HAVING COUNT(*) >= 10
    ),
    daily_pnl AS (
      SELECT
        proxy_wallet,
        CAST(TO_TIMESTAMP(ts_unix) AS DATE)        AS trade_day,
        SUM(usd_notional * (price_yes - 0.5))      AS daily_pnl,
        COUNT(*)                                   AS daily_trades
      FROM discovery_activity_v3
      WHERE proxy_wallet IN (SELECT proxy_wallet FROM bet_stats)
      GROUP BY proxy_wallet, CAST(TO_TIMESTAMP(ts_unix) AS DATE)
    ),
    momentum AS (
      SELECT
        proxy_wallet,
        COALESCE(SUM(CASE WHEN trade_day >= CAST(TO_TIMESTAMP(${ts7d})  AS DATE)
                          THEN daily_pnl   ELSE 0 END), 0) AS pnl_7d,
        COALESCE(SUM(CASE WHEN trade_day >= CAST(TO_TIMESTAMP(${ts7d})  AS DATE)
                          THEN daily_trades ELSE 0 END), 0) AS trades_7d,
        COALESCE(SUM(CASE WHEN trade_day >= CAST(TO_TIMESTAMP(${ts30d}) AS DATE)
                          THEN daily_pnl   ELSE 0 END), 0) AS pnl_30d,
        COALESCE(SUM(CASE WHEN trade_day >= CAST(TO_TIMESTAMP(${ts30d}) AS DATE)
                          THEN daily_trades ELSE 0 END), 0) AS trades_30d,
        AVG(daily_pnl)    AS avg_daily_pnl,
        STDDEV(daily_pnl) AS std_daily_pnl,
        COUNT(*)          AS active_days
      FROM daily_pnl
      GROUP BY proxy_wallet
    ),
    combined AS (
      SELECT
        b.proxy_wallet,
        b.avg_bet_size, b.bet_size_cv, b.total_bets, b.avg_bet_7d,
        COALESCE(m.pnl_7d,        0) AS pnl_7d,
        COALESCE(m.trades_7d,     0) AS trades_7d,
        COALESCE(m.avg_daily_pnl, 0) AS avg_daily_pnl,
        COALESCE(m.std_daily_pnl, 0) AS std_daily_pnl,
        COALESCE(m.active_days,   0) AS active_days
      FROM bet_stats b
      LEFT JOIN momentum m USING (proxy_wallet)
    ),
    pillar_raws AS (
      SELECT
        proxy_wallet,
        pnl_7d,
        trades_7d,
        bet_size_cv,
        -- Momentum Z: mirrors computeMomentumZ()
        CASE
          WHEN active_days < 14 OR std_daily_pnl <= 0 THEN  0.0
          WHEN trades_7d = 0                          THEN -1.0
          ELSE (pnl_7d / 7.0 - avg_daily_pnl) / std_daily_pnl
        END AS momentum_z,
        -- Consistency raw: mirrors computeConsistencyRaw()
        CASE
          WHEN total_bets < 10 OR avg_bet_size <= 0 THEN 0.0
          ELSE
            (1.0 / GREATEST(0.1, LEAST(5.0, bet_size_cv))) *
            CASE
              WHEN avg_bet_7d IS NOT NULL
                   AND avg_bet_7d > 0.0
                   AND (avg_bet_7d / avg_bet_size) > 3.0
              THEN 1.0 - LEAST(0.8, (avg_bet_7d / avg_bet_size - 3.0) * 0.15)
              ELSE 1.0
            END
        END AS consistency_raw
      FROM combined
    ),
    percentiled AS (
      SELECT
        proxy_wallet,
        pnl_7d,
        trades_7d,
        bet_size_cv,
        momentum_z,
        -- Percentile rank: (rank - 0.5) / n  →  0–100 scale
        -- Matches JS percentileRank: (k + 0.5) / n
        (ROW_NUMBER() OVER (ORDER BY momentum_z    ASC) - 0.5)
          / COUNT(*) OVER () * 100.0 AS momentum_score,
        (ROW_NUMBER() OVER (ORDER BY consistency_raw ASC) - 0.5)
          / COUNT(*) OVER () * 100.0 AS consistency_score
      FROM pillar_raws
    )
    SELECT
      proxy_wallet,
      (momentum_score + consistency_score) / 2.0 AS composite_score,
      momentum_score,
      consistency_score,
      momentum_z,
      bet_size_cv,
      pnl_7d,
      trades_7d
    FROM percentiled
    ORDER BY composite_score DESC
    LIMIT ${topN}
  `;
}

/**
 * Combined query that returns raw intermediate stats only — used by unit
 * tests and the JS-side scoreComposite() function. Not used in the main
 * pipeline (too large to materialise in JS on the staging box).
 *
 * @param nowTsUnix — current Unix timestamp (seconds).
 */
export function buildCombinedCompositeStatsQuery(nowTsUnix: number): string {
  const ts7d  = nowTsUnix - 7  * 86400;
  const ts30d = nowTsUnix - 30 * 86400;

  return `
    WITH bet_stats AS (
      SELECT
        proxy_wallet,
        AVG(usd_notional)                                           AS avg_bet_size,
        STDDEV(usd_notional)                                        AS std_bet_size,
        CASE WHEN AVG(usd_notional) > 0
             THEN STDDEV(usd_notional) / AVG(usd_notional)
             ELSE 0
        END                                                         AS bet_size_cv,
        COUNT(*)                                                    AS total_bets,
        AVG(CASE WHEN ts_unix >= ${ts7d} THEN usd_notional END)    AS avg_bet_7d,
        MAX(usd_notional)                                           AS max_bet_size
      FROM discovery_activity_v3
      GROUP BY proxy_wallet
      HAVING COUNT(*) >= 10
    ),
    daily_pnl AS (
      SELECT
        proxy_wallet,
        CAST(TO_TIMESTAMP(ts_unix) AS DATE) AS trade_day,
        SUM(usd_notional * (price_yes - 0.5)) AS daily_pnl,
        COUNT(*) AS daily_trades
      FROM discovery_activity_v3
      WHERE proxy_wallet IN (SELECT proxy_wallet FROM bet_stats)
      GROUP BY proxy_wallet, CAST(TO_TIMESTAMP(ts_unix) AS DATE)
    ),
    momentum AS (
      SELECT
        proxy_wallet,
        COALESCE(SUM(CASE WHEN trade_day >= CAST(TO_TIMESTAMP(${ts7d}) AS DATE)
                          THEN daily_pnl ELSE 0 END), 0)  AS pnl_7d,
        COALESCE(SUM(CASE WHEN trade_day >= CAST(TO_TIMESTAMP(${ts7d}) AS DATE)
                          THEN daily_trades ELSE 0 END), 0) AS trades_7d,
        COALESCE(SUM(CASE WHEN trade_day >= CAST(TO_TIMESTAMP(${ts30d}) AS DATE)
                          THEN daily_pnl ELSE 0 END), 0)  AS pnl_30d,
        COALESCE(SUM(CASE WHEN trade_day >= CAST(TO_TIMESTAMP(${ts30d}) AS DATE)
                          THEN daily_trades ELSE 0 END), 0) AS trades_30d,
        AVG(daily_pnl)     AS avg_daily_pnl,
        STDDEV(daily_pnl)  AS std_daily_pnl,
        COUNT(*)           AS active_days
      FROM daily_pnl
      GROUP BY proxy_wallet
    )
    SELECT
      b.proxy_wallet,
      -- Consistency stats
      b.avg_bet_size,
      b.std_bet_size,
      b.bet_size_cv,
      b.total_bets,
      b.avg_bet_7d,
      b.max_bet_size,
      -- Momentum stats
      COALESCE(m.pnl_7d, 0)          AS pnl_7d,
      COALESCE(m.trades_7d, 0)        AS trades_7d,
      COALESCE(m.pnl_30d, 0)          AS pnl_30d,
      COALESCE(m.trades_30d, 0)       AS trades_30d,
      COALESCE(m.avg_daily_pnl, 0)    AS avg_daily_pnl,
      COALESCE(m.std_daily_pnl, 0)    AS std_daily_pnl,
      COALESCE(m.active_days, 0)      AS active_days
    FROM bet_stats b
    LEFT JOIN momentum m ON m.proxy_wallet = b.proxy_wallet
  `;
}
