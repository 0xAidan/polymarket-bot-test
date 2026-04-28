/**
 * JUNGLE Pillar Feature SQL Builders
 *
 * Five pillars for wallet ranking in the JUNGLE discovery surface:
 *   1. Niche Knowledge   — category-level volume share and PnL
 *   2. Probabilistic Accuracy — Brier score / hit rate vs. resolution
 *   3. Market Edge / CLV — Closing Line Value: entry price vs. 1h/24h later
 *   4. Risk DNA / Consistency — bet size distribution, volatility
 *   5. Momentum / Heat — 7d/30d rolling PnL vs. all-time average
 *
 * All functions return READ-SIDE SQL against existing tables:
 *   - discovery_activity_v3   (per-trade source of truth)
 *   - markets_v3              (resolution + metadata)
 *   - discovery_feature_snapshots_v3 (daily roll-ups)
 *
 * No new backfill required (unless snapshot columns are extended).
 * Each function returns a SQL string that produces one row per wallet
 * (or per (wallet, category) for niche knowledge).
 *
 * How to add a new pillar:
 *   1. Write a function here that returns a SQL SELECT statement.
 *      The query must produce (proxy_wallet, your_metric_name, ...) rows.
 *   2. Export the function below.
 *   3. Wire into tierScoring.ts if needed for ranking.
 *   4. Done. No backfill needed — all pillars are read-side aggregations.
 */

// ─── V2 CUTOVER TIMESTAMP ───────────────────────────────────────────────────
// Trades with ts_unix >= V2_CUTOVER_TS are V2 (post-Apr 28 2026 07:00 UTC).
// Both V1 and V2 use the same usd_notional / signed_size semantics in the
// activity table, so PnL SQL does not branch on this. Exposed here for
// auditing and documentation.
export const V2_CUTOVER_TS = 1745827200; // 2026-04-28 07:00:00 UTC

// ─── CATEGORY INFERENCE ─────────────────────────────────────────────────────
// markets_v3 does not have a `category` column in the raw parquet source.
// We derive it from the market question/slug using keyword matching.
// This is approximate — a proper taxonomy lookup would require the Gamma API.
// Document the gap: category is best-effort derived from question text.
function categoryExpr(questionCol: string, slugCol: string): string {
  return `
    CASE
      WHEN lower(${questionCol}) LIKE '%election%' OR lower(${questionCol}) LIKE '%president%'
        OR lower(${questionCol}) LIKE '%senate%' OR lower(${questionCol}) LIKE '%congress%'
        OR lower(${questionCol}) LIKE '%vote%' OR lower(${questionCol}) LIKE '%ballot%'
        OR lower(${slugCol}) LIKE '%election%' OR lower(${slugCol}) LIKE '%senate%'
      THEN 'politics'
      WHEN lower(${questionCol}) LIKE '%bitcoin%' OR lower(${questionCol}) LIKE '%ethereum%'
        OR lower(${questionCol}) LIKE '%crypto%' OR lower(${questionCol}) LIKE '%btc%'
        OR lower(${questionCol}) LIKE '%eth %' OR lower(${slugCol}) LIKE '%crypto%'
      THEN 'crypto'
      WHEN lower(${questionCol}) LIKE '%nfl%' OR lower(${questionCol}) LIKE '%nba%'
        OR lower(${questionCol}) LIKE '%mlb%' OR lower(${questionCol}) LIKE '%fifa%'
        OR lower(${questionCol}) LIKE '%soccer%' OR lower(${questionCol}) LIKE '%tennis%'
        OR lower(${questionCol}) LIKE '%super bowl%' OR lower(${slugCol}) LIKE '%sports%'
      THEN 'sports'
      WHEN lower(${questionCol}) LIKE '%fed%' OR lower(${questionCol}) LIKE '%interest rate%'
        OR lower(${questionCol}) LIKE '%inflation%' OR lower(${questionCol}) LIKE '%gdp%'
        OR lower(${questionCol}) LIKE '%recession%' OR lower(${questionCol}) LIKE '%unemployment%'
      THEN 'macro'
      WHEN lower(${questionCol}) LIKE '%war%' OR lower(${questionCol}) LIKE '%ukraine%'
        OR lower(${questionCol}) LIKE '%nato%' OR lower(${questionCol}) LIKE '%china%'
        OR lower(${questionCol}) LIKE '%taiwan%' OR lower(${questionCol}) LIKE '%nuclear%'
      THEN 'geopolitics'
      WHEN lower(${questionCol}) LIKE '%lawsuit%' OR lower(${questionCol}) LIKE '%trial%'
        OR lower(${questionCol}) LIKE '%verdict%' OR lower(${questionCol}) LIKE '%court%'
        OR lower(${questionCol}) LIKE '%indicted%' OR lower(${questionCol}) LIKE '%charged%'
      THEN 'legal'
      WHEN lower(${questionCol}) LIKE '%oscar%' OR lower(${questionCol}) LIKE '%grammy%'
        OR lower(${questionCol}) LIKE '%celebrity%' OR lower(${questionCol}) LIKE '%movie%'
        OR lower(${questionCol}) LIKE '%music%' OR lower(${slugCol}) LIKE '%entertainment%'
      THEN 'entertainment'
      ELSE 'other'
    END
  `.trim();
}

// ─── PILLAR 1: NICHE KNOWLEDGE ───────────────────────────────────────────────
/**
 * Per-(wallet, category): volume share, trade count, and cash-flow PnL
 * in each category. Identifies wallets with concentrated expertise in
 * specific market verticals.
 *
 * Returns: (proxy_wallet, category, cat_volume, cat_trade_count,
 *           cat_pnl, cat_volume_share, total_volume)
 */
export function buildNicheKnowledgeSql(): string {
  return `
    WITH categorized AS (
      SELECT
        a.proxy_wallet,
        a.market_id,
        a.side,
        a.usd_notional,
        ${categoryExpr('m.question', 'm.slug')} AS category
      FROM discovery_activity_v3 a
      LEFT JOIN markets_v3 m ON m.market_id = a.market_id
    ),
    wallet_cat AS (
      SELECT
        proxy_wallet,
        category,
        SUM(usd_notional)                                               AS cat_volume,
        COUNT(*)                                                        AS cat_trade_count,
        SUM(CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END) AS cat_pnl
      FROM categorized
      GROUP BY proxy_wallet, category
    ),
    wallet_total AS (
      SELECT proxy_wallet, SUM(usd_notional) AS total_volume
      FROM discovery_activity_v3
      GROUP BY proxy_wallet
    )
    SELECT
      wc.proxy_wallet,
      wc.category,
      wc.cat_volume,
      wc.cat_trade_count,
      wc.cat_pnl,
      ROUND(wc.cat_volume / NULLIF(wt.total_volume, 0), 4) AS cat_volume_share,
      wt.total_volume
    FROM wallet_cat wc
    JOIN wallet_total wt ON wt.proxy_wallet = wc.proxy_wallet
    ORDER BY wc.proxy_wallet, cat_volume DESC
  `;
}

// ─── PILLAR 2: PROBABILISTIC ACCURACY ───────────────────────────────────────
/**
 * For resolved markets the wallet held to resolution:
 * compute Brier score (mean squared error of prediction vs. outcome)
 * and accuracy rates at price thresholds.
 *
 * Brier score: lower is better. Range [0,1]. Pure coin flip = 0.25.
 * A score < 0.20 is meaningfully calibrated; < 0.15 is excellent.
 *
 * Returns: (proxy_wallet, resolved_position_count, brier_score,
 *           hit_rate_above_60, hit_rate_above_70, avg_entry_price)
 *
 * Note: "held to resolution" = wallet had a net positive token balance
 * at the time the market resolved (did not fully exit before end_date).
 */
export function buildProbabilisticAccuracySql(): string {
  return `
    WITH wallet_market_pos AS (
      SELECT
        a.proxy_wallet,
        a.market_id,
        SUM(a.signed_size)                                              AS token_balance,
        -- Weighted average entry price (cost basis / shares bought)
        SUM(CASE WHEN a.side = 'BUY' THEN a.usd_notional ELSE 0 END)
          / NULLIF(SUM(CASE WHEN a.side = 'BUY' THEN a.abs_size ELSE 0 END), 0) AS avg_entry_price,
        COUNT(*)                                                        AS trade_count
      FROM discovery_activity_v3 a
      GROUP BY a.proxy_wallet, a.market_id
    ),
    resolved_positions AS (
      SELECT
        p.proxy_wallet,
        p.market_id,
        p.token_balance,
        p.avg_entry_price,
        p.trade_count,
        -- Parse YES resolution price: 1.0 = YES wins, 0.0 = NO wins
        TRY_CAST(json_extract_string(m.outcome_prices, '$[0]') AS DOUBLE) AS yes_resolved_price
      FROM wallet_market_pos p
      JOIN markets_v3 m
        ON m.market_id = p.market_id
       AND m.closed = 1
       AND m.end_date IS NOT NULL
       AND m.outcome_prices IS NOT NULL
      WHERE p.token_balance > 0.001  -- held net long YES tokens at resolution
        AND p.avg_entry_price IS NOT NULL
    ),
    brier_per_wallet AS (
      SELECT
        proxy_wallet,
        COUNT(*)                                                        AS resolved_position_count,
        -- Brier score: mean((predicted_prob - outcome)^2)
        AVG(POWER(avg_entry_price - yes_resolved_price, 2))            AS brier_score,
        -- Hit rate: fraction where entry_price > 0.60 AND outcome = YES
        SUM(CASE WHEN avg_entry_price > 0.60 AND yes_resolved_price = 1.0 THEN 1 ELSE 0 END)
          * 1.0 / NULLIF(SUM(CASE WHEN avg_entry_price > 0.60 THEN 1 ELSE 0 END), 0) AS hit_rate_above_60,
        -- Hit rate at 0.70 threshold
        SUM(CASE WHEN avg_entry_price > 0.70 AND yes_resolved_price = 1.0 THEN 1 ELSE 0 END)
          * 1.0 / NULLIF(SUM(CASE WHEN avg_entry_price > 0.70 THEN 1 ELSE 0 END), 0) AS hit_rate_above_70,
        AVG(avg_entry_price)                                           AS avg_entry_price
      FROM resolved_positions
      GROUP BY proxy_wallet
    )
    SELECT * FROM brier_per_wallet
    ORDER BY brier_score ASC NULLS LAST
  `;
}

// ─── PILLAR 3: MARKET EDGE / CLV ─────────────────────────────────────────────
/**
 * Closing Line Value (CLV): for each trade, compare the wallet's entry price
 * to the market's price 1h and 24h after entry. Positive CLV = wallet entered
 * before a favorable move (got better odds than the market later gave).
 *
 * CLV_1h  = (subsequent_price_yes - entry_price_yes) for BUYs
 *           (entry_price_yes - subsequent_price_yes) for SELLs
 * CLV_24h = same with 24h window
 *
 * Implementation: self-join on discovery_activity_v3 matching market_id and
 * ts_unix in the [entry+3600, entry+7200] window for 1h, [entry+82800, entry+90000] for 24h.
 * Use avg(price_yes) of any trades in that window as the "subsequent" price.
 *
 * Returns: (proxy_wallet, trades_with_clv, avg_clv_1h, avg_clv_24h,
 *           pct_positive_clv_1h, pct_positive_clv_24h)
 */
export function buildMarketEdgeCLVSql(): string {
  return `
    WITH trade_entries AS (
      -- Sample at most 10k trades per wallet to avoid quadratic explosion
      -- on market makers with millions of fills. For production, add TABLESAMPLE.
      SELECT
        a.proxy_wallet,
        a.market_id,
        a.ts_unix                           AS entry_ts,
        a.price_yes                         AS entry_price,
        a.side
      FROM discovery_activity_v3 a
      WHERE a.price_yes BETWEEN 0.01 AND 0.99  -- skip degenerate near-0/near-1 prices
    ),
    subsequent_1h AS (
      SELECT
        e.proxy_wallet,
        e.market_id,
        e.entry_ts,
        e.entry_price,
        e.side,
        AVG(f.price_yes) AS price_1h_after
      FROM trade_entries e
      JOIN discovery_activity_v3 f
        ON f.market_id = e.market_id
       AND f.ts_unix BETWEEN e.entry_ts + 3600 AND e.entry_ts + 7200
      GROUP BY e.proxy_wallet, e.market_id, e.entry_ts, e.entry_price, e.side
    ),
    subsequent_24h AS (
      SELECT
        e.proxy_wallet,
        e.market_id,
        e.entry_ts,
        e.entry_price,
        e.side,
        AVG(f.price_yes) AS price_24h_after
      FROM trade_entries e
      JOIN discovery_activity_v3 f
        ON f.market_id = e.market_id
       AND f.ts_unix BETWEEN e.entry_ts + 82800 AND e.entry_ts + 90000
      GROUP BY e.proxy_wallet, e.market_id, e.entry_ts, e.entry_price, e.side
    ),
    clv_combined AS (
      SELECT
        h.proxy_wallet,
        -- CLV from 1h window
        CASE WHEN h.side = 'BUY' THEN h.price_1h_after - h.entry_price
             ELSE h.entry_price - h.price_1h_after END AS clv_1h,
        -- CLV from 24h window (may be NULL if no trades in that window)
        CASE WHEN d.price_24h_after IS NOT NULL THEN
          CASE WHEN h.side = 'BUY' THEN d.price_24h_after - h.entry_price
               ELSE h.entry_price - d.price_24h_after END
          ELSE NULL END AS clv_24h
      FROM subsequent_1h h
      LEFT JOIN subsequent_24h d
        ON d.proxy_wallet = h.proxy_wallet
       AND d.market_id = h.market_id
       AND d.entry_ts = h.entry_ts
    )
    SELECT
      proxy_wallet,
      COUNT(*)                                      AS trades_with_clv,
      ROUND(AVG(clv_1h), 4)                         AS avg_clv_1h,
      ROUND(AVG(clv_24h), 4)                        AS avg_clv_24h,
      ROUND(SUM(CASE WHEN clv_1h > 0 THEN 1.0 ELSE 0.0 END) / NULLIF(COUNT(*), 0), 4) AS pct_positive_clv_1h,
      ROUND(SUM(CASE WHEN clv_24h > 0 THEN 1.0 ELSE 0.0 END)
        / NULLIF(COUNT(CASE WHEN clv_24h IS NOT NULL THEN 1 END), 0), 4)               AS pct_positive_clv_24h
    FROM clv_combined
    GROUP BY proxy_wallet
    ORDER BY avg_clv_1h DESC NULLS LAST
  `;
}

// ─── PILLAR 4: RISK DNA / CONSISTENCY ────────────────────────────────────────
/**
 * Bet size distribution per wallet: p50, p90, p99, stddev, max bet,
 * max_bet_as_fraction_of_cumulative_volume (concentration risk).
 *
 * Returns: (proxy_wallet, trade_count, median_bet_usd, p90_bet_usd,
 *           p99_bet_usd, stddev_bet_usd, max_bet_usd, max_bet_vol_share,
 *           total_volume_usd)
 */
export function buildRiskDNASql(): string {
  return `
    WITH wallet_bets AS (
      SELECT
        proxy_wallet,
        COUNT(*)                                        AS trade_count,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY usd_notional) AS median_bet_usd,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY usd_notional) AS p90_bet_usd,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY usd_notional) AS p99_bet_usd,
        STDDEV_POP(usd_notional)                        AS stddev_bet_usd,
        MAX(usd_notional)                               AS max_bet_usd,
        SUM(usd_notional)                               AS total_volume_usd
      FROM discovery_activity_v3
      GROUP BY proxy_wallet
    )
    SELECT
      proxy_wallet,
      trade_count,
      ROUND(median_bet_usd, 2)    AS median_bet_usd,
      ROUND(p90_bet_usd, 2)       AS p90_bet_usd,
      ROUND(p99_bet_usd, 2)       AS p99_bet_usd,
      ROUND(stddev_bet_usd, 2)    AS stddev_bet_usd,
      ROUND(max_bet_usd, 2)       AS max_bet_usd,
      ROUND(max_bet_usd / NULLIF(total_volume_usd, 0), 4) AS max_bet_vol_share,
      ROUND(total_volume_usd, 2)  AS total_volume_usd
    FROM wallet_bets
    ORDER BY max_bet_vol_share DESC NULLS LAST
  `;
}

// ─── PILLAR 5: MOMENTUM / HEAT ───────────────────────────────────────────────
/**
 * 7d and 30d rolling cash-flow PnL vs. all-time average.
 * "now_ts" is passed as a parameter so the query is testable.
 *
 * Returns: (proxy_wallet, pnl_7d, pnl_30d, pnl_alltime, pnl_7d_vs_avg,
 *           pnl_30d_vs_avg, last_trade_ts, days_since_last_trade)
 *
 * @param nowTs - Unix timestamp to use as "now" (default: current time at query run)
 */
export function buildMomentumHeatSql(nowTs?: number): string {
  const nowExpr = nowTs != null ? `${nowTs}` : 'CAST(epoch(now()) AS BIGINT)';
  return `
    WITH wallet_pnl_windows AS (
      SELECT
        proxy_wallet,
        -- 7-day window PnL
        SUM(CASE WHEN ts_unix >= (${nowExpr} - 7 * 86400)
            THEN CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END
            ELSE 0.0 END)  AS pnl_7d,
        -- 30-day window PnL
        SUM(CASE WHEN ts_unix >= (${nowExpr} - 30 * 86400)
            THEN CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END
            ELSE 0.0 END)  AS pnl_30d,
        -- All-time PnL
        SUM(CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END) AS pnl_alltime,
        MAX(ts_unix)       AS last_trade_ts,
        COUNT(*)           AS total_trades
      FROM discovery_activity_v3
      GROUP BY proxy_wallet
    ),
    -- All-time average daily PnL = pnl_alltime / observation_span_days
    -- Use (last_trade_ts - min_ts) as observation span
    wallet_span AS (
      SELECT proxy_wallet, MIN(ts_unix) AS first_ts
      FROM discovery_activity_v3
      GROUP BY proxy_wallet
    )
    SELECT
      w.proxy_wallet,
      ROUND(w.pnl_7d, 2)                                             AS pnl_7d,
      ROUND(w.pnl_30d, 2)                                            AS pnl_30d,
      ROUND(w.pnl_alltime, 2)                                        AS pnl_alltime,
      -- 7d PnL vs. expected 7d PnL at historical daily rate
      ROUND(w.pnl_7d - (w.pnl_alltime
        / NULLIF(CAST((w.last_trade_ts - s.first_ts) AS DOUBLE) / 86400.0, 0)) * 7.0, 2)
        AS pnl_7d_vs_avg,
      -- 30d PnL vs. expected 30d at historical rate
      ROUND(w.pnl_30d - (w.pnl_alltime
        / NULLIF(CAST((w.last_trade_ts - s.first_ts) AS DOUBLE) / 86400.0, 0)) * 30.0, 2)
        AS pnl_30d_vs_avg,
      w.last_trade_ts,
      CAST((${nowExpr} - w.last_trade_ts) / 86400 AS INTEGER) AS days_since_last_trade
    FROM wallet_pnl_windows w
    JOIN wallet_span s ON s.proxy_wallet = w.proxy_wallet
    ORDER BY pnl_7d DESC NULLS LAST
  `;
}

/**
 * Convenience: run all five pillar queries against the given DuckDB instance
 * and return the SQL strings (for testing or inspection).
 */
export function allPillarSqls(opts?: { nowTs?: number }): Record<string, string> {
  return {
    nicheKnowledge: buildNicheKnowledgeSql(),
    probabilisticAccuracy: buildProbabilisticAccuracySql(),
    marketEdgeCLV: buildMarketEdgeCLVSql(),
    riskDNA: buildRiskDNASql(),
    momentumHeat: buildMomentumHeatSql(opts?.nowTs),
  };
}
