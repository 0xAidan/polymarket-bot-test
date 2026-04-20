import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import { runV3SqliteMigrations } from '../src/discovery/v3/schema.ts';
import { createDiscoveryV3Router } from '../src/api/discoveryRoutesV3.ts';

function seedDb(): Database.Database {
  const db = new Database(':memory:');
  runV3SqliteMigrations(db);
  const ins = db.prepare(
    `INSERT INTO discovery_wallet_scores_v3
       (proxy_wallet, tier, tier_rank, score, volume_total, trade_count,
        distinct_markets, closed_positions, realized_pnl, hit_rate,
        last_active_ts, reasons_json, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  ins.run('0xaaaa', 'alpha', 1, 0.95, 1000000, 500, 80, 200, 5000, 0.61, 1700000000, '["high edge","breadth"]', 1700000100);
  ins.run('0xbbbb', 'whale', 1, 0.90, 5000000, 100, 40, 50, 20000, 0.55, 1700000000, '["large volume"]', 1700000100);
  ins.run('0xcccc', 'specialist', 1, 0.88, 200000, 80, 10, 40, 3000, 0.70, 1700000000, '["niche focus"]', 1700000100);
  db.prepare(
    'INSERT INTO pipeline_cursor (pipeline, last_block, last_ts_unix, updated_at) VALUES (?,?,?,?)'
  ).run('goldsky', 1234, 1700000000, 1700000100);
  return db;
}

function buildApp(db: Database.Database) {
  const app = express();
  app.use(express.json());
  app.use('/api/discovery/v3', createDiscoveryV3Router({ getDb: () => db }));
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

async function req(url: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

test('v3 API — all endpoints return 404 when DISCOVERY_V3 flag is off', async () => {
  const prev = process.env.DISCOVERY_V3;
  process.env.DISCOVERY_V3 = 'false';
  try {
    const db = seedDb();
    const { url, close } = await listen(buildApp(db));
    try {
      const paths = [
        ['GET', '/tier/alpha'],
        ['GET', '/wallet/0xaaaa'],
        ['GET', '/compare?addresses=0xaaaa,0xbbbb'],
        ['GET', '/health'],
        ['POST', '/watchlist'],
        ['DELETE', '/watchlist/0xaaaa'],
        ['POST', '/dismiss'],
        ['POST', '/track'],
        ['GET', '/cutover-status'],
      ] as const;
      for (const [method, p] of paths) {
        const r = await req(`${url}/api/discovery/v3${p}`, method, method === 'POST' ? { address: '0x' + 'a'.repeat(40) } : undefined);
        assert.equal(r.status, 404, `${method} ${p} should 404 when flag off`);
      }
    } finally {
      await close();
      db.close();
    }
  } finally {
    if (prev === undefined) delete process.env.DISCOVERY_V3;
    else process.env.DISCOVERY_V3 = prev;
  }
});

test('v3 API — endpoints return 200 with proper shape when flag on', async () => {
  const prev = process.env.DISCOVERY_V3;
  process.env.DISCOVERY_V3 = 'true';
  try {
    const db = seedDb();
    const { url, close } = await listen(buildApp(db));
    try {
      // GET /tier/:tier
      const tier = await req(`${url}/api/discovery/v3/tier/alpha`);
      assert.equal(tier.status, 200);
      assert.equal(tier.json.success, true);
      assert.equal(tier.json.tier, 'alpha');
      assert.ok(Array.isArray(tier.json.data));
      assert.equal(tier.json.data.length, 1);
      const row = tier.json.data[0];
      for (const field of ['address', 'alias', 'tier', 'tierRank', 'score', 'volumeTotal', 'tradeCount', 'distinctMarkets', 'closedPositions', 'realizedPnl', 'hitRate', 'lastActiveTs', 'reasons', 'updatedAt']) {
        assert.ok(field in row, `missing field: ${field}`);
      }
      assert.ok(Array.isArray(row.reasons));

      // invalid tier → 400
      const bad = await req(`${url}/api/discovery/v3/tier/bogus`);
      assert.equal(bad.status, 400);

      // GET /wallet/:address
      const wallet = await req(`${url}/api/discovery/v3/wallet/0xAAAA`);
      assert.equal(wallet.status, 200);
      assert.equal(wallet.json.success, true);
      assert.equal(wallet.json.address, '0xaaaa');
      assert.ok(Array.isArray(wallet.json.tiers));
      assert.equal(wallet.json.tiers.length, 1);

      // 404 for unknown wallet
      const missing = await req(`${url}/api/discovery/v3/wallet/0xdeadbeef`);
      assert.equal(missing.status, 404);

      // GET /compare
      const cmp = await req(`${url}/api/discovery/v3/compare?addresses=0xaaaa,0xbbbb`);
      assert.equal(cmp.status, 200);
      assert.equal(cmp.json.data.length, 2);

      // GET /health
      const health = await req(`${url}/api/discovery/v3/health`);
      assert.equal(health.status, 200);
      assert.equal(health.json.success, true);
      assert.equal(health.json.flag, true);
      assert.ok(health.json.tierCounts);

      // POST /watchlist (valid)
      const wl = await req(`${url}/api/discovery/v3/watchlist`, 'POST', { address: '0x' + 'a'.repeat(40) });
      assert.equal(wl.status, 200);
      assert.equal(wl.json.action, 'watch');

      // POST /watchlist (invalid address) → 400
      const wlBad = await req(`${url}/api/discovery/v3/watchlist`, 'POST', { address: 'nope' });
      assert.equal(wlBad.status, 400);

      // DELETE /watchlist/:addr
      const wlDel = await req(`${url}/api/discovery/v3/watchlist/0xAAAA`, 'DELETE');
      assert.equal(wlDel.status, 200);
      assert.equal(wlDel.json.action, 'unwatch');

      // POST /dismiss
      const dis = await req(`${url}/api/discovery/v3/dismiss`, 'POST', { address: '0xaaaa', until: 1800000000 });
      assert.equal(dis.status, 200);
      assert.equal(dis.json.until, 1800000000);

      // POST /track
      const trk = await req(`${url}/api/discovery/v3/track`, 'POST', { address: '0xaaaa' });
      assert.equal(trk.status, 200);
      assert.equal(trk.json.action, 'track');

      // GET /cutover-status
      const cut = await req(`${url}/api/discovery/v3/cutover-status`);
      assert.equal(cut.status, 200);
      assert.equal(cut.json.success, true);
      assert.ok(typeof cut.json.totalScoreRows === 'number');
      assert.ok(cut.json.tierCounts);
    } finally {
      await close();
      db.close();
    }
  } finally {
    if (prev === undefined) delete process.env.DISCOVERY_V3;
    else process.env.DISCOVERY_V3 = prev;
  }
});
