import test from 'node:test';
import assert from 'node:assert/strict';
import {
  corruptionHeuristicReason,
  filterScoresForPublish,
} from '../src/discovery/v3/publishQualityGate.js';

test('corruptionHeuristic: rejects million PnL retail profile pattern', () => {
  const reason = corruptionHeuristicReason({
    proxy_wallet: '0xa61ef8773ec2e821962306ca87d4b57e39ff0abd',
    tier: 'alpha',
    volume_total: 26_000_000,
    trade_count: 629_864,
    realized_pnl: 22_000_000,
    predictions_count: 734,
  });
  assert.ok(reason);
});

test('corruptionHeuristic: allows plausible small wallet', () => {
  const reason = corruptionHeuristicReason({
    proxy_wallet: '0xfedc381bf3fb5d20433bb4a0216b15dbbc5c6398',
    tier: 'alpha',
    volume_total: 120_000,
    trade_count: 400,
    realized_pnl: 83_500,
    predictions_count: 115,
  });
  assert.equal(reason, null);
});

test('filterScoresForPublish: heuristic excludes without API when SKIP_PUBLISH_API_GATE', async () => {
  const prev = process.env.SKIP_PUBLISH_API_GATE;
  process.env.SKIP_PUBLISH_API_GATE = '1';
  try {
    const { kept, excluded } = await filterScoresForPublish([
      {
        proxy_wallet: '0xbad',
        tier: 'alpha',
        volume_total: 50_000_000,
        trade_count: 1_000_000,
        realized_pnl: 40_000_000,
        predictions_count: 100,
      },
      {
        proxy_wallet: '0xok',
        tier: 'alpha',
        volume_total: 50_000,
        trade_count: 200,
        realized_pnl: 1_000,
        predictions_count: 50,
      },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].proxy_wallet, '0xok');
    assert.equal(excluded.length, 1);
  } finally {
    if (prev === undefined) delete process.env.SKIP_PUBLISH_API_GATE;
    else process.env.SKIP_PUBLISH_API_GATE = prev;
  }
});
