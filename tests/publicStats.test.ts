import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import { createPublicStatsRouter } from '../src/api/publicStatsRoutes.js';

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('GET /api/public/stats is public and returns agent count', async () => {
  const app = express();
  app.use(
    '/api',
    createPublicStatsRouter({
      getDb: () =>
        ({
          prepare: () => ({
            get: () => ({ c: 0 }),
            all: () => [],
          }),
        }) as any,
    })
  );

  const { url, close } = await listen(app);
  try {
    const res = await fetch(`${url}/api/public/stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.agents, 'number');
    assert.ok('walletsScored' in body);
  } finally {
    await close();
  }
});
