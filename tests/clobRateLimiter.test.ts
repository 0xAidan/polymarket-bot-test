import test from 'node:test';
import assert from 'node:assert/strict';

import { ClobRateLimiter } from '../src/clobRateLimiter.js';

test('acquire grants immediately under the configured limits', async () => {
  const limiter = new ClobRateLimiter({
    burstLimit: 10,
    burstWindowMs: 10_000,
    sustainedLimit: 100,
    sustainedWindowMs: 60_000,
    maxConcurrentPerTenant: 2,
  });

  const release = await limiter.acquire('tenant-a');
  assert.equal(typeof release, 'function');
  release();
});

test('acquire respects per-tenant concurrency and gives another tenant a turn first', async () => {
  const limiter = new ClobRateLimiter({
    burstLimit: 10,
    burstWindowMs: 10_000,
    sustainedLimit: 100,
    sustainedWindowMs: 60_000,
    maxConcurrentPerTenant: 1,
  });

  const order: string[] = [];

  const releaseA1 = await limiter.acquire('tenant-a');
  order.push('a1');

  const secondA = limiter.acquire('tenant-a').then((release) => {
    order.push('a2');
    return release;
  });

  const firstB = limiter.acquire('tenant-b').then((release) => {
    order.push('b1');
    return release;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ['a1', 'b1']);

  releaseA1();

  const releaseA2 = await secondA;
  assert.deepEqual(order, ['a1', 'b1', 'a2']);

  const releaseB1 = await firstB;
  releaseB1();
  releaseA2();
});

test('acquire waits for the burst window when the limiter is full', async () => {
  const limiter = new ClobRateLimiter({
    burstLimit: 1,
    burstWindowMs: 50,
    sustainedLimit: 100,
    sustainedWindowMs: 60_000,
    maxConcurrentPerTenant: 2,
  });

  const release1 = await limiter.acquire('tenant-a');
  const start = Date.now();
  const secondPermit = limiter.acquire('tenant-a');

  await new Promise((resolve) => setTimeout(resolve, 20));
  release1();

  const release2 = await secondPermit;
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 45, `expected limiter to wait for burst window, got ${elapsed}ms`);
  release2();
});
