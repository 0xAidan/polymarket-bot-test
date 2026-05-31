import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import rateLimit from 'express-rate-limit';
import { AddressInfo } from 'node:net';

/**
 * These tests encode the contract the discovery-v3 UI relies on:
 *   1. When the API rate limiter trips, the client receives JSON — never plain
 *      text — so `res.json()` cannot throw "Unexpected token 'T'".
 *   2. The `/api/discovery/v3/*` path tree is exempt from the per-IP limiter,
 *      because it is the authenticated read-only dashboard surface.
 *
 * The middleware is re-created inline (mirroring src/server.ts) so this test is
 * hermetic and does not require full server bootstrap (Auth0 etc.).
 */

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);

  const jsonRateLimitHandler = (
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
    options: any
  ) => {
    const retryAfterSec = Math.ceil((options?.windowMs ?? 60_000) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({
      success: false,
      error: 'rate_limited',
      message: 'Too many requests — please slow down.',
      retryAfterSec,
    });
  };

  const isRateLimitExempt = (req: express.Request): boolean => {
    const p = req.path || '';
    return p.startsWith('/discovery/v3/');
  };

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isRateLimitExempt,
    handler: jsonRateLimitHandler,
  });

  app.use('/api', apiLimiter, (req, res) => {
    res.json({ success: true, path: req.path });
  });

  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('apiLimiter returns JSON (not plain text) when tripped', async () => {
  const { url, close } = await listen(buildApp());
  try {
    // Burn through the quota (max = 2).
    await fetch(`${url}/api/trades`);
    await fetch(`${url}/api/trades`);
    const res = await fetch(`${url}/api/trades`);

    assert.equal(res.status, 429);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'rate_limited');
    assert.ok(typeof body.retryAfterSec === 'number' && body.retryAfterSec > 0);
    assert.ok(res.headers.get('Retry-After'));
  } finally {
    await close();
  }
});

test('/api/discovery/v3/* paths are exempt from the apiLimiter', async () => {
  const { url, close } = await listen(buildApp());
  try {
    // Hammer a v3 path well beyond max — all should succeed.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${url}/api/discovery/v3/tier/alpha`);
      assert.equal(res.status, 200, `iteration ${i} should not be rate-limited`);
      const body = await res.json();
      assert.equal(body.success, true);
    }
  } finally {
    await close();
  }
});

test('non-v3 and v3 counters are independent — v3 traffic does not burn the global quota', async () => {
  const { url, close } = await listen(buildApp());
  try {
    // 10 v3 requests first.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${url}/api/discovery/v3/tier/alpha`);
      assert.equal(res.status, 200);
    }
    // Non-v3 quota (max=2) must still be intact.
    const r1 = await fetch(`${url}/api/trades`);
    const r2 = await fetch(`${url}/api/trades`);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
  } finally {
    await close();
  }
});
