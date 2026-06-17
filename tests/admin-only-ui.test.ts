import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const publicDir = join(process.cwd(), 'public');

test('admin-only nav tabs are hidden by default in CSS', () => {
  const css = readFileSync(join(publicDir, 'styles.css'), 'utf8');
  assert.match(css, /\.j-nav-btn\[data-tab="platforms"\]/);
  assert.match(css, /body\.platform-admin \.j-nav-btn\[data-tab="platforms"\]/);
  assert.match(css, /\.j-nav-btn\[data-tab="discovery"\]/);
  assert.match(css, /body\.platform-admin \.j-nav-btn\[data-tab="discovery"\]/);
});

test('index marks in-progress tools as admin-only', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /data-tab="platforms"[^>]*data-admin-only/);
  assert.match(html, /data-tab="cross-platform"[^>]*data-admin-only/);
  assert.match(html, /data-tab="discovery"[^>]*data-admin-only/);
  assert.match(html, /data-tour="ladder-exits"[^>]*data-admin-only/);
  assert.match(html, /JUNGLE AGENTS/);
  assert.doesNotMatch(html, /auth-gate-eyebrow">JUNGLE DAO/);
});

test('auth bootstrap toggles platform-admin body class', () => {
  const js = readFileSync(join(publicDir, 'js', 'auth-bootstrap.js'), 'utf8');
  assert.match(js, /classList\.toggle\('platform-admin'/);
  assert.match(js, /window\.refreshPlatformAdminUi/);
});
