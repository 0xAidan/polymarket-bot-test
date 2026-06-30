import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const publicDir = join(process.cwd(), 'public');
const rootDir = process.cwd();

test('platform-admin-auth handles OIDC session and /admin returnTo', () => {
  const js = readFileSync(join(publicDir, 'js', 'platform-admin-auth.js'), 'utf8');
  assert.match(js, /\/api\/auth\/me/);
  assert.match(js, /sanitizeReturnTo/);
  assert.match(js, /__adminBoot/);
  assert.match(js, /__isPlatformAdmin/);
  assert.doesNotMatch(js, /maybeStartApp/);
});

test('platform-admin boot uses session platform-admin flag before capabilities fetch', () => {
  const adminJs = readFileSync(join(publicDir, 'js', 'platform-admin.js'), 'utf8');
  assert.match(adminJs, /window\.__isPlatformAdmin/);
  assert.match(adminJs, /isPlatformAdmin !== true/);
  assert.match(adminJs, /__adminScriptsLoaded\.platformAdmin/);
  assert.match(adminJs, /window\.__adminBoot = bootAdmin/);
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

test('admin index uses platform-admin scripts and not auth-bootstrap', () => {
  const html = readFileSync(join(publicDir, 'admin', 'index.html'), 'utf8');
  assert.match(html, /platform-admin\.js/);
  assert.match(html, /platform-admin-analytics\.js/);
  assert.match(html, /platform-admin-auth\.js/);
  assert.match(html, /__failAdminScript/);
  assert.doesNotMatch(html, /auth-bootstrap\.js/);
  assert.doesNotMatch(html, /\/admin\/admin\.js/);
});

test('admin scripts load in isolated script contexts without global const collisions', () => {
  const window: Record<string, unknown> = {
    __adminScriptLoads: {},
    __markAdminScript: (name: string) => { window.__adminScriptLoads[name] = 'ok'; },
  };

  const sharedDocument = {
    body: {
      classList: { remove: () => {}, add: () => {}, toggle: () => {}, contains: () => false },
      className: 'app-loading',
    },
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const runScript = (filename: string) => {
    const context: Record<string, unknown> = {
      window,
      globalThis: window,
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      AbortController: globalThis.AbortController,
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      fetch: async () => ({ ok: true, json: async () => ({ required: false }) }),
      location: { pathname: '/admin', search: '', hash: '', replace: () => {} },
      navigator: { clipboard: { writeText: async () => {} } },
      document: sharedDocument,
      uPlot: function UPlot() {},
    };
    const code = readFileSync(join(publicDir, filename), 'utf8');
    vm.runInNewContext(code, context, { filename });
  };

  runScript('js/sanitizeReturnTo.js');
  runScript('js/escapeHtml.js');
  runScript('js/api-core.js');
  runScript('js/api.js');
  runScript('js/jungleDialog.js');
  runScript('js/jungleAgentIcons.js');
  runScript('js/platform-admin-analytics.js');
  runScript('js/platform-admin.js');

  assert.equal(typeof window.__adminBoot, 'function');
  const loaded = window.__adminScriptsLoaded as Record<string, boolean> | undefined;
  assert.equal(loaded?.platformAdmin, true);
  assert.equal(loaded?.platformAdminAnalytics, true);
});
