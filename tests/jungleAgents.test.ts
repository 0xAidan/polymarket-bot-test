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
  validateOlympicsProfileUrl,
  validatePolymarketAddress,
  __dangerousReplaceAgentsForTests,
  seedJungleAgentsIfMissing,
} from '../src/jungleAgentsStore.js';
import { createJungleAgentsRoutes } from '../src/api/jungleAgentsRoutes.js';
import { requirePlatformAdmin } from '../src/middleware/requirePlatformAdmin.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createJungleAgentsRoutes({
    getPolymarketApi: () => ({
      getPortfolioValue: async () => ({
        totalValue: 1000,
        usdcBalance: 500,
        positionsValue: 500,
        positionCount: 3,
        proxyWallet: null,
        positions: [],
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
});
