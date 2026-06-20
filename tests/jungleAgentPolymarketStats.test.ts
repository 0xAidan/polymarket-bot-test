import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeJungleAgentPolymarketStats,
  fetchJungleAgentPolymarketStats,
} from '../src/jungleAgentPolymarketStats.js';

test('computeJungleAgentPolymarketStats matches Polymarket lifetime PnL and win rate', () => {
  const stats = computeJungleAgentPolymarketStats(
    '0xabc',
    [
      { realizedPnl: 120, avgPrice: 0.4, totalBought: 100 },
      { realizedPnl: -30, avgPrice: 0.5, totalBought: 60 },
      { realizedPnl: 0, avgPrice: 0.2, totalBought: 50 },
    ],
    [
      { size: 10, cashPnl: 25, initialValue: 40 },
    ],
    40,
    78,
  );

  assert.equal(stats.lifetimePnlUsd, 115);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1);
  assert.equal(stats.breakeven, 1);
  assert.equal(stats.winRatePct, 50);
  assert.equal(stats.positionCount, 1);
  assert.equal(stats.positionsValueUsd, 40);
  assert.equal(stats.usdcBalanceUsd, 78);
  assert.equal(stats.portfolioValueUsd, 118);
  assert.equal(stats.totalDeployedUsd, 120);
  assert.equal(stats.roiPct, 95.8);
});

test('fetchJungleAgentPolymarketStats paginates closed and open positions and adds cash', async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes('/closed-positions?')) {
      return new Response(JSON.stringify([{ realizedPnl: 50, avgPrice: 0.5, totalBought: 100 }]));
    }
    if (url.includes('/positions?')) {
      return new Response(JSON.stringify([{ size: 5, cashPnl: 10, initialValue: 20, currentValue: 30 }]));
    }
    if (url.includes('/value?')) {
      return new Response(JSON.stringify([{ user: '0xabc', value: 30 }]));
    }
    return new Response('[]');
  };

  const stats = await fetchJungleAgentPolymarketStats('0xabc', fetchImpl as typeof fetch, {
    getCashBalance: async () => 12.5,
  });
  assert.ok(stats);
  assert.equal(stats?.lifetimePnlUsd, 60);
  assert.equal(stats?.wins, 1);
  assert.equal(stats?.winRatePct, 100);
  assert.equal(stats?.positionsValueUsd, 30);
  assert.equal(stats?.usdcBalanceUsd, 12.5);
  assert.equal(stats?.portfolioValueUsd, 42.5);
});
