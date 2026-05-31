import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import { requireAuthForMutations } from '../src/api/discoveryRoutesV3.js';

/**
 * Contract test for the public-read / auth-gated-write split that fixes the
 * "HTTP 401: Authentication required" crash on staging.ditto.jungle.win.
 *
 * Invariants under test:
 *   1. GET /tier/:tier, /health, /cutover-status, /wallet/:address, /compare
 *      return 200 to an anonymous visitor (no Auth0 session).
 *   2. POST /track, /watchlist, /dismiss and DELETE /watchlist/:addr return
 *      401 JSON with `loginUrl` to an anonymous visitor.
 *   3. The same mutation routes return 200 when `req.oidc.isAuthenticated()`
 *      is true.
 */

// Mock the feature-flag env var so the router actually mounts.
process.env.DISCOVERY_V3 = 'true';

async function buildAppAnon(): Promise<express.Express> {
  const { createDiscoveryV3Router } = await import('../src/api/discoveryRoutesV3.js');
  const app = express();
  app.use(express.json());
  // No OIDC middleware — simulating an anonymous visitor on a server that
  // has OIDC disabled (equivalent req.oidc absent).
  app.use(
    '/api/discovery/v3',
    createDiscoveryV3Router({
      getDb: () => ({
        prepare: () => ({
          all: () => [],
          get: () => ({ c: 0 }),
        }),
      }) as any,
    })
  );
  return app;
}

async function buildAppWithOidc(authed: boolean): Promise<express.Express> {
  const { createDiscoveryV3Router } = await import('../src/api/discoveryRoutesV3.js');
  const app = express();
  app.use(express.json());
  // Fake express-openid-connect: attach req.oidc with a stubbed auth check.
  app.use((req, _res, next) => {
    (req as any).oidc = { isAuthenticated: () => authed, user: authed ? { sub: 'x' } : undefined };
    next();
  });
  app.use(
    '/api/discovery/v3',
    createDiscoveryV3Router({
      getDb: () => ({
        prepare: () => ({
          all: () => [],
          get: () => ({ c: 0 }),
        }),
      }) as any,
    })
  );
  return app;
}

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('read endpoints are public — anonymous GETs return 200 JSON', async () => {
  const app = await buildAppAnon();
  const { url, close } = await listen(app);
  try {
    for (const p of [
      '/api/discovery/v3/tier/alpha',
      '/api/discovery/v3/health',
      '/api/discovery/v3/cutover-status',
      '/api/discovery/v3/compare?addresses=0x1111111111111111111111111111111111111111',
    ]) {
      const res = await fetch(`${url}${p}`);
      assert.equal(res.status, 200, `${p} should be public but got ${res.status}`);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, true, `${p} should return success:true`);
    }
  } finally {
    await close();
  }
});

test('mutation endpoints reject anonymous OIDC requests with 401 JSON + loginUrl', async () => {
  const app = await buildAppWithOidc(false);
  const { url, close } = await listen(app);
  try {
    const cases: Array<[string, RequestInit]> = [
      ['/api/discovery/v3/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }) }],
      ['/api/discovery/v3/watchlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: '0x2222222222222222222222222222222222222222' }) }],
      ['/api/discovery/v3/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: '0x3333333333333333333333333333333333333333' }) }],
      ['/api/discovery/v3/watchlist/0x4444444444444444444444444444444444444444', { method: 'DELETE' }],
    ];
    for (const [p, init] of cases) {
      const res = await fetch(`${url}${p}`, init);
      assert.equal(res.status, 401, `${p} should be gated but got ${res.status}`);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.error, 'Authentication required');
      assert.equal(body.loginUrl, '/auth/login');
    }
  } finally {
    await close();
  }
});

test('mutation endpoints succeed when req.oidc.isAuthenticated() is true', async () => {
  const app = await buildAppWithOidc(true);
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/discovery/v3/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.action, 'track');
  } finally {
    await close();
  }
});

test('requireAuthForMutations lets requests through when req.oidc is absent (legacy/dev)', async () => {
  const app = express();
  app.use(express.json());
  app.post('/test', requireAuthForMutations, (_req, res) => res.json({ success: true }));
  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/test`, { method: 'POST' });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});
