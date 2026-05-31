import test from 'node:test';
import assert from 'node:assert/strict';

const loadDiscoveryCore = async () => {
  delete (globalThis as Record<string, unknown>).DiscoveryCore;
  try {
    await import(`../public/js/discovery-core.js?cacheBust=${Date.now()}-${Math.random()}`);
  } catch {
    /* noop */
  }
  return (globalThis as Record<string, unknown>).DiscoveryCore as Record<string, unknown> | undefined;
};

test('normalizeTrustScore falls back to trust, not profitability', async () => {
  const discoveryCore = await loadDiscoveryCore();
  assert.equal(typeof discoveryCore?.normalizeTrustScore, 'function');

  const score = (discoveryCore.normalizeTrustScore as (wallet: Record<string, unknown>) => number)({
    separateScores: {
      trust: 81,
      profitability: 22,
    },
  });

  assert.equal(score, 81);
});

test('getDiscoveryColumnBucket honors the server surface bucket', async () => {
  const discoveryCore = await loadDiscoveryCore();
  assert.equal(typeof discoveryCore?.getDiscoveryColumnBucket, 'function');

  const trusted = (discoveryCore.getDiscoveryColumnBucket as (wallet: Record<string, unknown>) => string)({
    surfaceBucket: 'trusted',
    isTracked: false,
  });
  const watchOnly = (discoveryCore.getDiscoveryColumnBucket as (wallet: Record<string, unknown>) => string)({
    surfaceBucket: 'watch_only',
    isTracked: false,
  });
  const tracked = (discoveryCore.getDiscoveryColumnBucket as (wallet: Record<string, unknown>) => string)({
    surfaceBucket: 'copyable',
    isTracked: true,
  });

  assert.equal(trusted, 'trusted');
  assert.equal(watchOnly, 'watch-only');
  assert.equal(tracked, 'copyable');
});
