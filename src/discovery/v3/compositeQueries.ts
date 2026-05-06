/**
 * DuckDB queries for computing per-wallet Composite Score raw stats.
 *
 * These queries run against `discovery_activity_v3` and produce the
 * intermediate stats that `compositeScoring.ts` uses to compute pillar scores.
 */

/**
 * Combined query that computes BOTH momentum and consistency stats in one
 * pass for wallets that meet minimum thresholds. More efficient than
 * running two separate queries on the 900M+ row activity table.
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
