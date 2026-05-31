import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayDisplayStats } from '../src/discovery/v3/displayStatsOverlay.js';

test('overlayDisplayStats: uses reference PnL when fetch succeeds', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/closed-positions?')) {
      return new Response(JSON.stringify([{ realizedPnl: -40000 }]), { status: 200 });
    }
    if (url.includes('/positions?')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes('/traded?')) {
      return new Response(JSON.stringify({ traded: 10 }), { status: 200 });
    }
    if (url.includes('gamma-api')) {
      return new Response(JSON.stringify({ name: 'tester' }), { status: 200 });
    }
    if (url.includes('/activity?')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;

  try {
    const [row] = await overlayDisplayStats(
      [{ address: '0xabc0000000000000000000000000000000000001', realizedPnl: 42000, volumeTotal: 1 }],
      { allowPipelineFallback: false }
    );
    assert.equal(row.realizedPnl, -40000);
  } finally {
    globalThis.fetch = original;
  }
});
