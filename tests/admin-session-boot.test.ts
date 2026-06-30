import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const publicDir = join(process.cwd(), 'public');
const rootDir = process.cwd();
const ROSTER_PATH = '/app/roster';

test('roster editor bundles auth boot and sets __adminBoot', () => {
  const js = readFileSync(join(publicDir, 'js', 'roster-editor.js'), 'utf8');
  assert.match(js, /\/api\/auth\/me/);
  assert.match(js, /ROSTER_PANEL_PATH/);
  assert.match(js, /window\.__adminBoot = bootAdmin/);
  assert.match(js, /checkPlatformAdminAuth/);
  assert.doesNotMatch(js, /waitForAdminBoot/);
});

test('roster editor boot uses session platform-admin flag before capabilities fetch', () => {
  const adminJs = readFileSync(join(publicDir, 'js', 'roster-editor.js'), 'utf8');
  assert.match(adminJs, /window\.__isPlatformAdmin/);
  assert.match(adminJs, /isPlatformAdmin !== true/);
  assert.match(adminJs, /__adminScriptsLoaded\.rosterEditor/);
  assert.match(adminJs, /ensureAnalyticsBundle/);
});

test('api.js 401 handler preserves roster panel returnTo', () => {
  const js = readFileSync(join(publicDir, 'js', 'api.js'), 'utf8');
  assert.match(js, /\/login\?returnTo=\$\{returnTo\}/);
  assert.match(js, /\/app\/roster/);
});

test('server serves roster panel at /app/roster and redirects /admin', () => {
  const server = readFileSync(join(rootDir, 'src', 'server.ts'), 'utf8');
  assert.match(server, /app\.get\('\/app\/roster'/);
  assert.match(server, /redirect\(301, '\/app\/roster'\)/);
});

test('admin index uses roster-editor only (no separate auth script)', () => {
  const html = readFileSync(join(publicDir, 'admin', 'index.html'), 'utf8');
  assert.match(html, /roster-editor\.js/);
  assert.match(html, /\/app\/roster/);
  assert.match(html, /\/styles\/roster-panel\.css/);
  assert.doesNotMatch(html, /auth-bootstrap\.js/);
  assert.doesNotMatch(html, /roster-auth\.js/);
  assert.doesNotMatch(html, /uplot\.min\.js/);
});

test('admin scripts load in isolated script contexts without global const collisions', async () => {
  const window: Record<string, unknown> = {
    __authRequired: true,
    __adminScriptLoads: {},
    __markAdminScript: (name: string) => { window.__adminScriptLoads[name] = 'ok'; },
    location: { pathname: ROSTER_PATH, search: '', hash: '', replace: () => {} },
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
    createElement: () => ({
      classList: { add: () => {} },
      setAttribute: () => {},
      appendChild: () => {},
    }),
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
      location: { pathname: ROSTER_PATH, search: '', hash: '', replace: () => {} },
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
  runScript('js/roster-editor.js');

  assert.equal(typeof window.__adminBoot, 'function');
  const loaded = window.__adminScriptsLoaded as Record<string, boolean> | undefined;
  assert.equal(loaded?.rosterEditor, true);
  assert.equal((window.__adminScriptLoads as Record<string, string>)['roster-editor'], 'ok');

  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('roster panel nav switches to System Health after boot', async () => {
  const sectionVisibility: Record<string, boolean> = {
    adminLoading: true,
    adminApp: true,
    adminHealth: true,
    adminAnalytics: true,
    adminUnauthorized: true,
    adminComingSoon: true,
  };

  const makeSection = (id: string) => ({
    id,
    classList: {
      add: (cls: string) => {
        if (cls === 'hidden') sectionVisibility[id] = false;
      },
      remove: (cls: string) => {
        if (cls === 'hidden') sectionVisibility[id] = true;
      },
      contains: (cls: string) => (cls === 'hidden' ? !sectionVisibility[id] : false),
      toggle: () => {},
    },
    innerHTML: '',
    querySelector: () => null,
  });

  const navHandlers = new Map<string, (event?: { preventDefault: () => void }) => void>();
  const navElements = ['agents', 'health', 'analytics'].map((section) => ({
    tagName: section === 'agents' ? 'A' : 'BUTTON',
    getAttribute: (name: string) => (name === 'data-admin-nav' ? section : null),
    setAttribute: () => {},
    removeAttribute: () => {},
    classList: {
      toggle: () => {},
      add: () => {},
      remove: () => {},
      contains: () => false,
    },
    addEventListener: (_event: string, handler: (event?: { preventDefault: () => void }) => void) => {
      navHandlers.set(section, handler);
    },
    click: () => navHandlers.get(section)?.({ preventDefault: () => {} }),
  }));

  const elements: Record<string, ReturnType<typeof makeSection>> = {
    adminLoading: makeSection('adminLoading'),
    adminApp: makeSection('adminApp'),
    adminHealth: makeSection('adminHealth'),
    adminAnalytics: makeSection('adminAnalytics'),
    adminUnauthorized: makeSection('adminUnauthorized'),
    adminComingSoon: makeSection('adminComingSoon'),
  };

  const window: Record<string, unknown> = {
    __authRequired: true,
    __adminScriptLoads: {},
    __markAdminScript: (name: string) => { window.__adminScriptLoads[name] = 'ok'; },
    __isPlatformAdmin: true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController: globalThis.AbortController,
    fetch: async (input: string) => {
      const url = String(input);
      if (url.includes('/api/auth/required')) {
        return { ok: true, json: async () => ({ required: false }) };
      }
      if (url.includes('/api/admin/jungle-agents')) {
        return { ok: true, json: async () => ({ success: true, agents: [] }) };
      }
      if (url.includes('/api/admin/system-stats')) {
        return { ok: true, json: async () => ({ success: true, disk: {}, service: {} }) };
      }
      return { ok: true, json: async () => ({ success: true, isPlatformAdmin: true }) };
    },
    setTimeout,
    clearTimeout,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { pathname: ROSTER_PATH, search: '', hash: '', replace: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    document: {
      body: {
        classList: { remove: () => {}, add: () => {}, toggle: () => {}, contains: () => false },
        className: 'app-loading',
      },
      getElementById: (id: string) => elements[id] || null,
      querySelector: (sel: string) => {
        const match = sel.match(/data-admin-nav="([^"]+)"/);
        if (!match) return null;
        return navElements.find((el) => el.getAttribute('data-admin-nav') === match[1]) || null;
      },
      querySelectorAll: (sel: string) => {
        if (sel === '[data-admin-nav]') return navElements;
        return [];
      },
      addEventListener: () => {},
      createElement: () => ({
        classList: { add: () => {} },
        setAttribute: () => {},
        appendChild: () => {},
      }),
    },
    API: {
      getCapabilities: async () => ({ isPlatformAdmin: true }),
      getAdminJungleAgents: async () => ({ agents: [] }),
      getAdminSystemStats: async () => ({ disk: { status: 'ok' }, service: { status: 'ok' } }),
    },
    jungleDialog: { error: async () => {}, success: async () => {} },
    escapeHtml: (v: unknown) => String(v),
    sanitizeReturnTo: (path: string) => path,
  };

  const runScript = (filename: string) => {
    const code = readFileSync(join(publicDir, filename), 'utf8');
    vm.runInNewContext(code, { ...window, window, globalThis: window }, { filename });
  };

  runScript('js/roster-editor.js');

  assert.equal(typeof window.__adminBoot, 'function');
  await (window.__adminBoot as () => Promise<void>)();

  navHandlers.get('health')?.({ preventDefault: () => {} });
  assert.equal(sectionVisibility.adminHealth, true);
  assert.equal(sectionVisibility.adminApp, false);

  window.AdminAnalytics = { show: async () => { elements.adminAnalytics.classList.remove('hidden'); } };
  navHandlers.get('analytics')?.({ preventDefault: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sectionVisibility.adminAnalytics, true);
  assert.equal(sectionVisibility.adminHealth, false);
});
