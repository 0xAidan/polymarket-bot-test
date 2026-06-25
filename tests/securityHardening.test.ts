import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { requireAuthForMutations } from '../src/api/discoveryRoutesV3.js';
import { config } from '../src/config.js';

const readSource = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8');

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('security hardening', () => {
  it('config.validate rejects legacy auth in production', () => {
    const source = readSource('src/config.ts');
    assert.match(source, /NODE_ENV === 'production'/);
    assert.match(source, /Production requires AUTH_MODE=oidc/);
    assert.match(source, /Production requires REQUIRE_API_SECRET=true/);
    assert.match(source, /Production requires CORS_ALLOWED_ORIGINS/);
  });

  it('server wires CORS allowlist from config', () => {
    const source = readSource('src/server.ts');
    assert.match(source, /config\.corsAllowedOrigins/);
    assert.doesNotMatch(source, /app\.use\(cors\(\)\)/);
  });

  it('server sanitizes returnTo on /login redirect', () => {
    const source = readSource('src/server.ts');
    assert.match(source, /sanitizeReturnTo/);
  });

  it('public client loads shared sanitizeReturnTo helper', () => {
    const landingHtml = readSource('public/landing.html');
    const indexHtml = readSource('public/index.html');
    assert.match(landingHtml, /sanitizeReturnTo\.js/);
    assert.match(indexHtml, /sanitizeReturnTo\.js/);
    assert.match(indexHtml, /escapeHtml\.js/);
  });

  it('Caddyfile includes report-only CSP', () => {
    const caddy = readSource('deploy/Caddyfile');
    assert.match(caddy, /Content-Security-Policy-Report-Only/);
  });
});

describe('requireAuthForMutations legacy gate', () => {
  let savedSecret: string;
  let savedRequire: boolean;

  beforeEach(() => {
    savedSecret = config.apiSecret;
    savedRequire = config.requireApiSecret;
  });

  afterEach(() => {
    (config as { apiSecret: string }).apiSecret = savedSecret;
    (config as { requireApiSecret: boolean }).requireApiSecret = savedRequire;
  });

  it('rejects unauthenticated mutations when API_SECRET is configured', async () => {
    (config as { apiSecret: string }).apiSecret = 'mutation-secret';
    (config as { requireApiSecret: boolean }).requireApiSecret = true;

    const app = express();
    app.use(express.json());
    app.post('/test', requireAuthForMutations, (_req, res) => res.json({ success: true }));
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/test`, { method: 'POST' });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.loginUrl, '/login');
    } finally {
      await close();
    }
  });

  it('allows mutations with matching bearer when OIDC is absent', async () => {
    (config as { apiSecret: string }).apiSecret = 'mutation-secret';
    const app = express();
    app.use(express.json());
    app.post('/test', requireAuthForMutations, (_req, res) => res.json({ success: true }));
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/test`, {
        method: 'POST',
        headers: { Authorization: 'Bearer mutation-secret' },
      });
      assert.equal(res.status, 200);
    } finally {
      await close();
    }
  });
});
