/**
 * Tests for dataApiValidator.ts — specifically the rev-2 correctness rules
 * documented in docs/2026-04-24-post-backfill-validator-triage.md:
 *   1. Paginates past limit=500
 *   2. Filters to type='TRADE' only
 *   3. Uses volume as the authoritative check, not trade_count
 *   4. Treats derived >= api as PASS when pagination capped out
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWalletAgainstDataApi } from '../src/discovery/v3/dataApiValidator.ts';

type FetchImpl = typeof fetch;

/**
 * Tiny mock fetch. Takes a function from URL → { status, body } and returns
 * a fetch-compatible impl that only understands GET.
 */
function mockFetch(handler: (url: string) => { status?: number; body: unknown }): FetchImpl {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const { status = 200, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as FetchImpl;
}

function trade(usdcSize: number) {
  return { type: 'TRADE', usdcSize };
}
function redeem(usdcSize: number) {
  return { type: 'REDEEM', usdcSize };
}

test('validator: small wallet, single page, volume matches → PASS', async () => {
  const events = [trade(100), trade(50), trade(25)];
  const fetchImpl = mockFetch((url) => {
    if (url.includes('offset=0')) return { body: events };
    return { body: [] };
  });
  const r = await validateWalletAgainstDataApi(
    '0xabc',
    { trade_count: 3, volume_total: 175 },
    { fetchImpl }
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.apiTradeCount, 3);
  assert.equal(r.apiVolume, 175);
  assert.equal(r.apiFullyPaginated, true);
});

test('validator: filters out REDEEM events from count and volume', async () => {
  const events = [trade(100), redeem(999999), trade(50)];
  const fetchImpl = mockFetch(() => ({ body: events }));
  const r = await validateWalletAgainstDataApi(
    '0xabc',
    { trade_count: 2, volume_total: 150 },
    { fetchImpl }
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.apiTradeCount, 2, 'REDEEM should not count');
  assert.equal(r.apiVolume, 150, 'REDEEM volume should not be summed');
});

test('validator: paginates past limit=500', async () => {
  // 750 trades → two pages: 500 + 250
  const fetchImpl = mockFetch((url) => {
    if (url.includes('offset=0')) return { body: Array.from({ length: 500 }, () => trade(1)) };
    if (url.includes('offset=500')) return { body: Array.from({ length: 250 }, () => trade(1)) };
    return { body: [] };
  });
  const r = await validateWalletAgainstDataApi(
    '0xabc',
    { trade_count: 750, volume_total: 750 },
    { fetchImpl }
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.apiTradeCount, 750);
  assert.equal(r.apiVolume, 750);
  assert.equal(r.apiFullyPaginated, true);
});

test('validator: pagination cap treated as lower bound — derived >= api → PASS', async () => {
  // Every page returns 500 trades of $1. With maxPages=3 we fetch 1500.
  // Derived claims 5000 (we have the full picture; API is truncated).
  const fetchImpl = mockFetch(() => ({ body: Array.from({ length: 500 }, () => trade(1)) }));
  const r = await validateWalletAgainstDataApi(
    '0xmega',
    { trade_count: 5000, volume_total: 5000 },
    { fetchImpl, maxPages: 3 }
  );
  assert.equal(r.apiFullyPaginated, false);
  assert.equal(r.apiVolume, 1500);
  assert.equal(r.ok, true, 'derived volume >= api lower bound should PASS when capped');
});

test('validator: pagination cap but derived < api → FAIL (we are missing data)', async () => {
  const fetchImpl = mockFetch(() => ({ body: Array.from({ length: 500 }, () => trade(10)) }));
  const r = await validateWalletAgainstDataApi(
    '0xmega',
    { trade_count: 100, volume_total: 1000 },
    { fetchImpl, maxPages: 2 }
  );
  assert.equal(r.apiFullyPaginated, false);
  assert.equal(r.apiVolume, 10000);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /derived volume .* < api-lower-bound/);
});

test('validator: deep-offset 500 error treated as end-of-pagination, not failure', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('offset=0')) return { body: Array.from({ length: 500 }, () => trade(1)) };
    if (url.includes('offset=500')) return { status: 500, body: null };
    return { body: [] };
  });
  const r = await validateWalletAgainstDataApi(
    '0xabc',
    { trade_count: 500, volume_total: 500 },
    { fetchImpl }
  );
  assert.equal(r.apiFullyPaginated, false);
  assert.equal(r.apiVolume, 500);
  // derived 500 >= api lower bound 500 → PASS
  assert.equal(r.ok, true, r.reason);
});

test('validator: 0-page 500 error → FAIL with http reason', async () => {
  const fetchImpl = mockFetch(() => ({ status: 500, body: null }));
  const r = await validateWalletAgainstDataApi(
    '0xabc',
    { trade_count: 100, volume_total: 100 },
    { fetchImpl }
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /http 500/);
});

test('validator: volume delta inside tolerance → PASS', async () => {
  // API says 100, derived says 103 → 3% delta, within default 5%
  const fetchImpl = mockFetch(() => ({ body: [trade(100)] }));
  const r = await validateWalletAgainstDataApi(
    '0xabc',
    { trade_count: 1, volume_total: 103 },
    { fetchImpl }
  );
  assert.equal(r.ok, true, r.reason);
});

test('validator: volume delta exceeds tolerance → FAIL', async () => {
  const fetchImpl = mockFetch(() => ({ body: [trade(100)] }));
  const r = await validateWalletAgainstDataApi(
    '0xabc',
    { trade_count: 1, volume_total: 200 },
    { fetchImpl }
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /volume delta 50\.00%/);
});

test('validator: different trade_count is OK when volume matches (granularity difference)', async () => {
  // Derived sees 50 OrderFilled events, API sees 10 user trades.
  // Each user trade filled against 5 makers → same USDC volume.
  const fetchImpl = mockFetch(() => ({
    body: Array.from({ length: 10 }, () => trade(100)),
  }));
  const r = await validateWalletAgainstDataApi(
    '0xabc',
    { trade_count: 50, volume_total: 1000 },
    { fetchImpl }
  );
  assert.equal(r.ok, true, 'volume match > trade_count mismatch');
  assert.equal(r.apiTradeCount, 10);
  assert.equal(r.derivedTradeCount, 50);
});
