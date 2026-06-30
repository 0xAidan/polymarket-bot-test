import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const publicDir = join(process.cwd(), 'public');
const rootDir = process.cwd();

test('jungle-ops-auth handles OIDC session and /admin returnTo', () => {
  const js = readFileSync(join(publicDir, 'js', 'jungle-ops-auth.js'), 'utf8');
  assert.match(js, /\/api\/auth\/me/);
  assert.match(js, /sanitizeReturnTo/);
  assert.match(js, /__adminBoot/);
  assert.match(js, /waitForAdminBoot/);
  assert.match(js, /window\.__authRequired = true/);
});

test('jungle-ops-panel boot uses session platform-admin flag before capabilities fetch', () => {
  const adminJs = readFileSync(join(publicDir, 'js', 'jungle-ops-panel.js'), 'utf8');
  assert.match(adminJs, /window\.__isPlatformAdmin/);
  assert.match(adminJs, /isPlatformAdmin !== true/);
  assert.match(adminJs, /__adminScriptsLoaded\.jungleOpsPanel/);
  assert.match(adminJs, /window\.__adminBoot = bootAdmin/);
  assert.match(adminJs, /ensureAnalyticsBundle/);
  assert.doesNotMatch(adminJs, /DOMContentLoaded/);
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

test('admin index uses jungle-ops scripts and lazy analytics loading', () => {
  const html = readFileSync(join(publicDir, 'admin', 'index.html'), 'utf8');
  assert.match(html, /jungle-ops-panel\.js/);
  assert.match(html, /jungle-ops-auth\.js/);
  assert.match(html, /__failAdminScript/);
  assert.doesNotMatch(html, /auth-bootstrap\.js/);
  assert.doesNotMatch(html, /platform-admin/);
  assert.doesNotMatch(html, /uplot\.min\.js/);
});

test('admin scripts load in isolated script contexts without global const collisions', () => {
  const window: Record<string, unknown> = {
    __authRequired: true,
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
  runScript('js/jungle-ops-panel.js');

  assert.equal(typeof window.__adminBoot, 'function');
  const loaded = window.__adminScriptsLoaded as Record<string, boolean> | undefined;
  assert.equal(loaded?.jungleOpsPanel, true);
});
