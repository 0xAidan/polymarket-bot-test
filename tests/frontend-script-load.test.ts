import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const publicDir = join(process.cwd(), 'public', 'js');

const loadScriptsInOrder = () => {
  const sandbox: Record<string, unknown> = {
    window: {},
    document: {
      body: { classList: { remove: () => {}, add: () => {}, contains: () => false }, className: 'app-loading' },
      addEventListener: () => {},
      removeEventListener: () => {},
      getElementById: (id: string) => (id === 'taskbarClock' ? { textContent: '' } : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({ required: false }) }),
    sessionStorage: { getItem: () => null, setItem: () => {} },
    location: { href: 'http://localhost/', pathname: '/', search: '', reload: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const scripts = [
    'api.js',
    'jungleDialog.js',
    'auth-bootstrap.js',
    'shell.js',
    'jungleAgents.js',
    'app.js',
    'onboarding-steps.js',
    'onboarding.js',
  ];

  for (const file of scripts) {
    const code = readFileSync(join(publicDir, file), 'utf8');
    vm.runInNewContext(code, sandbox, { filename: file });
  }

  return sandbox.window as {
    switchTab?: (...args: unknown[]) => unknown;
    startOnboarding?: (...args: unknown[]) => unknown;
    DITTO_ONBOARDING_STEPS?: Array<Record<string, unknown>>;
  };
};

test('dashboard scripts load together and expose switchTab', () => {
  const win = loadScriptsInOrder();
  assert.equal(typeof win.switchTab, 'function');
});

test('onboarding tutorial loads, exposes startOnboarding, and defines 8 valid steps', () => {
  const win = loadScriptsInOrder();
  assert.equal(typeof win.startOnboarding, 'function');
  const steps = win.DITTO_ONBOARDING_STEPS || [];
  assert.equal(steps.length, 8);
  const ids = new Set<string>();
  for (const step of steps) {
    assert.equal(typeof step.id, 'string');
    assert.ok(!ids.has(step.id as string), `duplicate step id: ${step.id}`);
    ids.add(step.id as string);
    assert.equal(typeof step.title, 'string');
    assert.ok(Array.isArray(step.actions) && (step.actions as unknown[]).length > 0);
    for (const action of step.actions as unknown[]) {
      assert.equal(typeof action, 'string');
    }
  }
});
