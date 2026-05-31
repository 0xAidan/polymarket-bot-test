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
      body: { classList: { remove: () => {}, add: () => {} }, className: 'app-loading' },
      addEventListener: () => {},
      getElementById: (id: string) => (id === 'taskbarClock' ? { textContent: '' } : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
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
  ];

  for (const file of scripts) {
    const code = readFileSync(join(publicDir, file), 'utf8');
    vm.runInNewContext(code, sandbox, { filename: file });
  }

  return sandbox.window as { switchTab?: (...args: unknown[]) => unknown };
};

test('dashboard scripts load together and expose switchTab', () => {
  const win = loadScriptsInOrder();
  assert.equal(typeof win.switchTab, 'function');
});
