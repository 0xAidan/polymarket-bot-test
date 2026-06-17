import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { config } from '../src/config.js';
import {
  loadAgents,
  createAgent,
  updateAgent,
  reorderAgents,
  bulkUpdateAddresses,
  bulkUpdateAgents,
  migrateOlympicsConfigToJungleStore,
  validateOlympicsProfileUrl,
  validatePolymarketAddress,
  __dangerousReplaceAgentsForTests,
  seedJungleAgentsIfMissing,
} from '../src/jungleAgentsStore.js';
import { createJungleAgentsRoutes } from '../src/api/jungleAgentsRoutes.js';
import { createOlympicsRoutes } from '../src/api/olympicsRoutes.js';
import { requirePlatformAdmin } from '../src/middleware/requirePlatformAdmin.js';
import { Storage } from '../src/storage.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createJungleAgentsRoutes({
    getPolymarketApi: () => ({
      getPolymarketProfilePortfolio: async () => ({
        portfolioValueUsd: 1000,
        positionCount: 3,
        proxyWallet: null,
        source: 'polymarket_value_api' as const,
      }),
    }) as any,
  }));
  return app;
};

const listen = async (app: express.Express) => {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe('jungleAgentsStore', () => {
  let savedDataDir: string;
  let tempDir: string;

  beforeEach(() => {
    savedDataDir = config.dataDir;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jungle-agents-'));
    (config as { dataDir: string }).dataDir = tempDir;
  });

  afterEach(() => {
    (config as { dataDir: string }).dataDir = savedDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeds nine agents on first boot', async () => {
    await seedJungleAgentsIfMissing();
    const agents = await loadAgents();
    assert.equal(agents.length, 9);
    assert.ok(agents.every((a) => a.enabled));
  });

  it('validates Olympics URL hostname', () => {
    assert.equal(validateOlympicsProfileUrl('https://olympics.jungle.win/agents#foo'), true);
    assert.equal(validateOlympicsProfileUrl('https://evil.example/agents'), false);
  });

  it('validates optional EVM addresses', () => {
    assert.equal(validatePolymarketAddress(''), true);
    assert.equal(validatePolymarketAddress(`0x${'a'.repeat(40)}`), true);
    assert.equal(validatePolymarketAddress('0x123'), false);
  });

  it('persists create/update/reorder roundtrip', async () => {
    await seedJungleAgentsIfMissing();
    const created = await createAgent({
      displayName: 'Test Agent',
      polymarketAddress: `0x${'1'.repeat(40)}`,
      olympicsProfileUrl: 'https://olympics.jungle.win/agents#test',
      sortOrder: 99,
      enabled: true,
    });
    const updated = await updateAgent(created.id, { tagline: 'Updated tagline' });
    assert.equal(updated.tagline, 'Updated tagline');

    const ids = (await loadAgents()).map((a) => a.id);
    const reversed = [...ids].reverse();
    const reordered = await reorderAgents(reversed);
    assert.equal(reordered[0].id, reversed[0]);
  });

  it('persists category and collection with validation', async () => {
    await seedJungleAgentsIfMissing();
    const created = await createAgent({
      displayName: 'Curated Agent',
      olympicsProfileUrl: 'https://olympics.jungle.win/agents#curated',
      category: 'sports',
      collection: 'MLB Opening Week',
      enabled: true,
    });
    assert.equal(created.category, 'sports');
    assert.equal(created.collection, 'MLB Opening Week');

    // Update normalizes case and trims (API delivers raw strings, hence the casts)
    const updated = await updateAgent(created.id, { category: ' Politics ', collection: '  Election Desk  ' } as any);
    assert.equal(updated.category, 'politics');
    assert.equal(updated.collection, 'Election Desk');

    // Clearing with empty strings removes the values
    const cleared = await updateAgent(created.id, { category: '', collection: '' } as any);
    assert.equal(cleared.category, undefined);
    assert.equal(cleared.collection, undefined);

    // Unknown category rejected
    await assert.rejects(
      () => updateAgent(created.id, { category: 'astrology' } as any),
      /Invalid category/i
    );

    // Over-long collection rejected
    await assert.rejects(
      () => updateAgent(created.id, { collection: 'x'.repeat(61) }),
      /collection too long/i
    );
  });

  it('rejects duplicate enabled Polymarket addresses', async () => {
    await seedJungleAgentsIfMissing();
    const addr = `0x${'2'.repeat(40)}`;
    await createAgent({
      displayName: 'Dup Test A',
      polymarketAddress: addr,
      olympicsProfileUrl: 'https://olympics.jungle.win/agents#dup-a',
      enabled: true,
    });
    await assert.rejects(
      () =>
        createAgent({
          displayName: 'Dup Test B',
          polymarketAddress: addr,
          olympicsProfileUrl: 'https://olympics.jungle.win/agents#dup-b',
          enabled: true,
        }),
      /already uses this Polymarket address/i
    );
  });

  it('bulk updates agents in a single save', async () => {
    await seedJungleAgentsIfMissing();
    const agents = await loadAgents();
    const a = agents[0];
    const b = agents[1];
    const addrA = `0x${'a'.repeat(40)}`;
    await bulkUpdateAgents([
      { id: a.id, polymarketAddress: addrA },
      { id: b.id, tagline: 'Bulk tagline' },
    ]);
    const after = await loadAgents();
    assert.equal(after.find((x) => x.id === a.id)?.polymarketAddress, addrA);
    assert.equal(after.find((x) => x.id === b.id)?.tagline, 'Bulk tagline');
  });

  it('bulk updates addresses with validation', async () => {
    await seedJungleAgentsIfMissing();
    const agents = await loadAgents();
    const target = agents[0];
    const addr = `0x${'3'.repeat(40)}`;
    const updated = await bulkUpdateAddresses([{ id: target.id, polymarketAddress: addr }]);
    const found = updated.find((a) => a.id === target.id);
    assert.equal(found?.polymarketAddress, addr);
    await assert.rejects(
      () => bulkUpdateAddresses([{ id: target.id, polymarketAddress: '0xbad' }]),
      /Invalid polymarketAddress/i
    );
  });

  it('migrates legacy olympics config without overwriting existing jungle addresses', async () => {
    await seedJungleAgentsIfMissing();
    const agents = await loadAgents();
    const howler = agents.find((a) => a.slug === 'howler-monkey-herald' || a.displayName === 'Howler Monkey Herald');
    assert.ok(howler);
    const existing = `0x${'4'.repeat(40)}`;
    await updateAgent(howler!.id, { polymarketAddress: existing });

    const cfg = await Storage.loadConfig();
    cfg.olympicsAgents = [
      { id: 'howler-monkey-herald', displayName: 'Howler Monkey Herald', walletAddress: `0x${'5'.repeat(40)}` },
      { id: 'king', displayName: 'KING', walletAddress: `0x${'6'.repeat(40)}` },
    ];
    await Storage.saveConfig(cfg);

    const result = await migrateOlympicsConfigToJungleStore();
    assert.equal(result.conflicts, 1);
    assert.equal(result.merged, 1);

    const after = await loadAgents();
    const howlerAfter = after.find((a) => a.id === howler!.id);
    const kingAfter = after.find((a) => a.slug === 'king' || a.displayName === 'KING');
    assert.equal(howlerAfter?.polymarketAddress, existing);
    assert.equal(kingAfter?.polymarketAddress, `0x${'6'.repeat(40)}`);
  });
});

describe('jungleAgentsRoutes', () => {
  let savedDataDir: string;
  let savedSecret: string;
  let savedAuthMode: string;
  let tempDir: string;

  beforeEach(async () => {
    savedDataDir = config.dataDir;
    savedSecret = config.apiSecret;
    savedAuthMode = config.authMode;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jungle-agents-api-'));
    (config as { dataDir: string }).dataDir = tempDir;
    (config as { authMode: 'legacy' | 'oidc' }).authMode = 'legacy';
    (config as { apiSecret: string }).apiSecret = 'admin-secret';
    const filePath = path.join(tempDir, 'jungle_agents.json');
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await seedJungleAgentsIfMissing();
  });

  afterEach(() => {
    (config as { dataDir: string }).dataDir = savedDataDir;
    (config as { apiSecret: string }).apiSecret = savedSecret;
    (config as { authMode: 'legacy' | 'oidc' }).authMode = savedAuthMode as 'legacy' | 'oidc';
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists only enabled agents on public endpoint', async () => {
    const agents = await loadAgents();
    await __dangerousReplaceAgentsForTests([
      { ...agents[0], enabled: false },
      ...agents.slice(1),
    ]);

    const app = makeApp();
    const { baseUrl, close } = await listen(app);
    const res = await fetch(`${baseUrl}/api/jungle-agents`);
    const body = await res.json();
    await close();
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.agents.length, agents.length - 1);
  });

  it('returns 403 for admin routes without platform admin', async () => {
    const app = express();
    app.use(express.json());
    app.get('/api/admin/jungle-agents', requirePlatformAdmin, (_req, res) => {
      res.json({ success: true });
    });

    const { baseUrl, close } = await listen(app);
    const res = await fetch(`${baseUrl}/api/admin/jungle-agents`);
    const body = await res.json();
    await close();
    assert.equal(res.status, 403);
    assert.match(body.error, /Platform admin/i);
  });

  it('allows admin routes with matching API_SECRET bearer', async () => {
    const app = makeApp();
    const { baseUrl, close } = await listen(app);
    const res = await fetch(`${baseUrl}/api/admin/jungle-agents`, {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    const body = await res.json();
    await close();
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.agents));
  });

  it('returns 403 for admin write routes without platform admin', async () => {
    const app = makeApp();
    const { baseUrl, close } = await listen(app);
    const agents = await loadAgents();
    const agentId = agents[0].id;
    const cases: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'POST', path: '/api/admin/jungle-agents', body: { displayName: 'X', olympicsProfileUrl: 'https://olympics.jungle.win/agents' } },
      { method: 'PATCH', path: `/api/admin/jungle-agents/${agentId}`, body: { tagline: 'nope' } },
      { method: 'DELETE', path: `/api/admin/jungle-agents/${agentId}` },
      { method: 'POST', path: '/api/admin/jungle-agents/reorder', body: { orderedIds: [agentId] } },
      { method: 'POST', path: '/api/admin/jungle-agents/bulk-addresses', body: { updates: [{ id: agentId, polymarketAddress: `0x${'7'.repeat(40)}` }] } },
    ];
    for (const c of cases) {
      const res = await fetch(`${baseUrl}${c.path}`, {
        method: c.method,
        headers: { 'Content-Type': 'application/json' },
        body: c.body ? JSON.stringify(c.body) : undefined,
      });
      const body = await res.json();
      assert.equal(res.status, 403, `${c.method} ${c.path}`);
      assert.match(body.error, /Platform admin/i);
    }
    await close();
  });

  it('PATCH rejects invalid address and accepts valid address for admin', async () => {
    const app = makeApp();
    const { baseUrl, close } = await listen(app);
    const agents = await loadAgents();
    const agentId = agents[0].id;
    const auth = { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' };

    const bad = await fetch(`${baseUrl}/api/admin/jungle-agents/${agentId}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ polymarketAddress: '0x123' }),
    });
    const badBody = await bad.json();
    assert.equal(bad.status, 400);
    assert.match(badBody.error, /Invalid polymarketAddress/i);

    const goodAddr = `0x${'8'.repeat(40)}`;
    const good = await fetch(`${baseUrl}/api/admin/jungle-agents/${agentId}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ polymarketAddress: goodAddr }),
    });
    const goodBody = await good.json();
    assert.equal(good.status, 200);
    assert.equal(goodBody.agent.polymarketAddress, goodAddr);
    await close();
  });
});

describe('olympicsRoutes', () => {
  let savedDataDir: string;
  let tempDir: string;

  beforeEach(async () => {
    savedDataDir = config.dataDir;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'olympics-api-'));
    (config as { dataDir: string }).dataDir = tempDir;
    await seedJungleAgentsIfMissing();
  });

  afterEach(() => {
    (config as { dataDir: string }).dataDir = savedDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('GET reads roster from jungle store', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/olympics', createOlympicsRoutes());
    const { baseUrl, close } = await listen(app);
    const res = await fetch(`${baseUrl}/api/olympics/agents`);
    const body = await res.json();
    await close();
    assert.equal(res.status, 200);
    assert.equal(body.agents.length, 9);
    assert.ok(body.agents[0].id);
  });

  it('PUT is blocked for non-admin clients', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/olympics', createOlympicsRoutes());
    const { baseUrl, close } = await listen(app);
    const res = await fetch(`${baseUrl}/api/olympics/agents`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents: [] }),
    });
    const body = await res.json();
    await close();
    assert.equal(res.status, 403);
    assert.match(body.error, /platform-admin/i);
  });
});
