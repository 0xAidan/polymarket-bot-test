import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const publicDir = join(process.cwd(), 'public');
const rootDir = process.cwd();

test('auth-bootstrap handles admin page auth failures and returnTo', () => {
  const js = readFileSync(join(publicDir, 'js', 'auth-bootstrap.js'), 'utf8');
  assert.match(js, /isAdminPage/);
  assert.match(js, /getAuthReturnTo/);
  assert.match(js, /showAdminAuthGate/);
  assert.match(js, /sanitizeReturnTo/);
  assert.doesNotMatch(js, /encodeURIComponent\('\/app'\)/);
});

test('admin boot uses session platform-admin flag before capabilities fetch', () => {
  const adminJs = readFileSync(join(publicDir, 'admin', 'admin.js'), 'utf8');
  assert.match(adminJs, /window\.__isPlatformAdmin/);
  assert.match(adminJs, /isPlatformAdmin !== true/);
});

test('api.js 401 handler preserves admin returnTo', () => {
  const js = readFileSync(join(publicDir, 'js', 'api.js'), 'utf8');
  assert.match(js, /\/login\?returnTo=\$\{returnTo\}/);
  assert.match(js, /sanitizeReturnTo/);
  assert.match(js, /\/admin/);
});

test('login route honors returnTo when already authenticated', () => {
  const server = readFileSync(join(rootDir, 'src', 'server.ts'), 'utf8');
  assert.match(server, /isOidcAuthenticated\(req\)[\s\S]*sanitizeReturnTo\(req\.query\.returnTo/);
});

test('admin index loads auth helpers before auth-bootstrap', () => {
  const html = readFileSync(join(publicDir, 'admin', 'index.html'), 'utf8');
  const sanitizeIdx = html.indexOf('sanitizeReturnTo.js');
  const authIdx = html.indexOf('auth-bootstrap.js');
  assert.ok(sanitizeIdx > 0);
  assert.ok(authIdx > sanitizeIdx);
});
