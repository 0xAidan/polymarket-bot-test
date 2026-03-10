import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPositionKey,
  normalizeOutcomeLabel,
  resolveTradeMarketId,
} from '../src/tradeIdentity.js';

test('normalizeOutcomeLabel preserves non-binary labels instead of coercing them to YES', () => {
  assert.equal(normalizeOutcomeLabel('Trump'), 'TRUMP');
  assert.equal(normalizeOutcomeLabel('No'), 'NO');
  assert.equal(normalizeOutcomeLabel(undefined, 0), 'YES');
  assert.equal(normalizeOutcomeLabel(undefined, 2), 'OUTCOME_2');
});

test('resolveTradeMarketId requires a condition id and does not silently fall back to the asset id', () => {
  assert.equal(resolveTradeMarketId({ conditionId: '0xcondition', asset: 'token-1' }), '0xcondition');
  assert.equal(resolveTradeMarketId({ conditionId: '', asset: 'token-1' }), null);
});

test('buildPositionKey prefers token identity and only falls back to market plus outcome label', () => {
  assert.equal(
    buildPositionKey({ marketId: '0xcondition', tokenId: 'token-1', outcome: 'TRUMP' }),
    'token:token-1',
  );

  assert.equal(
    buildPositionKey({ marketId: '0xcondition', outcome: 'TRUMP' }),
    'market:0xcondition:TRUMP',
  );
});
