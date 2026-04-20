/**
 * SQL templates for the v3 backfill pipeline. Kept in src/ (not scripts/)
 * so they can be unit-tested with synthetic parquet fixtures.
 */

/**
 * Build the INSERT that maps users.parquet → discovery_activity_v3.
 * Respects the schema quirks from the real dataset:
 *   - token_amount is signed (+buy / -sell)
 *   - token_amount == 0 means a non-fill event; skip
 *   - price is already YES-normalized
 *   - role values are lowercase ('maker' / 'taker')
 */
export function buildEventIngestSql(sourceRef: string, limit?: number): string {
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  return `
    INSERT OR IGNORE INTO discovery_activity_v3
    SELECT
      user                                              AS proxy_wallet,
      market_id,
      condition_id,
      event_id,
      CAST(timestamp AS UBIGINT)                        AS ts_unix,
      CAST(block_number AS UBIGINT)                     AS block_number,
      transaction_hash                                  AS tx_hash,
      CAST(log_index AS UINTEGER)                       AS log_index,
      LOWER(role)                                       AS role,
      CASE WHEN token_amount > 0 THEN 'BUY' ELSE 'SELL' END AS side,
      CAST(price AS DOUBLE)                             AS price_yes,
      CAST(usd_amount AS DOUBLE)                        AS usd_notional,
      CAST(token_amount AS DOUBLE)                      AS signed_size,
      ABS(CAST(token_amount AS DOUBLE))                 AS abs_size
    FROM ${sourceRef}
    WHERE timestamp > 0
      AND usd_amount > 0
      AND token_amount <> 0
      AND transaction_hash IS NOT NULL
    ${limitClause}
  `;
}

/**
 * DuckDB does not implement INSERT OR IGNORE for explicit unique indexes,
 * so we fall back to an anti-join against existing rows. Used when the
 * UNIQUE index on (tx_hash, log_index) would otherwise throw on re-ingest.
 */
export function buildEventIngestSqlAntiJoin(sourceRef: string, limit?: number): string {
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  return `
    INSERT INTO discovery_activity_v3
    WITH filtered AS (
      SELECT * FROM ${sourceRef}
      WHERE timestamp > 0
        AND usd_amount > 0
        AND token_amount <> 0
        AND transaction_hash IS NOT NULL
      ${limitClause}
    ),
    deduped AS (
      -- Dedupe within the source (users.parquet has a few repeated rows).
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY transaction_hash, log_index
          ORDER BY timestamp
        ) AS rn
        FROM filtered
      ) q
      WHERE rn = 1
    )
    SELECT
      user                                              AS proxy_wallet,
      market_id,
      condition_id,
      event_id,
      CAST(timestamp AS UBIGINT)                        AS ts_unix,
      CAST(block_number AS UBIGINT)                     AS block_number,
      transaction_hash                                  AS tx_hash,
      CAST(log_index AS UINTEGER)                       AS log_index,
      LOWER(role)                                       AS role,
      CASE WHEN token_amount > 0 THEN 'BUY' ELSE 'SELL' END AS side,
      CAST(price AS DOUBLE)                             AS price_yes,
      CAST(usd_amount AS DOUBLE)                        AS usd_notional,
      CAST(token_amount AS DOUBLE)                      AS signed_size,
      ABS(CAST(token_amount AS DOUBLE))                 AS abs_size
    FROM deduped src
    WHERE NOT EXISTS (
      SELECT 1 FROM discovery_activity_v3 a
      WHERE a.tx_hash = src.transaction_hash
        AND a.log_index = CAST(src.log_index AS UINTEGER)
    )
  `;
}

export interface MarketsIngestOptions {
  sourceRef: string;
  limit?: number;
}

/**
 * Parse Polymarket's Python-style outcome_prices string (e.g. "['0.53', '0.47']")
 * into a JSON array, then ingest into markets_v3.
 */
export function buildMarketsIngestSql({ sourceRef, limit }: MarketsIngestOptions): string {
  const limitClause = typeof limit === 'number' && limit > 0 ? `LIMIT ${limit}` : '';
  return `
    INSERT INTO markets_v3
    SELECT
      market_id,
      condition_id,
      event_id,
      question,
      slug,
      token1,
      token2,
      answer1,
      answer2,
      CAST(closed AS UTINYINT)                                  AS closed,
      CAST(COALESCE(neg_risk, 0) AS UTINYINT)                   AS neg_risk,
      REPLACE(REPLACE(REPLACE(outcome_prices, '''None''', 'null'), 'None', 'null'), '''', '"') AS outcome_prices,
      CAST(volume_total AS DOUBLE)                              AS volume_total,
      TRY_CAST(created_at AS TIMESTAMP)                         AS created_at,
      TRY_CAST(end_date AS TIMESTAMP)                           AS end_date,
      TRY_CAST(updated_at AS TIMESTAMP)                         AS updated_at
    FROM ${sourceRef}
    WHERE market_id IS NOT NULL
    ${limitClause}
  `;
}

/**
 * Emit point-in-time feature snapshots.
 *
 * Rules (Invariant 4):
 *   - Only count events with ts_unix <= end_of_snapshot_day
 *   - PnL contributions require market.end_date <= snapshot_day
 *
 * Windowed implementation: only emit (wallet, day) pairs where the wallet had
 * >= 1 trade on that day. This keeps the row count proportional to activity,
 * not wallet_count * day_count.
 */
export function buildSnapshotEmitSql(): string {
  return `
    INSERT INTO discovery_feature_snapshots_v3
    WITH wallet_days AS (
      SELECT DISTINCT
        proxy_wallet,
        CAST(TO_TIMESTAMP(ts_unix) AS DATE) AS snapshot_day
      FROM discovery_activity_v3
    ),
    base AS (
      SELECT
        wd.proxy_wallet,
        wd.snapshot_day,
        CAST(EXTRACT(epoch FROM (wd.snapshot_day + INTERVAL 1 DAY)) AS UBIGINT) AS day_end_ts
      FROM wallet_days wd
    ),
    rolled AS (
      SELECT
        b.proxy_wallet,
        b.snapshot_day,
        COUNT(*)                              AS trade_count,
        SUM(a.usd_notional)                   AS volume_total,
        COUNT(DISTINCT a.market_id)           AS distinct_markets,
        MIN(a.ts_unix)                        AS first_active_ts,
        MAX(a.ts_unix)                        AS last_active_ts
      FROM base b
      JOIN discovery_activity_v3 a
        ON a.proxy_wallet = b.proxy_wallet
       AND a.ts_unix < b.day_end_ts
      GROUP BY b.proxy_wallet, b.snapshot_day
    ),
    closed AS (
      SELECT
        b.proxy_wallet,
        b.snapshot_day,
        COUNT(DISTINCT a.market_id)           AS closed_positions,
        SUM(
          CASE
            WHEN m.end_date IS NOT NULL
             AND CAST(m.end_date AS DATE) <= b.snapshot_day
            THEN a.usd_notional * (a.price_yes - 0.5)
            ELSE 0
          END
        )                                     AS realized_pnl
      FROM base b
      JOIN discovery_activity_v3 a
        ON a.proxy_wallet = b.proxy_wallet
       AND a.ts_unix < b.day_end_ts
      LEFT JOIN markets_v3 m ON m.market_id = a.market_id
      WHERE m.end_date IS NOT NULL
        AND CAST(m.end_date AS DATE) <= b.snapshot_day
      GROUP BY b.proxy_wallet, b.snapshot_day
    )
    SELECT
      r.proxy_wallet,
      r.snapshot_day,
      r.trade_count,
      r.volume_total,
      r.distinct_markets,
      COALESCE(c.closed_positions, 0)         AS closed_positions,
      COALESCE(c.realized_pnl, 0.0)           AS realized_pnl,
      0.0                                     AS unrealized_pnl,
      r.first_active_ts,
      r.last_active_ts,
      CAST(FLOOR((r.last_active_ts - r.first_active_ts) / 86400.0) AS INTEGER)
                                              AS observation_span_days
    FROM rolled r
    LEFT JOIN closed c
      ON c.proxy_wallet = r.proxy_wallet
     AND c.snapshot_day = r.snapshot_day
    ORDER BY r.proxy_wallet, r.snapshot_day
  `;
}
