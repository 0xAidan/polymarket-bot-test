import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldIncludeInTierRankings } from '../src/discovery/v3/tierScoring.ts';

test('shouldIncludeInTierRankings excludes copyable=0 wallets', () => {
  const copyMap = new Map([
    ['0xgood', { copyable: 1 }],
    ['0xbad', { copyable: 0 }],
  ]);
  assert.equal(shouldIncludeInTierRankings('0xgood', copyMap), true);
  assert.equal(shouldIncludeInTierRankings('0xbad', copyMap), false);
  assert.equal(shouldIncludeInTierRankings('0xunknown', copyMap), true);
});
