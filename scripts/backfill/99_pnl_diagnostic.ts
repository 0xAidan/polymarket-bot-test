/**
 * PnL Diagnostic — run on server to pinpoint why realized_pnl looks inflated.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/backfill/99_pnl_diagnostic.ts
 *
 * It prints 5 sections, each self-contained. Share the full output so we can
 * identify which of the 3 root-cause hypotheses is responsible.
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

// Golden wallets — acceptance targets (Polymarket profile, May 2026)
const GOLDEN_WALLETS = [
  { label: 'Amber Falcon / dvisik', address: '0x2055b6a642839e86644d381c619aabc0afec1d9d' },
  { label: 'Amber Hare / c000OLI0003', address: '0xfedc381bf3fb5d20433bb4a0216b15dbbc5c6398' },
] as const;

// Wallets that showed extreme PnL relative to volume (historical corruption probes)
const PROBE_WALLETS = [
  ...GOLDEN_WALLETS.map((g) => g.address),
  '0x6480542954b70a674a74bd1a6015dec362dc8dc5',
  '0xa61ef8773ec2e821962306ca87d4b57e39ff0abd',
  '0xcf006e28309313be21b36d22bde515882182353f',
  '0xf247584e41117bbbe4cc06e4d2c95741792a5216',
].map((a) => a.toLowerCase());

async function main(): Promise<void> {
  const db = await openDuckDB(getDuckDBPath());
  try {
    // ─── SECTION 1: Market join health ─────────────────────────────────────────
    console.log('\n══════ §1: MARKET JOIN HEALTH ══════');
    console.log('How many (wallet,market) pairs in activity have a matching row in markets_v3?\n');
    const joinHealth = await db.query<Record<string, unknown>>(`
      SELECT
        COUNT(*)                                                          AS total_wallet_market_pairs,
        COUNT(m.market_id)                                                AS matched_to_markets_v3,
        COUNT(*) - COUNT(m.market_id)                                     AS unmatched,
        ROUND(100.0 * COUNT(m.market_id) / COUNT(*), 1)                  AS pct_matched,
        COUNT(CASE WHEN m.closed = 1 THEN 1 END)                         AS matched_and_closed,
        ROUND(100.0 * COUNT(CASE WHEN m.closed = 1 THEN 1 END) / NULLIF(COUNT(m.market_id), 0), 1) AS pct_closed
      FROM (
        SELECT DISTINCT proxy_wallet, market_id FROM discovery_activity_v3
      ) a
      LEFT JOIN markets_v3 m ON m.market_id = a.market_id
    `);
    console.log(JSON.stringify(joinHealth[0], null, 2));

    // ─── SECTION 2: direction / token_amount sign check ────────────────────────
    console.log('\n══════ §2: DIRECTION vs TOKEN_AMOUNT SIGN ══════');
    console.log('If token_amount is always positive (unsigned), signed_size > 0 for SELL rows → double-counts position.\n');
    const signCheck = await db.query<Record<string, unknown>>(`
      SELECT
        side,
        COUNT(*)                                        AS row_count,
        COUNT(CASE WHEN signed_size > 0 THEN 1 END)    AS positive_signed_size,
        COUNT(CASE WHEN signed_size < 0 THEN 1 END)    AS negative_signed_size,
        COUNT(CASE WHEN signed_size = 0 THEN 1 END)    AS zero_signed_size,
        ROUND(AVG(ABS(signed_size)), 4)                AS avg_abs_size
      FROM discovery_activity_v3
      GROUP BY side
      ORDER BY side
    `);
    signCheck.forEach((r) => console.log(JSON.stringify(r)));
    console.log('\nINTERPRETATION:');
    console.log('  SELL rows with positive_signed_size > 0 = token_amount is UNSIGNED in parquet.');
    console.log('  SELL rows with negative_signed_size > 0 = token_amount is signed (correct).');

    // ─── SECTION 3: outcome_prices sanity for resolved markets ─────────────────
    console.log('\n══════ §3: OUTCOME_PRICES FOR CLOSED MARKETS ══════');
    console.log('First token in the JSON array should be 0.0 or 1.0 for resolved binary markets.\n');
    const prices = await db.query<Record<string, unknown>>(`
      SELECT
        COUNT(*)                                                                   AS total_closed,
        COUNT(CASE WHEN TRY_CAST(json_extract_string(outcome_prices, '$[0]') AS DOUBLE) = 1.0 THEN 1 END) AS resolved_yes,
        COUNT(CASE WHEN TRY_CAST(json_extract_string(outcome_prices, '$[0]') AS DOUBLE) = 0.0 THEN 1 END) AS resolved_no,
        COUNT(CASE WHEN TRY_CAST(json_extract_string(outcome_prices, '$[0]') AS DOUBLE) BETWEEN 0.01 AND 0.99 THEN 1 END) AS mid_price_not_resolved,
        COUNT(CASE WHEN outcome_prices IS NULL THEN 1 END)                         AS null_prices,
        MIN(TRY_CAST(json_extract_string(outcome_prices, '$[0]') AS DOUBLE))       AS min_price,
        MAX(TRY_CAST(json_extract_string(outcome_prices, '$[0]') AS DOUBLE))       AS max_price
      FROM markets_v3
      WHERE closed = 1
    `);
    console.log(JSON.stringify(prices[0], null, 2));
    console.log('\nINTERPRETATION:');
    console.log('  mid_price_not_resolved > 0 = markets marked closed but outcome_prices is pre-resolution price.');
    console.log('  That causes resolution_payout to be fractional rather than 0 or 1 × token_balance.');

    // ─── SECTION 3b: duplicate keys + volume for golden wallets ────────────────
    console.log('\n══════ §3b: GOLDEN WALLET INTEGRITY ══════');
    for (const g of GOLDEN_WALLETS) {
      const addr = g.address.toLowerCase();
      const integrity = await db.query<Record<string, unknown>>(`
        SELECT
          COUNT(*)::BIGINT AS row_count,
          COUNT(DISTINCT (tx_hash, log_index))::BIGINT AS distinct_keys,
          COUNT(*) - COUNT(DISTINCT (tx_hash, log_index)) AS duplicate_rows,
          ROUND(SUM(usd_notional), 2) AS volume_usd,
          MAX(usd_notional) AS max_notional
        FROM discovery_activity_v3
        WHERE LOWER(proxy_wallet) = '${addr}'
      `);
      console.log(`\n${g.label} (${addr}):`);
      console.log(JSON.stringify(integrity[0], null, 2));
    }

    // ─── SECTION 4: per-wallet PnL decomposition for probe wallets ─────────────
    console.log('\n══════ §4: PnL DECOMPOSITION (probe wallets) ══════');
    console.log('Shows cash_flow + resolution_payout breakdown per wallet.\n');
    for (const addr of PROBE_WALLETS) {
      const rows = await db.query<Record<string, unknown>>(`
        WITH wma AS (
          SELECT
            proxy_wallet,
            market_id,
            SUM(CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END) AS cash_flow,
            SUM(CASE WHEN side = 'BUY' THEN abs_size ELSE -abs_size END)           AS token_balance,
            SUM(usd_notional)                                                       AS volume
          FROM discovery_activity_v3
          WHERE LOWER(proxy_wallet) = '${addr}'
          GROUP BY proxy_wallet, market_id
        ),
        joined AS (
          SELECT
            w.proxy_wallet,
            COUNT(*)                                                    AS market_count,
            COUNT(m.market_id)                                          AS matched_markets,
            COUNT(CASE WHEN m.closed = 1 THEN 1 END)                   AS closed_markets,
            SUM(w.volume)                                               AS total_volume,
            SUM(w.cash_flow)                                            AS total_cash_flow,
            SUM(CASE
              WHEN m.closed = 1 AND m.outcome_prices IS NOT NULL
              THEN w.token_balance * COALESCE(TRY_CAST(json_extract_string(m.outcome_prices, '$[0]') AS DOUBLE), 0)
              ELSE 0
            END)                                                        AS total_resolution_payout,
            SUM(CASE
              WHEN m.closed = 1 AND TRY_CAST(json_extract_string(m.outcome_prices, '$[0]') AS DOUBLE) BETWEEN 0.01 AND 0.99
              THEN w.token_balance * TRY_CAST(json_extract_string(m.outcome_prices, '$[0]') AS DOUBLE)
              ELSE 0
            END)                                                        AS payout_from_mid_prices,
            SUM(CASE WHEN m.closed = 0 OR m.market_id IS NULL
              THEN w.token_balance ELSE 0 END)                          AS unresolved_token_balance
          FROM wma w
          LEFT JOIN markets_v3 m ON m.market_id = w.market_id
          GROUP BY w.proxy_wallet
        )
        SELECT
          proxy_wallet,
          market_count,
          matched_markets,
          closed_markets,
          ROUND(total_volume, 2)              AS volume_usd,
          ROUND(total_cash_flow, 2)           AS cash_flow_usd,
          ROUND(total_resolution_payout, 2)   AS resolution_payout_usd,
          ROUND(total_cash_flow + total_resolution_payout, 2) AS realized_pnl_usd,
          ROUND(payout_from_mid_prices, 2)    AS payout_from_non_binary_prices,
          ROUND(unresolved_token_balance, 2)  AS open_token_balance
        FROM joined
      `);
      if (rows.length > 0) {
        console.log(`\nWallet ${addr}:`);
        console.log(JSON.stringify(rows[0], null, 2));
      } else {
        console.log(`\nWallet ${addr}: NOT FOUND in activity data`);
      }
    }

    // ─── SECTION 5: top 10 wallets by resolution_payout — sanity check ─────────
    console.log('\n══════ §5: TOP 10 BY RESOLUTION_PAYOUT ══════');
    console.log('If resolution_payout >> total_volume, something is wrong with the formula.\n');
    const top10 = await db.query<Record<string, unknown>>(`
      WITH wma AS (
        SELECT
          proxy_wallet,
          SUM(usd_notional)                                             AS volume,
          SUM(CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END) AS cash_flow,
          SUM(CASE WHEN side = 'BUY' THEN abs_size ELSE -abs_size END) AS net_tokens
        FROM discovery_activity_v3
        GROUP BY proxy_wallet
      ),
      snap AS (
        SELECT proxy_wallet, MAX(realized_pnl) AS realized_pnl
        FROM discovery_feature_snapshots_v3
        GROUP BY proxy_wallet
      )
      SELECT
        s.proxy_wallet,
        ROUND(w.volume, 0)        AS volume_usd,
        ROUND(w.cash_flow, 0)     AS cash_flow,
        ROUND(s.realized_pnl, 0)  AS realized_pnl,
        ROUND(w.net_tokens, 0)    AS net_tokens_held
      FROM snap s
      JOIN wma w ON w.proxy_wallet = s.proxy_wallet
      ORDER BY s.realized_pnl DESC
      LIMIT 10
    `);
    top10.forEach((r, i) => console.log(`#${i + 1}`, JSON.stringify(r)));

  } finally {
    await db.close();
  }
  console.log('\n[diag] done.');
}

main().catch((err) => {
  console.error('[diag] failed:', err);
  process.exit(1);
});
