import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreTiers, latestSnapshotPerWallet } from '../src/discovery/v3/tierScoring.ts';
import type { V3FeatureSnapshot } from '../src/discovery/v3/types.ts';

const NOW = 1_700_000_000;

function mkSnap(
  wallet: string,
  over: Partial<V3FeatureSnapshot> = {}
): V3FeatureSnapshot {
  return {
    proxy_wallet: wallet,
    snapshot_day: '2024-01-01',
    trade_count: 50,
    volume_total: 10000,
    distinct_markets: 15,
    closed_positions: 10,
    realized_pnl: 500,
    unrealized_pnl: 0,
    first_active_ts: NOW - 90 * 86400,
    last_active_ts: NOW - 3 * 86400,
    observation_span_days: 90,
    ...over,
  };
}

test('scoreTiers rejects ineligible wallets and produces tier rankings', () => {
  const inputs = [
    { snapshot: mkSnap('0xWhale', { volume_total: 5_000_000, trade_count: 500 }),      now_ts: NOW },
    { snapshot: mkSnap('0xAlpha', { realized_pnl: 5000, closed_positions: 40 }),        now_ts: NOW },
    { snapshot: mkSnap('0xMid'),                                                        now_ts: NOW },
    { snapshot: mkSnap('0xTiny', { trade_count: 3, closed_positions: 0 }),              now_ts: NOW },
    { snapshot: mkSnap('0xDorm', { last_active_ts: NOW - 200 * 86400 }),                now_ts: NOW },
  ];

  const { scores, stats } = scoreTiers(inputs);
  assert.equal(stats.total, 5);
  assert.equal(stats.eligible, 3);
  // 3 wallets x 3 tiers = 9 rows
  assert.equal(scores.length, 9);

  const whaleTop = scores.filter((s) => s.tier === 'whale').sort((a, b) => a.tier_rank - b.tier_rank);
  assert.equal(whaleTop[0].proxy_wallet, '0xWhale', 'highest volume wallet ranks #1 in whale tier');

  const alphaTop = scores.filter((s) => s.tier === 'alpha').sort((a, b) => a.tier_rank - b.tier_rank);
  assert.equal(alphaTop[0].proxy_wallet, '0xAlpha', 'highest-edge wallet ranks #1 in alpha tier');

  // Ineligible wallets never appear.
  const surfaced = new Set(scores.map((s) => s.proxy_wallet));
  assert.equal(surfaced.has('0xTiny'), false);
  assert.equal(surfaced.has('0xDorm'), false);
});

test('latestSnapshotPerWallet keeps the newest snapshot per wallet', () => {
  const m = latestSnapshotPerWallet([
    mkSnap('0xA', { snapshot_day: '2024-01-01' }),
    mkSnap('0xA', { snapshot_day: '2024-02-01' }),
    mkSnap('0xB', { snapshot_day: '2024-01-15' }),
  ]);
  assert.equal(m.size, 2);
  assert.equal(m.get('0xA')!.snapshot_day, '2024-02-01');
  assert.equal(m.get('0xB')!.snapshot_day, '2024-01-15');
});

test('scoreTiers produces empty output when nothing eligible', () => {
  const inputs = [
    { snapshot: mkSnap('0xTiny', { trade_count: 1 }), now_ts: NOW },
  ];
  const { scores, stats } = scoreTiers(inputs);
  assert.equal(stats.eligible, 0);
  assert.equal(stats.rejection_rate, 1);
  assert.equal(scores.length, 0);
});
