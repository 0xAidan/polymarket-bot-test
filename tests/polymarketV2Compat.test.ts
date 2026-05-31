import test from 'node:test';
import assert from 'node:assert/strict';
import { PolymarketApi } from '../src/polymarketApi.js';
import {
  isDiscoveryV3GoldskyEnabled,
  CLOB_V2_CUTOVER_MS,
} from '../src/discovery/v3/featureFlag.js';

test('PolymarketApi.placeOrder is disabled under CLOB V2', async () => {
  const api = new PolymarketApi();
  await assert.rejects(
    () => api.placeOrder({
      tokenId: '123',
      side: 'BUY',
      size: '1',
      price: '0.5',
    }),
    /disabled/i,
  );
});

test('Goldsky ingest disabled by default after V2 cutover unless env override', () => {
  const prev = process.env.DISCOVERY_V3_GOLDSKY_ENABLED;
  delete process.env.DISCOVERY_V3_GOLDSKY_ENABLED;
  try {
    if (Date.now() >= CLOB_V2_CUTOVER_MS) {
      assert.equal(isDiscoveryV3GoldskyEnabled(), false);
    }
    process.env.DISCOVERY_V3_GOLDSKY_ENABLED = 'true';
    assert.equal(isDiscoveryV3GoldskyEnabled(), true);
    process.env.DISCOVERY_V3_GOLDSKY_ENABLED = 'false';
    assert.equal(isDiscoveryV3GoldskyEnabled(), false);
  } finally {
    if (prev === undefined) {
      delete process.env.DISCOVERY_V3_GOLDSKY_ENABLED;
    } else {
      process.env.DISCOVERY_V3_GOLDSKY_ENABLED = prev;
    }
  }
});
