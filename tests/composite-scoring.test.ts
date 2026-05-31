/**
 * Unit tests for JUNGLE Score pillar scoring logic.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMomentumZ,
  computeConsistencyRaw,
  scoreComposite,
} from '../src/discovery/v3/compositeScoring.js';
import type { WalletMomentumStats, WalletConsistencyStats } from '../src/discovery/v3/compositeTypes.js';

// ---------------------------------------------------------------------------
// Momentum (Heat Pillar)
// ---------------------------------------------------------------------------

describe('computeMomentumZ', () => {
  test('returns 0 for wallets with insufficient history (<14 days)', () => {
    const stats: WalletMomentumStats = {
      proxy_wallet: '0xSHORT',
      pnl_7d: 100,
      trades_7d: 10,
      pnl_30d: 200,
      trades_30d: 20,
      avg_daily_pnl: 5,
      std_daily_pnl: 2,
      active_days: 10, // too few
    };
    assert.equal(computeMomentumZ(stats), 0);
  });

  test('returns 0 when std_daily_pnl is 0 (zero variance)', () => {
    const stats: WalletMomentumStats = {
      proxy_wallet: '0xFLAT',
      pnl_7d: 35,
      trades_7d: 7,
      pnl_30d: 150,
      trades_30d: 30,
      avg_daily_pnl: 5,
      std_daily_pnl: 0, // zero variance
      active_days: 30,
    };
    assert.equal(computeMomentumZ(stats), 0);
  });

  test('returns negative z for cold wallet (no recent trades)', () => {
    const stats: WalletMomentumStats = {
      proxy_wallet: '0xCOLD',
      pnl_7d: 0,
      trades_7d: 0,
      pnl_30d: 0,
      trades_30d: 0,
      avg_daily_pnl: 10,
      std_daily_pnl: 5,
      active_days: 60,
    };
    assert.equal(computeMomentumZ(stats), -1);
  });

  test('returns positive z for hot streak', () => {
    const stats: WalletMomentumStats = {
      proxy_wallet: '0xHOT',
      pnl_7d: 100,        // 100/7 ≈ 14.3 daily avg
      trades_7d: 20,
      pnl_30d: 150,
      trades_30d: 60,
      avg_daily_pnl: 5,   // long-term avg is 5
      std_daily_pnl: 3,   // std is 3
      active_days: 90,
    };
    const z = computeMomentumZ(stats);
    // (14.3 - 5) / 3 ≈ 3.1 — strong hot streak
    assert.ok(z > 2, `expected z > 2, got ${z}`);
  });

  test('returns negative z for cold streak', () => {
    const stats: WalletMomentumStats = {
      proxy_wallet: '0xDOWN',
      pnl_7d: -20,        // losing
      trades_7d: 10,
      pnl_30d: -10,
      trades_30d: 40,
      avg_daily_pnl: 5,
      std_daily_pnl: 3,
      active_days: 60,
    };
    const z = computeMomentumZ(stats);
    assert.ok(z < 0, `expected z < 0, got ${z}`);
  });
});

// ---------------------------------------------------------------------------
// Consistency (Risk DNA Pillar)
// ---------------------------------------------------------------------------

describe('computeConsistencyRaw', () => {
  test('returns 0 for wallets with too few bets (<10)', () => {
    const stats: WalletConsistencyStats = {
      proxy_wallet: '0xFEW',
      avg_bet_size: 50,
      std_bet_size: 10,
      bet_size_cv: 0.2,
      total_bets: 5,
      avg_bet_7d: 50,
      max_bet_size: 100,
    };
    assert.equal(computeConsistencyRaw(stats), 0);
  });

  test('high consistency for low CV wallet', () => {
    const stats: WalletConsistencyStats = {
      proxy_wallet: '0xPRO',
      avg_bet_size: 100,
      std_bet_size: 20,
      bet_size_cv: 0.2,   // very consistent
      total_bets: 200,
      avg_bet_7d: 105,
      max_bet_size: 150,
    };
    const score = computeConsistencyRaw(stats);
    // 1/0.2 = 5.0 — high consistency
    assert.ok(score > 3, `expected high consistency, got ${score}`);
  });

  test('low consistency for high CV wallet', () => {
    const stats: WalletConsistencyStats = {
      proxy_wallet: '0xERRATIC',
      avg_bet_size: 50,
      std_bet_size: 150,
      bet_size_cv: 3.0,   // very erratic
      total_bets: 100,
      avg_bet_7d: 60,
      max_bet_size: 5000,
    };
    const score = computeConsistencyRaw(stats);
    // 1/3.0 ≈ 0.33 — low consistency
    assert.ok(score < 1, `expected low consistency, got ${score}`);
  });

  test('tilt penalty applied when recent bet size is 4× average', () => {
    const stats: WalletConsistencyStats = {
      proxy_wallet: '0xTILT',
      avg_bet_size: 100,
      std_bet_size: 30,
      bet_size_cv: 0.3,
      total_bets: 100,
      avg_bet_7d: 400,    // 4× average — tilting
      max_bet_size: 500,
    };
    const score = computeConsistencyRaw(stats);

    // Without tilt: 1/0.3 ≈ 3.33
    // With tilt (ratio=4, penalty=0.15): 3.33 × 0.85 ≈ 2.83
    const noTilt = 1 / 0.3;
    assert.ok(score < noTilt, `expected tilt penalty: ${score} should be < ${noTilt}`);
  });
});

// ---------------------------------------------------------------------------
// Composite Score (scoreComposite)
// ---------------------------------------------------------------------------

describe('scoreComposite', () => {
  test('returns empty for empty input', () => {
    const result = scoreComposite([]);
    assert.equal(result.scores.length, 0);
    assert.equal(result.stats.total, 0);
  });

  test('scores multiple wallets and ranks by composite', () => {
    const wallets = [
      {
        proxy_wallet: '0xHOT_PRO',
        avg_bet_size: 100, std_bet_size: 20, bet_size_cv: 0.2,
        total_bets: 200, avg_bet_7d: 105, max_bet_size: 150,
        pnl_7d: 100, trades_7d: 20, pnl_30d: 200, trades_30d: 60,
        avg_daily_pnl: 5, std_daily_pnl: 3, active_days: 90,
        brier_score: 0.05, pct_positive_clv_1h: 0.9, cat_volume_share: 0.8, cat_pnl: 500,
      },
      {
        proxy_wallet: '0xCOLD_ERRATIC',
        avg_bet_size: 50, std_bet_size: 150, bet_size_cv: 3.0,
        total_bets: 100, avg_bet_7d: 60, max_bet_size: 5000,
        pnl_7d: -20, trades_7d: 5, pnl_30d: -10, trades_30d: 20,
        avg_daily_pnl: 2, std_daily_pnl: 10, active_days: 60,
        brier_score: 0.24, pct_positive_clv_1h: 0.1, cat_volume_share: 0.1, cat_pnl: 10,
      },
      {
        proxy_wallet: '0xMEDIUM',
        avg_bet_size: 75, std_bet_size: 50, bet_size_cv: 0.67,
        total_bets: 150, avg_bet_7d: 80, max_bet_size: 200,
        pnl_7d: 20, trades_7d: 10, pnl_30d: 50, trades_30d: 40,
        avg_daily_pnl: 3, std_daily_pnl: 4, active_days: 45,
        brier_score: 0.15, pct_positive_clv_1h: 0.5, cat_volume_share: 0.4, cat_pnl: 100,
      },
    ];

    const result = scoreComposite(wallets, 10);
    assert.equal(result.scores.length, 3);
    assert.equal(result.stats.total, 3);
    assert.equal(result.stats.scored, 3);

    // Hot + consistent wallet should rank #1.
    assert.equal(result.scores[0].proxy_wallet, '0xHOT_PRO');
    // Cold + erratic wallet should rank last.
    assert.equal(result.scores[2].proxy_wallet, '0xCOLD_ERRATIC');

    // All scores should be in [0, 100].
    for (const s of result.scores) {
      assert.ok(s.composite_score >= 0 && s.composite_score <= 100,
        `score out of range: ${s.composite_score}`);
    }
  });

  test('respects topN limit', () => {
    const wallets = Array.from({ length: 10 }, (_, i) => ({
      proxy_wallet: `0xWALLET_${i}`,
      avg_bet_size: 100, std_bet_size: 20, bet_size_cv: 0.2 + i * 0.1,
      total_bets: 100, avg_bet_7d: 100, max_bet_size: 200,
      pnl_7d: 50 - i * 10, trades_7d: 10, pnl_30d: 100, trades_30d: 30,
      avg_daily_pnl: 5, std_daily_pnl: 3, active_days: 30,
    }));

    const result = scoreComposite(wallets, 3);
    assert.equal(result.scores.length, 3);
    assert.equal(result.stats.total, 10);
  });
});
