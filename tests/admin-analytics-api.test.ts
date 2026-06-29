import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { initDatabase, getDatabase } from '../src/database.js';
import { createAdminAnalyticsRouter } from '../src/api/adminAnalyticsRoutes.js';
import { resetPlatformAdminEmailCache } from '../src/platformAdmin.js';

let tempDir: string;
let savedEmails: string;

const listen = async (app: express.Express) => {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const bootApp = (isAdmin: boolean) => {
  const app = express();
  app.use((req, _res, next) => {
    if (isAdmin) {
      (req as any).oidc = { isAuthenticated: () => true, user: { email: 'admin@example.com' } };
    } else {
      (req as any).oidc = { isAuthenticated: () => true, user: { email: 'user@example.com' } };
    }
    next();
  });
  app.use(createAdminAnalyticsRouter());
  return app;
};

describe('admin analytics API', () => {
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'admin-analytics-api-'));
    mkdirSync(join(tempDir, 'keystores', 'tenant_test'), { recursive: true });
    (config as { dataDir: string }).dataDir = tempDir;
    (config as { storageBackend: 'json' | 'sqlite' }).storageBackend = 'sqlite';
    (config as { authMode: 'legacy' | 'oidc' }).authMode = 'oidc';

    savedEmails = config.platformAdminEmails;
    (config as { platformAdminEmails: string }).platformAdminEmails = 'admin@example.com';
    resetPlatformAdminEmailCache();

    await initDatabase();
    const db = getDatabase();

    db.prepare(`
      INSERT INTO app_tenants (id, slug, name, created_at_ms, updated_at_ms)
      VALUES ('tenant_test', 'test-workspace', 'Test Workspace', ?, ?)
    `).run(Date.now(), Date.now());

    db.prepare(`
      INSERT INTO app_users (id, oidc_subject, email, display_name, last_active_tenant_id, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'sub-1', 'owner@example.com', 'Owner', 'tenant_test', ?, ?)
    `).run(Date.now(), Date.now());

    db.prepare(`
      INSERT INTO app_tenant_memberships (user_id, tenant_id, role, created_at_ms)
      VALUES ('user-1', 'tenant_test', 'owner', ?)
    `).run(Date.now());

    db.prepare(`
      INSERT INTO bot_config (tenant_id, key, value) VALUES (?, ?, ?)
    `).run(
      'tenant_test',
      'tradingWallets',
      JSON.stringify([{
        id: 'main',
        label: 'Main Wallet',
        address: '0x1111111111111111111111111111111111111111',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        hasCredentials: true,
        polymarketBuilderCode: 'NEVER_EXPOSE',
      }]),
    );

    writeFileSync(
      join(tempDir, 'trade_metrics_tenant_test.json'),
      JSON.stringify([
        {
          id: 'trade-1',
          timestamp: new Date().toISOString(),
          walletAddress: '0x2222222222222222222222222222222222222222',
          marketId: 'market-1',
          marketTitle: 'Test Market',
          outcome: 'YES',
          amount: '10',
          price: '0.4',
          success: true,
          status: 'executed',
          executionTimeMs: 100,
          detectedTxHash: '0xabc',
        },
      ]),
    );
  });

  afterEach(() => {
    (config as { platformAdminEmails: string }).platformAdminEmails = savedEmails;
    resetPlatformAdminEmailCache();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns 403 for non-platform-admin', async () => {
    const app = bootApp(false);
    const { baseUrl, close } = await listen(app);
    const res = await fetch(`${baseUrl}/admin/analytics/overview?range=7d`);
    const body = await res.json();
    await close();
    assert.equal(res.status, 403);
    assert.match(body.error, /Platform admin/i);
  });

  it('returns overview for platform admin without forbidden fields', async () => {
    const app = bootApp(true);
    const { baseUrl, close } = await listen(app);
    const res = await fetch(`${baseUrl}/admin/analytics/overview?range=all`);
    const body = await res.json();
    await close();
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    const raw = JSON.stringify(body);
    assert.equal(raw.includes('polymarketBuilderCode'), false);
    assert.equal(raw.includes('apiSecret'), false);
    assert.equal(raw.includes('NEVER_EXPOSE'), false);
  });

  it('lists tenants with email and id', async () => {
    const app = bootApp(true);
    const { baseUrl, close } = await listen(app);
    const res = await fetch(`${baseUrl}/admin/analytics/tenants?range=all`);
    const body = await res.json();
    await close();
    assert.equal(res.status, 200);
    assert.equal(body.tenants.length, 1);
    assert.equal(body.tenants[0].ownerEmail, 'owner@example.com');
    assert.equal(body.tenants[0].tenantId, 'tenant_test');
  });

  it('paginates tenant trades', async () => {
    const app = bootApp(true);
    const { baseUrl, close } = await listen(app);
    const res = await fetch(`${baseUrl}/admin/analytics/tenants/tenant_test/trades?page=1&limit=10&range=all`);
    const body = await res.json();
    await close();
    assert.equal(res.status, 200);
    assert.equal(body.trades.length, 1);
    assert.equal(body.trades[0].marketTitle, 'Test Market');
  });

  it('exports per-tenant csv with allowlisted headers only', async () => {
    const app = bootApp(true);
    const { baseUrl, close } = await listen(app);
    const res = await fetch(`${baseUrl}/admin/analytics/tenants/tenant_test/trades/export.csv?range=all`);
    const text = await res.text();
    await close();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    const lines = text.trim().split('\n');
    assert.match(lines[0], /timestamp,tenant_id/);
    assert.equal(text.includes('polymarketBuilderCode'), false);
  });
});
