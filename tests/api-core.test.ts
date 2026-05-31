import test from 'node:test';
import assert from 'node:assert/strict';

const loadApiCore = async () => {
  delete (globalThis as Record<string, unknown>).ApiCore;
  try {
    await import(`../public/js/api-core.js?cacheBust=${Date.now()}-${Math.random()}`);
  } catch {
    /* noop */
  }
  return (globalThis as Record<string, unknown>).ApiCore as Record<string, unknown> | undefined;
};

test('readApiResponse surfaces friendly throttle errors for non-JSON responses', async () => {
  const apiCore = await loadApiCore();
  assert.equal(typeof apiCore?.readApiResponse, 'function');

  const response = new Response('Too many requests, please slow down.', {
    status: 429,
    headers: {
      'content-type': 'text/plain',
    },
  });

  const result = await (apiCore.readApiResponse as (input: Response) => Promise<{
    ok: boolean;
    status: number;
    data: Record<string, unknown> | null;
    error: string | null;
  }>)(response);

  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.data, null);
  assert.match(result.error || '', /rate limit|too many requests/i);
});

test('readApiResponse preserves JSON success payloads', async () => {
  const apiCore = await loadApiCore();
  assert.equal(typeof apiCore?.readApiResponse, 'function');

  const response = new Response(JSON.stringify({
    success: true,
    wallets: [{ address: '0x1' }],
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });

  const result = await (apiCore.readApiResponse as (input: Response) => Promise<{
    ok: boolean;
    status: number;
    data: Record<string, unknown> | null;
    error: string | null;
  }>)(response);

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {
    success: true,
    wallets: [{ address: '0x1' }],
  });
  assert.equal(result.error, null);
});
