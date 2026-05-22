import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolymarketProfileUrl } from '../src/discovery/v3/profileUrl.ts';

test('profileUrl: uses Gamma name handle when present', () => {
  assert.equal(
    buildPolymarketProfileUrl('0x8f7a4b414417911e7e9bd738399874792cdbdb40', 'duderr'),
    'https://polymarket.com/@duderr'
  );
});

test('profileUrl: falls back to /profile/address without name', () => {
  assert.equal(
    buildPolymarketProfileUrl('0x7b1a206a945c61d3703efda94cf8f5de73bbb29f', null),
    'https://polymarket.com/profile/0x7b1a206a945c61d3703efda94cf8f5de73bbb29f'
  );
});

test('profileUrl: does not treat 0x name as handle', () => {
  assert.equal(
    buildPolymarketProfileUrl('0xaaaa', '0xbbbb'),
    'https://polymarket.com/profile/0xaaaa'
  );
});
