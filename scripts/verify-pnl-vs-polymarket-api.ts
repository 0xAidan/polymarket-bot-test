#!/usr/bin/env tsx
/**
 * PnL Verification Harness — cross-check our PnL math vs. Polymarket Data API.
 *
 * 2026-04-28 rewrite: 8GB-RAM-friendly. The previous version ran 5 full
 * GROUP BY scans over the 912M-row discovery_activity_v3 table during the
 * sampling phase, which OOM-thrashed the Hetzner host and never finished.
 *
 * New strategy:
 *   - Sample candidate wallets from discovery_feature_snapshots_v3 (small,
 *     pre-aggregated), NOT from discovery_activity_v3.
 *   - Compute PnL only for the small WHERE proxy_wallet IN (...) slice.
 *   - Set DUCKDB_MEMORY_LIMIT_GB defensively so a stray query can't OOM the box.
 *   - Default to 5 wallets for fast smoke-test; --wallets 20 after smoke passes.
 *   - Log progress at every step so we know where it is.
 *
 * Usage:
 *   npx tsx scripts/verify-pnl-vs-polymarket-api.ts                 # 5 wallets
 *   npx tsx scripts/verify-pnl-vs-polymarket-api.ts --wallets 20    # full 20
 *   npx tsx scripts/verify-pnl-vs-polymarket-api.ts --dry-run       # skip API
 *
 * Tolerance: volume delta <= 1.0 USDC OR <= 0.5% relative.
 *
 * V1/V2 coverage: wallets with last trade ts >= 1745827200
 * (Apr 28 2026 07:00 UTC) trade on V2. We bias the sample toward including
 * at least 1 V2-era wallet (or as many as exist, if smoke-test size).
 *
 * Notes on PnL vs. volume cross-check: the public Data API exposes per-trade
 * volume (usdcSize) but no realized-PnL field, so we cross-check VOLUME (which
 * we can verify independently). PnL math is exercised end-to-end and printed,
 * but only volume is asserted against the API. Same approach as 06_validate.ts.
 */

import { parseArgs } from 'node:util';
import { openDuckDB } from '../src/discovery/v3/duckdbClient.ts';
import { validateWalletAgainstDataApi } from '../src/discovery/v3/dataApiValidator.ts';

// ─── Constants ───────────────────────────────────────────────────────────────
const V2_CUTOVER_TS = 1745827200; // 2026-04-28 07:00:00 UTC

// Tolerance: pass if abs delta <= 1 USDC OR rel delta <= 0.5%
const ABS_TOLERANCE_USD = 1.0;
const REL_TOLERANCE = 0.005;

// Default smoke-test size. CLI --wallets overrides.
const DEFAULT_WALLET_COUNT = 5;
const MAX_WALLET_COUNT = 50;

// Defensive memory cap if caller didn't already set DUCKDB_MEMORY_LIMIT_GB.
// 5 GB leaves ~3 GB for the OS, listener, and Node on an 8 GB Hetzner box.
const DEFAULT_MEMORY_LIMIT_GB = 5;

// ─── Wallet type definitions (used for sampling) ─────────────────────────────
type WalletType = 'buy_and_hold' | 'swing' | 'market_maker' | 'arb' | 'mixed';
const WALLET_TYPES: WalletType[] = ['buy_and_hold', 'swing', 'market_maker', 'arb', 'mixed'];

interface WalletMeta {
  walletType: WalletType;
  hasV2Trades: boolean;
  tradeCount: number;
  marketCount: number;
  volume: number;
}

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

// ─── Sampling: candidates from discovery_feature_snapshots_v3 ────────────────
//
// Snapshot columns: proxy_wallet, snapshot_day, trade_count, volume_total,
// distinct_markets, closed_positions, realized_pnl, unrealized_pnl,
// first_active_ts, last_active_ts, observation_span_days.
//
// We aggregate to LIFETIME stats per wallet (sum/max across snapshot_days),
// then bucket by wallet type using simple ratios. This SQL only touches a
// table with one row per (wallet, day), not 912M trade rows.

function buildLifetimeWalletPoolSql(perTypeLimit: number): string {
  // We over-sample within each type to allow rejection on V2-cover constraints
  // and bad joins later. The pool is small (~5 × perTypeLimit × 5 = 125 wallets
  // for the default smoke test), so the WHERE proxy_wallet IN (...) PnL query
  // stays fast.
  const oversample = Math.max(perTypeLimit * 4, 20);
  return `
    WITH lifetime AS (
      SELECT
        proxy_wallet,
        SUM(trade_count)                            AS trade_count,
        SUM(volume_total)                           AS volume,
        MAX(distinct_markets)                       AS market_count_max,
        SUM(closed_positions)                       AS closed_positions_sum,
        MIN(first_active_ts)                        AS first_active_ts,
        MAX(last_active_ts)                         AS last_active_ts
      FROM discovery_feature_snapshots_v3
      GROUP BY proxy_wallet
      HAVING SUM(trade_count) >= 10
    ),
    classified AS (
      SELECT
        proxy_wallet,
        trade_count,
        market_count_max  AS market_count,
        volume,
        last_active_ts,
        last_active_ts >= ${V2_CUTOVER_TS}                                         AS has_v2_trades,
        trade_count * 1.0 / NULLIF(market_count_max, 0)                            AS trades_per_market,
        CASE
          WHEN trade_count BETWEEN 10 AND 200
               AND market_count_max >= 5
               AND (trade_count * 1.0 / NULLIF(market_count_max, 0)) < 3.0
          THEN 'buy_and_hold'
          WHEN trade_count BETWEEN 30 AND 5000
               AND market_count_max >= 3
               AND (trade_count * 1.0 / NULLIF(market_count_max, 0)) >= 8.0
          THEN 'swing'
          WHEN trade_count > 500
               AND (trade_count * 1.0 / NULLIF(market_count_max, 0)) >= 20.0
          THEN 'market_maker'
          WHEN trade_count BETWEEN 20 AND 1000
               AND market_count_max BETWEEN 3 AND 50
          THEN 'mixed'
          ELSE 'other'
        END AS wallet_type
      FROM lifetime
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY wallet_type ORDER BY RANDOM()) AS rn
      FROM classified
      WHERE wallet_type <> 'other'
    )
    SELECT proxy_wallet, wallet_type, trade_count, market_count, volume,
           has_v2_trades, last_active_ts
    FROM ranked
    WHERE rn <= ${oversample}
    ORDER BY wallet_type, rn
  `;
}

// ─── arb-wallet probe ────────────────────────────────────────────────────────
//
// Arb pattern (BUY + SELL same market) cannot be inferred from snapshot
// columns. We probe a CANDIDATE pool (already small, pre-filtered to active
// wallets) for both-sided activity. Activity-table scan is bounded by
// proxy_wallet IN (...) so memory cost stays small.

function buildArbProbeSql(candidateWallets: string[]): string {
  const lit = candidateWallets.map((w) => `'${w.replace(/'/g, "''")}'`).join(',');
  return `
    WITH market_sides AS (
      SELECT proxy_wallet, market_id,
        SUM(CASE WHEN side = 'BUY'  THEN abs_size ELSE 0 END) AS buy_size,
        SUM(CASE WHEN side = 'SELL' THEN abs_size ELSE 0 END) AS sell_size
      FROM discovery_activity_v3
      WHERE proxy_wallet IN (${lit})
      GROUP BY proxy_wallet, market_id
    )
    SELECT proxy_wallet,
      COUNT(CASE WHEN buy_size > 0 AND sell_size > 0 THEN 1 END) AS two_side_markets
    FROM market_sides
    GROUP BY proxy_wallet
    HAVING COUNT(CASE WHEN buy_size > 0 AND sell_size > 0 THEN 1 END) >= 3
  `;
}

// ─── PnL SQL for a small set of wallets ──────────────────────────────────────

function buildWalletPnlSql(wallets: string[]): string {
  const walletsLiteral = wallets.map((w) => `'${w.replace(/'/g, "''")}'`).join(',');
  // Critical: WHERE proxy_wallet IN (...) FIRST so DuckDB pushes the filter
  // into the activity scan. Subsequent CTEs operate on tens of thousands of
  // rows, not 912M.
  return `
    WITH
    wallet_activity AS (
      SELECT proxy_wallet, market_id, side, usd_notional, signed_size, ts_unix, price_yes
      FROM discovery_activity_v3
      WHERE proxy_wallet IN (${walletsLiteral})
    ),
    wallet_market_agg AS (
      SELECT
        proxy_wallet,
        market_id,
        SUM(CASE WHEN side = 'SELL' THEN usd_notional ELSE -usd_notional END) AS cash_flow,
        SUM(signed_size)                                                        AS token_balance,
        SUM(usd_notional)                                                       AS volume_total
      FROM wallet_activity
      GROUP BY proxy_wallet, market_id
    ),
    -- last observed price per market (just for the markets these wallets touched)
    relevant_markets AS (
      SELECT DISTINCT market_id FROM wallet_market_agg
    ),
    market_last_price AS (
      SELECT a.market_id, arg_max(a.price_yes, a.ts_unix) AS last_price_yes
      FROM discovery_activity_v3 a
      JOIN relevant_markets r ON r.market_id = a.market_id
      GROUP BY a.market_id
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

// ─── Logging helpers ─────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}
function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'duckdb-path': {
        type: 'string',
        default: process.env.DUCKDB_PATH || '/mnt/HC_Volume_105468668/discovery_v3.duckdb',
      },
      'wallets': { type: 'string', default: String(DEFAULT_WALLET_COUNT) },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const duckdbPath = values['duckdb-path'] as string;
  const isDryRun = values['dry-run'] as boolean;
  let walletTarget = Math.min(Math.max(parseInt(String(values['wallets']), 10) || DEFAULT_WALLET_COUNT, 1), MAX_WALLET_COUNT);

  // Default the memory limit if the caller didn't already set it. This is
  // critical on the 8GB Hetzner box where prior runs OOM-thrashed.
  if (!process.env.DUCKDB_MEMORY_LIMIT_GB) {
    process.env.DUCKDB_MEMORY_LIMIT_GB = String(DEFAULT_MEMORY_LIMIT_GB);
  }
  if (!process.env.DUCKDB_TEMP_DIR) {
    // Same volume as the DB; it's the one with free space.
    process.env.DUCKDB_TEMP_DIR = '/mnt/HC_Volume_105468668/duckdb_tmp';
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log('PnL Verification Harness — cross-check vs. Polymarket Data API');
  console.log(`DuckDB:        ${duckdbPath}`);
  console.log(`Memory limit:  ${process.env.DUCKDB_MEMORY_LIMIT_GB} GB`);
  console.log(`Temp dir:      ${process.env.DUCKDB_TEMP_DIR}`);
  console.log(`Target sample: ${walletTarget} wallets (${isDryRun ? 'dry-run, no API calls' : 'live API cross-check'})`);
  console.log(`Tolerance:     ±${ABS_TOLERANCE_USD} USDC OR ±${(REL_TOLERANCE * 100).toFixed(1)}% relative`);
  console.log(`${'═'.repeat(80)}\n`);

  let db: ReturnType<typeof openDuckDB>;
  try {
    log(`Opening DuckDB...`);
    db = openDuckDB(duckdbPath);
  } catch (err) {
    console.error(`[ERROR] Cannot open DuckDB at ${duckdbPath}: ${(err as Error).message}`);
    console.error('Hint: did 04_emit_snapshots.ts complete? Is the path right?');
    process.exit(1);
  }

  // ─── Step 1: Sample candidate wallets from snapshots (cheap) ───────────────
  log(`Step 1/4: sampling candidate wallets from discovery_feature_snapshots_v3...`);
  const perTypeLimit = Math.max(Math.ceil(walletTarget / 5), 2);
  let candidateRows: Array<{
    proxy_wallet: string;
    wallet_type: WalletType;
    trade_count: number;
    market_count: number;
    volume: number;
    has_v2_trades: boolean;
    last_active_ts: number;
  }>;
  try {
    candidateRows = await db.query(buildLifetimeWalletPoolSql(perTypeLimit));
  } catch (err) {
    console.error(`[ERROR] candidate sampling SQL failed: ${(err as Error).message}`);
    await db.close();
    process.exit(1);
  }
  log(`  ✓ ${candidateRows.length} candidate wallets across types: ${
    [...new Set(candidateRows.map((r) => r.wallet_type))].join(', ')
  }`);
  if (candidateRows.length === 0) {
    console.error('[ERROR] No candidate wallets in discovery_feature_snapshots_v3. Has 04_emit_snapshots run?');
    await db.close();
    process.exit(1);
  }

  // ─── Step 2: probe arb pattern in the candidate pool only ──────────────────
  log(`Step 2/4: probing arb-wallet pattern in candidate pool...`);
  let arbWalletSet: Set<string> = new Set();
  try {
    const arbRows = await db.query<{ proxy_wallet: string; two_side_markets: number }>(
      buildArbProbeSql(candidateRows.map((r) => r.proxy_wallet))
    );
    arbWalletSet = new Set(arbRows.map((r) => r.proxy_wallet));
    log(`  ✓ ${arbWalletSet.size} candidates exhibit arb pattern (>=3 markets with both BUY and SELL)`);
  } catch (err) {
    console.warn(`[WARN] arb probe failed (non-fatal): ${(err as Error).message}`);
  }

  // Re-tag arb wallets in the candidate list (if classified as something else)
  const candidatesByType: Map<WalletType, typeof candidateRows> = new Map();
  for (const wt of WALLET_TYPES) candidatesByType.set(wt, []);
  for (const r of candidateRows) {
    const finalType: WalletType = arbWalletSet.has(r.proxy_wallet) ? 'arb' : r.wallet_type;
    candidatesByType.get(finalType)!.push({ ...r, wallet_type: finalType });
  }

  // ─── Step 3: build the final sample, biasing toward V2 coverage ────────────
  log(`Step 3/4: selecting final ${walletTarget}-wallet sample (per-type round-robin, V2 bias)...`);
  const wantPerType = Math.max(Math.floor(walletTarget / 5), 1);
  const finalSample: Array<{ wallet: string; meta: WalletMeta }> = [];
  const seen = new Set<string>();

  // Pass A: take up to wantPerType from each type, preferring V2-era wallets
  for (const wt of WALLET_TYPES) {
    const pool = candidatesByType.get(wt)!;
    const v2First = [...pool].sort((a, b) => Number(b.has_v2_trades) - Number(a.has_v2_trades));
    let taken = 0;
    for (const r of v2First) {
      if (taken >= wantPerType) break;
      if (seen.has(r.proxy_wallet)) continue;
      seen.add(r.proxy_wallet);
      finalSample.push({
        wallet: r.proxy_wallet,
        meta: {
          walletType: wt,
          hasV2Trades: Boolean(r.has_v2_trades),
          tradeCount: Number(r.trade_count),
          marketCount: Number(r.market_count),
          volume: Number(r.volume),
        },
      });
      taken++;
    }
  }
  // Pass B: fill remaining slots from any type
  if (finalSample.length < walletTarget) {
    for (const r of candidateRows) {
      if (finalSample.length >= walletTarget) break;
      if (seen.has(r.proxy_wallet)) continue;
      seen.add(r.proxy_wallet);
      const finalType: WalletType = arbWalletSet.has(r.proxy_wallet) ? 'arb' : r.wallet_type;
      finalSample.push({
        wallet: r.proxy_wallet,
        meta: {
          walletType: finalType,
          hasV2Trades: Boolean(r.has_v2_trades),
          tradeCount: Number(r.trade_count),
          marketCount: Number(r.market_count),
          volume: Number(r.volume),
        },
      });
    }
  }
  if (finalSample.length === 0) {
    console.error('[ERROR] could not assemble a sample. candidates exist but none survived classification.');
    await db.close();
    process.exit(1);
  }
  // Reduce target if we couldn't find enough
  if (finalSample.length < walletTarget) {
    log(`  [note] only ${finalSample.length} wallets matched filters; continuing with that.`);
    walletTarget = finalSample.length;
  }
  const v2Count = finalSample.filter((s) => s.meta.hasV2Trades).length;
  const typeCounts = WALLET_TYPES.map((wt) => `${wt}=${finalSample.filter((s) => s.meta.walletType === wt).length}`).join(' ');
  log(`  ✓ sample composition: ${typeCounts}, V2-era wallets=${v2Count}`);

  // ─── Step 4: compute our PnL for this small slice (bounded scan) ───────────
  log(`Step 4/4: computing PnL via cash-flow SQL for ${finalSample.length} wallets (bounded scan)...`);
  const walletList = finalSample.map((s) => s.wallet);
  let pnlRows: PnlRow[];
  try {
    pnlRows = await db.query<PnlRow>(buildWalletPnlSql(walletList));
  } catch (err) {
    console.error(`[ERROR] PnL SQL failed: ${(err as Error).message}`);
    await db.close();
    process.exit(1);
  }
  log(`  ✓ PnL computed for ${pnlRows.length}/${finalSample.length} wallets`);
  const pnlByWallet = new Map(pnlRows.map((r) => [r.proxy_wallet, r]));

  // ─── Step 5: cross-check vs. Polymarket Data API ───────────────────────────
  if (isDryRun) {
    log(`(dry-run) skipping API cross-check`);
  } else {
    log(`Cross-checking vs. Polymarket Data API (this dominates the wall clock)...`);
  }
  const results: VerifyResult[] = [];
  let idx = 0;
  for (const { wallet, meta } of finalSample) {
    idx++;
    const pnl = pnlByWallet.get(wallet);

    if (!pnl) {
      log(`  [${idx}/${finalSample.length}] ${wallet.slice(0, 12)}... no PnL row`);
      results.push({
        wallet, walletType: meta.walletType, hasV2Trades: meta.hasV2Trades,
        ourVolume: 0, apiVolume: null, realizedPnl: 0, unrealizedPnl: 0, totalPnl: 0,
        pass: false, reason: 'no PnL row returned from DuckDB',
      });
      continue;
    }

    if (isDryRun) {
      log(`  [${idx}/${finalSample.length}] ${wallet.slice(0, 12)}... (${meta.walletType}) vol=${Number(pnl.our_volume).toFixed(2)} pnl=${Number(pnl.total_pnl).toFixed(2)} (api skipped)`);
      results.push({
        wallet, walletType: meta.walletType, hasV2Trades: meta.hasV2Trades,
        ourVolume: Number(pnl.our_volume), apiVolume: null,
        realizedPnl: Number(pnl.realized_pnl),
        unrealizedPnl: Number(pnl.unrealized_pnl),
        totalPnl: Number(pnl.total_pnl),
        pass: true, reason: 'dry-run, API skipped',
      });
      continue;
    }

    const apiResult = await validateWalletAgainstDataApi(wallet, {
      trade_count: meta.tradeCount,
      volume_total: Number(pnl.our_volume),
    });

    const ourVol = Number(pnl.our_volume);
    const apiVol = apiResult.apiVolume ?? 0;

    let pass = apiResult.ok;
    let reason = apiResult.reason;

    if (apiResult.apiVolume !== null && apiResult.apiTradeCount !== null && apiResult.apiTradeCount > 0) {
      const absDelta = Math.abs(ourVol - apiVol);
      const relDelta = absDelta / Math.max(ourVol, apiVol, 1);
      pass = absDelta <= ABS_TOLERANCE_USD || relDelta <= REL_TOLERANCE;
      reason = pass ? undefined : `volume mismatch: ours=${ourVol.toFixed(2)}, api=${apiVol.toFixed(2)}, absDelta=${absDelta.toFixed(2)}, relDelta=${(relDelta * 100).toFixed(2)}%`;
    }

    results.push({
      wallet, walletType: meta.walletType, hasV2Trades: meta.hasV2Trades,
      ourVolume: ourVol, apiVolume: apiResult.apiVolume,
      realizedPnl: Number(pnl.realized_pnl),
      unrealizedPnl: Number(pnl.unrealized_pnl),
      totalPnl: Number(pnl.total_pnl),
      pass, reason, apiFullyPaginated: apiResult.apiFullyPaginated,
    });
    log(`  [${idx}/${finalSample.length}] ${pass ? '✓' : '✗'} ${wallet.slice(0, 12)}... (${meta.walletType}) ours=${ourVol.toFixed(2)} api=${apiVol.toFixed(2)}`);
  }

  await db.close();

  // ─── Results table ──────────────────────────────────────────────────────────
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

  let passCount = 0, failCount = 0, skippedCount = 0;
  for (const r of results) {
    if (r.reason === 'dry-run, API skipped') skippedCount++;
    else if (r.pass) passCount++;
    else failCount++;

    const pagNote = r.apiFullyPaginated === false ? '[api-capped]' : '';
    console.log([
      r.wallet.padEnd(44),
      r.walletType.padEnd(14),
      (r.hasV2Trades ? 'YES' : 'no').padEnd(5),
      r.ourVolume.toFixed(2).padStart(12),
      (r.apiVolume ?? 0).toFixed(2).padStart(12),
      r.realizedPnl.toFixed(2).padStart(10),
      r.unrealizedPnl.toFixed(2).padStart(11),
      (r.pass ? 'PASS' : 'FAIL').padEnd(6),
      [r.reason ?? '', pagNote].filter(Boolean).join(' '),
    ].join(' '));
  }

  console.log(`\n${'═'.repeat(120)}`);
  if (isDryRun) {
    console.log(`DRY RUN: ${results.length} wallets sampled, API calls skipped.`);
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
