import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPolymarketAddress } from '../src/jungleAgentsPolymarketSync.js';

describe('jungleAgentsPolymarketSync', () => {
  it('verifyPolymarketAddress marks inactive wallets as invalid', async () => {
    const result = await verifyPolymarketAddress('0xbb08a5b089706db064441dbfbd323145f7164591');
    assert.equal(result.hasActivity, false);
    assert.equal(result.portfolioValueUsd, 0);
    assert.equal(result.isLikelyValid, false);
  });

  it('verifyPolymarketAddress marks active proxy wallets as valid', async () => {
    const result = await verifyPolymarketAddress('0xa42451f52ee663df451a6fecc704850469b2ee6f');
    assert.equal(result.isLikelyValid, true);
    assert.ok(result.portfolioValueUsd > 0 || result.hasActivity);
  });
});
