import test from 'node:test';
import assert from 'node:assert/strict';

import { isEligible, ELIGIBILITY_THRESHOLDS } from '../src/discovery/v3/eligibility.ts';

const NOW = 1_700_000_000;
const DAY = 86_400;

function base() {
  return {
    observation_span_days: 60,
    distinct_markets: 20,
    trade_count: 50,
    closed_positions: 10,
    last_active_ts: NOW - 5 * DAY,
    realized_pnl: 100,
    now_ts: NOW,
  };
}

test('eligibility: all gates pass → eligible', () => {
  const r = isEligible(base());
  assert.equal(r.eligible, true);
  assert.deepEqual(r.reasons, []);
});

test('eligibility: observation span just under → rejected', () => {
  const r = isEligible({ ...base(), observation_span_days: ELIGIBILITY_THRESHOLDS.MIN_OBSERVATION_SPAN_DAYS - 1 });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('OBSERVATION_SPAN_TOO_SHORT'));
});

test('eligibility: observation span exactly at gate → pass', () => {
  const r = isEligible({ ...base(), observation_span_days: ELIGIBILITY_THRESHOLDS.MIN_OBSERVATION_SPAN_DAYS });
  assert.equal(r.eligible, true);
});

test('eligibility: distinct markets just under → rejected', () => {
  const r = isEligible({ ...base(), distinct_markets: ELIGIBILITY_THRESHOLDS.MIN_DISTINCT_MARKETS - 1 });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('TOO_FEW_DISTINCT_MARKETS'));
});

test('eligibility: trade count just under → rejected', () => {
  const r = isEligible({ ...base(), trade_count: ELIGIBILITY_THRESHOLDS.MIN_TRADE_COUNT - 1 });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('TOO_FEW_TRADES'));
});

test('eligibility: closed positions just under → rejected', () => {
  const r = isEligible({ ...base(), closed_positions: ELIGIBILITY_THRESHOLDS.MIN_CLOSED_POSITIONS - 1 });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('TOO_FEW_CLOSED_POSITIONS'));
});

test('eligibility: dormant wallet (46 days idle) rejected', () => {
  const r = isEligible({
    ...base(),
    last_active_ts: NOW - 46 * DAY,
  });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('DORMANT'));
});

test('eligibility: last active exactly at dormancy edge → pass', () => {
  const r = isEligible({
    ...base(),
    last_active_ts: NOW - ELIGIBILITY_THRESHOLDS.MAX_DORMANCY_DAYS * DAY,
  });
  assert.equal(r.eligible, true);
});

test('eligibility: realized PnL under minimum → rejected', () => {
  const r = isEligible({ ...base(), realized_pnl: ELIGIBILITY_THRESHOLDS.MIN_REALIZED_PNL - 1 });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('REALIZED_PNL_TOO_LOW'));
});

test('eligibility: PnL per closed position under minimum (with closed > 0) → rejected', () => {
  const closed = 10;
  const pnl = ELIGIBILITY_THRESHOLDS.MIN_PNL_PER_TRADE * closed - 0.01;
  const r = isEligible({ ...base(), closed_positions: closed, realized_pnl: pnl });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('PNL_PER_TRADE_TOO_LOW'));
});

test('eligibility: multiple failures aggregate reasons', () => {
  const r = isEligible({
    observation_span_days: 5,
    distinct_markets: 1,
    trade_count: 2,
    closed_positions: 0,
    last_active_ts: NOW - 100 * DAY,
    realized_pnl: -1,
    now_ts: NOW,
  });
  assert.equal(r.eligible, false);
  assert.equal(r.reasons.length, 6);
  assert.ok(r.reasons.includes('REALIZED_PNL_TOO_LOW'));
});
