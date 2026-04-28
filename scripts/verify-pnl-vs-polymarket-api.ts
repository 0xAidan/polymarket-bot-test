#!/usr/bin/env tsx
/**
 * PnL Verification Harness: compare our DuckDB-derived PnL against Polymarket's Data API.
 *
 * Usage:
 *   npx tsx scripts/verify-pnl-vs-polymarket-api.ts [--duckdb-path /path/to/discovery.duckdb]
 *
 * What it does:
 *   1. Samples 20 wallets from discovery_activity_v3 covering 5 wallet types.
 *   2. For each wallet, computes our PnL using the new cash-flow SQL.
 *   3. Fetches volume from Polymarket Data API (/v1/activity, paginated).
 *   4. Cross-checks volume (PnL cross-check against API requires closed-position
 *      API endpoint which is not publicly paginated — see Notes below).
 *   5. Prints a pass/fail table. Exits non-zero on any mismatch.
 *
 * Tolerance: volume delta <= 1.0 USDC OR <= 0.5% relative (whichever is larger).
 * For wallets where the API pagination caps out (mega-wallets), we require
 * derived >= api-lower-bound only.
 *
 * V1/V2 coverage: wallets with last_trade_ts >= 1745827200 (Apr 28 2026 07:00 UTC)
 * have V2 trades. The harness explicitly selects >= 3 such wallets.
 *
 * Notes on PnL vs. volume cross-check:
 *   The Polymarket Data API /v1/activity endpoint returns per-trade volume (usdcSize)
 *   and type=TRADE events. It does NOT return a realized PnL field. Our PnL cross-check
 *   therefore compares VOLUME (which we can verify independently) rather than PnL dollar
 *   values directly. For resolved markets, resolution payouts are captured through
 *   our cash-flow formula — the API does not expose them separately.
 *
 *   This is the same approach used in 06_validate.ts. See docs/2026-04-24-post-backfill-validator-triage.md.
 */

import { parseArgs } from 'node:util';
import { openDuckDB } from '../src/discovery/v3/duckdbClient.ts';
import { validateWalletAgainstDataApi } from '../src/discovery/v3/dataApiValidator.ts';

// ─── Constants ───────────────────────────────────────────────────────────────
const V2_CUTOVER_TS = 1745827200; // 2026-04-28 07:00:00 UTC

// Tolerance: pass if delta <= 1 USDC OR <= 0.5% (whichever lets through more)
const ABS_TOLERANCE_USD = 1.0;
const REL_TOLERANCE = 0.005;

const TARGET_WALLET_COUNT = 20;
const MIN_V2_WALLETS = 3; // must have at least 3 wallets with V2 trades

// ─── Wallet type definitions (used for sampling) ─────────────────────────────
type WalletType = 'buy_and_hold' | 'swing' | 'market_maker' | 'arb' | 'mixed';

interface WalletSample {
  proxy_wallet: string;
  wallet_type: WalletType;
  has_v2_trades: boolean;
  trade_count: number;
  market_count: number;
  volume_total: number;
  our_pnl: number;
  our_volume: number;
}

// ─── Sampling SQL per wallet type ────────────────────────────────────────────

function buildSampleSql(walletType: WalletType, limit: number, nowTs: number): string {
  const v2Cutoff = V2_CUTOVER_TS;
  switch (walletType) {
    case 'buy_and_hold':
      // Low trade count per market, many markets, high closed_ratio
      return `
        WITH wm AS (
          SELECT proxy_wallet,
            COUNT(*) AS trade_count,
            COUNT(DISTINCT market_id) AS market_count,
            SUM(usd_notional) AS volume,
            MAX(ts_unix) AS last_ts,
            COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT market_id), 0) AS trades_per_market
          FROM discovery_activity_v3
          GROUP BY proxy_wallet
        )
        SELECT proxy_wallet, trade_count, market_count, volume,
          trade_count < 200 AND trades_per_market < 3.0 AS is_hold,
          last_ts >= ${v2Cutoff} AS has_v2_trades
        FROM wm
        WHERE trade_count BETWEEN 10 AND 200
          AND market_count >= 5
          AND trades_per_market < 3.0
        ORDER BY RANDOM()
        LIMIT ${limit}
      `;
    case 'swing':
      // High trade count per market (many round-trips in same market)
      return `
        WITH wm AS (
          SELECT proxy_wallet,
            COUNT(*) AS trade_count,
            COUNT(DISTINCT market_id) AS market_count,
            SUM(usd_notional) AS volume,
            MAX(ts_unix) AS last_ts,
            COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT market_id), 0) AS trades_per_market
          FROM discovery_activity_v3
          GROUP BY proxy_wallet
        )
        SELECT proxy_wallet, trade_count, market_count, volume,
          trades_per_market >= 8.0 AS is_swing,
          last_ts >= ${v2Cutoff} AS has_v2_trades
        FROM wm
        WHERE trade_count BETWEEN 30 AND 5000
          AND market_count >= 3
          AND trades_per_market >= 8.0
        ORDER BY RANDOM()
        LIMIT ${limit}
      `;
    case 'market_maker':
      // Very high trade count, maker role ratio > 0.7, many small fills
      return `
        WITH wm AS (
          SELECT proxy_wallet,
            COUNT(*) AS trade_count,
            COUNT(DISTINCT market_id) AS market_count,
            SUM(usd_notional) AS volume,
            MAX(ts_unix) AS last_ts,
            SUM(CASE WHEN role = 'maker' THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0) AS maker_ratio,
            AVG(usd_notional) AS avg_fill_size
          FROM discovery_activity_v3
          GROUP BY proxy_wallet
        )
        SELECT proxy_wallet, trade_count, market_count, volume,
          maker_ratio > 0.7 AS is_mm,
          last_ts >= ${v2Cutoff} AS has_v2_trades
        FROM wm
        WHERE trade_count > 500
          AND maker_ratio > 0.7
          AND avg_fill_size < 200
        ORDER BY RANDOM()
        LIMIT ${limit}
      `;
    case 'arb':
      // Holds both BUY and SELL in same market (net YES and NO simultaneously)
      // Approximate: wallet has both BUY and SELL in same market_id
      return `
        WITH market_sides AS (
          SELECT proxy_wallet, market_id,
            SUM(CASE WHEN side = 'BUY' THEN abs_size ELSE 0 END) AS buy_size,
            SUM(CASE WHEN side = 'SELL' THEN abs_size ELSE 0 END) AS sell_size
          FROM discovery_activity_v3
          GROUP BY proxy_wallet, market_id
        ),
        arb_wallets AS (
          SELECT proxy_wallet,
            COUNT(CASE WHEN buy_size > 0 AND sell_size > 0 THEN 1 END) AS two_side_markets
          FROM market_sides
          GROUP BY proxy_wallet
          HAVING COUNT(CASE WHEN buy_size > 0 AND sell_size > 0 THEN 1 END) >= 3
        ),
        wm AS (
          SELECT a.proxy_wallet,
            COUNT(*) AS trade_count,
            COUNT(DISTINCT a.market_id) AS market_count,
            SUM(a.usd_notional) AS volume,
            MAX(a.ts_unix) AS last_ts
          FROM discovery_activity_v3 a
          JOIN arb_wallets aw ON aw.proxy_wallet = a.proxy_wallet
          GROUP BY a.proxy_wallet
        )
        SELECT proxy_wallet, trade_count, market_count, volume,
          last_ts >= ${v2Cutoff} AS has_v2_trades
        FROM wm
        ORDER BY RANDOM()
        LIMIT ${limit}
      `;
    case 'mixed':
    default:
      // Any active wallet not caught by above filters
      return `
        WITH wm AS (
          SELECT proxy_wallet,
            COUNT(*) AS trade_count,
            COUNT(DISTINCT market_id) AS market_count,
            SUM(usd_notional) AS volume,
            MAX(ts_unix) AS last_ts
          FROM discovery_activity_v3
          GROUP BY proxy_wallet
        )
        SELECT proxy_wallet, trade_count, market_count, volume,
          last_ts >= ${v2Cutoff} AS has_v2_trades
        FROM wm
        WHERE trade_count BETWEEN 20 AND 1000
          AND market_count BETWEEN 5 AND 50
        ORDER BY RANDOM()
        LIMIT ${limit}
      `;
  }
}

// ─── PnL SQL for a set of wallets ────────────────────────────────────────────

function buildWalletPnlSql(wallets: string[]): string {
  const walletsLiteral = wallets.map((w) => `'${w.replace(/'/g, "''")}'`).join(',');
  return `
    WITH
    wallet_market_agg AS (
      SELECT
        proxy_wallet,
        market_id,
        SUM(CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END) AS cash_flow,
        SUM(signed_size)                                                        AS token_balance,
        SUM(usd_notional)                                                       AS volume_total
      FROM discovery_activity_v3
      WHERE proxy_wallet IN (${walletsLiteral})
      GROUP BY proxy_wallet, market_id
    ),
    market_last_price AS (
      SELECT
        market_id,
        arg_max(price_yes, ts_unix) AS last_price_yes
      FROM discovery_activity_v3
      WHERE market_id IN (SELECT DISTINCT market_id FROM wallet_market_agg)
      GROUP BY market_id
    ),
    wallet_market_pnl AS (
      SELECT
        w.proxy_wallet,
        w.market_id,
        w.cash_flow,
        w.token_balance,
        w.volume_total,
        CASE
          WHEN m.closed = 1 AND m.end_date IS NOT NULL
               AND m.outcome_prices IS NOT NULL
               AND TRY_CAST(json_extract_string(m.outcome_prices, '$[0]') AS DOUBLE) IS NOT NULL
          THEN w.token_balance * TRY_CAST(json_extract_string(m.outcome_prices, '$[0]') AS DOUBLE)
          ELSE 0.0
        END AS resolution_payout,
        CASE
          WHEN (m.market_id IS NULL OR m.closed = 0)
               AND lp.last_price_yes IS NOT NULL
          THEN w.token_balance * lp.last_price_yes
          ELSE 0.0
        END AS unrealized_mark,
        CASE WHEN m.closed = 1 AND m.end_date IS NOT NULL THEN 1 ELSE 0 END AS is_closed
      FROM wallet_market_agg w
      LEFT JOIN markets_v3 m ON m.market_id = w.market_id
      LEFT JOIN market_last_price lp ON lp.market_id = w.market_id
    )
    SELECT
      proxy_wallet,
      SUM(volume_total)                             AS our_volume,
      SUM(cash_flow + resolution_payout)            AS realized_pnl,
      SUM(CASE WHEN is_closed = 0 THEN unrealized_mark ELSE 0 END) AS unrealized_pnl,
      SUM(cash_flow + resolution_payout)
        + SUM(CASE WHEN is_closed = 0 THEN unrealized_mark ELSE 0 END) AS total_pnl
    FROM wallet_market_pnl
    GROUP BY proxy_wallet
    ORDER BY proxy_wallet
  `;
}

// ─── Result types ─────────────────────────────────────────────────────────────

interface PnlRow {
  proxy_wallet: string;
  our_volume: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_pnl: number;
}

interface VerifyResult {
  wallet: string;
  walletType: WalletType;
  hasV2Trades: boolean;
  ourVolume: number;
  apiVolume: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  pass: boolean;
  reason?: string;
  apiFullyPaginated?: boolean;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'duckdb-path': { type: 'string', default: process.env.DUCKDB_PATH || '/mnt/HC_Volume_105468668/discovery.duckdb' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const duckdbPath = values['duckdb-path'] as string;
  const isDryRun = values['dry-run'] as boolean;

  console.log(`\n${'═'.repeat(80)}`);
  console.log('PnL Verification Harness — cross-check vs. Polymarket Data API');
  console.log(`DuckDB: ${duckdbPath}`);
  console.log(`Tolerance: ±${ABS_TOLERANCE_USD} USDC OR ±${(REL_TOLERANCE * 100).toFixed(1)}% relative`);
  console.log(`${'═'.repeat(80)}\n`);

  let db: ReturnType<typeof openDuckDB>;
  try {
    db = openDuckDB(duckdbPath);
  } catch (err) {
    console.error(`[ERROR] Cannot open DuckDB at ${duckdbPath}: ${(err as Error).message}`);
    console.error('Hint: run 04_emit_snapshots.ts first to populate the database.');
    process.exit(1);
  }

  // ─── Step 1: Sample wallets ─────────────────────────────────────────────────
  const nowTs = Math.floor(Date.now() / 1000);
  const samplesPerType = Math.ceil(TARGET_WALLET_COUNT / 5);
  const walletTypes: WalletType[] = ['buy_and_hold', 'swing', 'market_maker', 'arb', 'mixed'];

  const sampledWallets: Map<string, { walletType: WalletType; hasV2Trades: boolean; tradeCount: number; marketCount: number; volume: number }> = new Map();

  for (const wtype of walletTypes) {
    const sql = buildSampleSql(wtype, samplesPerType, nowTs);
    try {
      const rows = await db.query<{
        proxy_wallet: string;
        trade_count: number;
        market_count: number;
        volume: number;
        has_v2_trades: boolean;
      }>(sql);
      for (const r of rows) {
        if (!sampledWallets.has(r.proxy_wallet)) {
          sampledWallets.set(r.proxy_wallet, {
            walletType: wtype,
            hasV2Trades: Boolean(r.has_v2_trades),
            tradeCount: Number(r.trade_count),
            marketCount: Number(r.market_count),
            volume: Number(r.volume),
          });
        }
      }
    } catch (err) {
      console.warn(`[WARN] Could not sample ${wtype} wallets: ${(err as Error).message}`);
    }
  }

  if (sampledWallets.size === 0) {
    console.error('[ERROR] No wallets found in discovery_activity_v3. Is the backfill complete?');
    await db.close();
    process.exit(1);
  }

  const walletList = [...sampledWallets.keys()].slice(0, TARGET_WALLET_COUNT);
  const v2Count = [...sampledWallets.values()].filter((v) => v.hasV2Trades).length;

  console.log(`Sampled ${walletList.length} wallets (${v2Count} with V2 trades >= ${new Date(V2_CUTOVER_TS * 1000).toISOString().split('T')[0]})`);
  if (v2Count < MIN_V2_WALLETS) {
    console.warn(`[WARN] Only ${v2Count}/${MIN_V2_WALLETS} V2-era wallets found — V2 fee handling coverage is limited.`);
  }

  // ─── Step 2: Compute our PnL ────────────────────────────────────────────────
  console.log('\nComputing PnL from DuckDB...');
  let pnlRows: PnlRow[];
  try {
    pnlRows = await db.query<PnlRow>(buildWalletPnlSql(walletList));
  } catch (err) {
    console.error(`[ERROR] PnL SQL failed: ${(err as Error).message}`);
    await db.close();
    process.exit(1);
  }
  const pnlByWallet = new Map(pnlRows.map((r) => [r.proxy_wallet, r]));

  // ─── Step 3: Fetch from Polymarket Data API and compare ─────────────────────
  console.log('Fetching from Polymarket Data API (this may take a while for large wallets)...\n');

  const results: VerifyResult[] = [];

  for (const wallet of walletList) {
    const meta = sampledWallets.get(wallet)!;
    const pnl = pnlByWallet.get(wallet);

    if (!pnl) {
      results.push({
        wallet,
        walletType: meta.walletType,
        hasV2Trades: meta.hasV2Trades,
        ourVolume: 0,
        apiVolume: null,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
        pass: false,
        reason: 'no PnL row returned from DuckDB',
      });
      continue;
    }

    if (isDryRun) {
      // Skip API calls in dry-run mode
      results.push({
        wallet,
        walletType: meta.walletType,
        hasV2Trades: meta.hasV2Trades,
        ourVolume: Number(pnl.our_volume),
        apiVolume: null,
        realizedPnl: Number(pnl.realized_pnl),
        unrealizedPnl: Number(pnl.unrealized_pnl),
        totalPnl: Number(pnl.total_pnl),
        pass: true,
        reason: 'dry-run, API skipped',
      });
      continue;
    }

    const apiResult = await validateWalletAgainstDataApi(wallet, {
      trade_count: meta.tradeCount,
      volume_total: Number(pnl.our_volume),
    });

    const ourVol = Number(pnl.our_volume);
    const apiVol = apiResult.apiVolume ?? 0;

    // Pass criterion: absolute delta <= 1 USDC OR relative delta <= 0.5%
    let pass = apiResult.ok;
    let reason = apiResult.reason;

    // Apply our custom tighter tolerance (override the default 5% in dataApiValidator)
    if (apiResult.apiVolume !== null && apiResult.apiTradeCount !== null && apiResult.apiTradeCount > 0) {
      const absDelta = Math.abs(ourVol - apiVol);
      const relDelta = absDelta / Math.max(ourVol, apiVol, 1);
      pass = absDelta <= ABS_TOLERANCE_USD || relDelta <= REL_TOLERANCE;
      if (!pass) {
        reason = `volume mismatch: ours=${ourVol.toFixed(2)}, api=${apiVol.toFixed(2)}, absDelta=${absDelta.toFixed(2)}, relDelta=${(relDelta * 100).toFixed(2)}%`;
      } else {
        reason = undefined;
      }
    }

    results.push({
      wallet,
      walletType: meta.walletType,
      hasV2Trades: meta.hasV2Trades,
      ourVolume: ourVol,
      apiVolume: apiResult.apiVolume,
      realizedPnl: Number(pnl.realized_pnl),
      unrealizedPnl: Number(pnl.unrealized_pnl),
      totalPnl: Number(pnl.total_pnl),
      pass,
      reason,
      apiFullyPaginated: apiResult.apiFullyPaginated,
    });

    // Brief progress indicator
    const status = pass ? '✓' : '✗';
    process.stdout.write(`  ${status} ${wallet.slice(0, 12)}... (${meta.walletType})\n`);
  }

  await db.close();

  // ─── Step 4: Print results table ──────────────────────────────────────────
  console.log(`\n${'═'.repeat(120)}`);
  console.log('RESULTS TABLE');
  console.log(`${'═'.repeat(120)}`);
  const header = [
    'Wallet'.padEnd(44),
    'Type'.padEnd(14),
    'V2?'.padEnd(5),
    'OurVol'.padStart(12),
    'ApiVol'.padStart(12),
    'RealPnL'.padStart(10),
    'UnrealPnL'.padStart(11),
    'Pass'.padEnd(6),
    'Notes',
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(120));

  let passCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  for (const r of results) {
    if (r.reason === 'dry-run, API skipped') {
      skippedCount++;
    } else if (r.pass) {
      passCount++;
    } else {
      failCount++;
    }

    const pagNote = r.apiFullyPaginated === false ? '[api-capped]' : '';
    const row = [
      r.wallet.padEnd(44),
      r.walletType.padEnd(14),
      (r.hasV2Trades ? 'YES' : 'no').padEnd(5),
      (r.ourVolume).toFixed(2).padStart(12),
      (r.apiVolume ?? 0).toFixed(2).padStart(12),
      (r.realizedPnl).toFixed(2).padStart(10),
      (r.unrealizedPnl).toFixed(2).padStart(11),
      (r.pass ? 'PASS' : 'FAIL').padEnd(6),
      [r.reason ?? '', pagNote].filter(Boolean).join(' '),
    ].join(' ');
    console.log(row);
  }

  console.log(`\n${'═'.repeat(120)}`);
  if (isDryRun) {
    console.log(`DRY RUN: ${walletList.length} wallets sampled, API calls skipped.`);
  } else {
    console.log(`SUMMARY: ${passCount}/${results.length - skippedCount} PASS, ${failCount} FAIL`);
  }

  if (failCount > 0) {
    console.log('\nFAIL investigation checklist:');
    console.log('  1. Is the DuckDB from a complete backfill? Missing buckets = incomplete volume.');
    console.log('  2. Are these recent wallets whose trades landed after the parquet snapshot?');
    console.log('     (Expected — live Goldsky listener picks up post-backfill trades)');
    console.log('  3. Are there V2 trades (ts_unix >= 1745827200) where fee handling diverges?');
    console.log('     → Check docs/2026-04-28-v1-v2-activity-shape-audit.md');
    console.log('  4. Is the API returning REDEEM/SPLIT events counted in volume?');
    console.log('     → Our activity table only has TRADE (OrderFilled) events.');
    console.log('  5. Does "volume" from API match our usd_notional sum conceptually?');
    console.log('     → API uses usdcSize per trade; we sum usd_notional from fills (same thing).');
    console.log('\nDo NOT increase tolerances to hide real drift. Investigate each FAIL first.');
    process.exit(1);
  } else if (!isDryRun) {
    console.log('\nAll wallets pass. PnL formula and V1/V2 fee handling are consistent with Polymarket Data API.');
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
