import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  getRuntimeServicesForMode,
  resolveRuntimeMode,
} from '../src/runtimeMode.js';
import {
  clearDiscoveryRuntimeHeartbeat,
  loadDiscoveryRuntimeHeartbeat,
  saveDiscoveryRuntimeHeartbeat,
} from '../src/discovery/discoveryRuntimeState.js';

test('resolveRuntimeMode defaults to the main app runtime', () => {
  assert.equal(resolveRuntimeMode(undefined, []), 'app');
});

test('resolveRuntimeMode supports an explicit discovery worker flag', () => {
  assert.equal(resolveRuntimeMode(undefined, ['--discovery-worker']), 'discovery-worker');
});

test('getRuntimeServicesForMode disables inline discovery for the main app runtime', () => {
  assert.deepEqual(getRuntimeServicesForMode('app'), {
    server: true,
    trader: true,
    discoveryWorker: false,
  });
});

test('getRuntimeServicesForMode enables only the discovery worker runtime', () => {
  assert.deepEqual(getRuntimeServicesForMode('discovery-worker'), {
    server: false,
    trader: false,
    discoveryWorker: true,
  });
});

test('discovery runtime heartbeat round-trips through the shared state file', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'discovery-runtime-'));

  try {
    const heartbeat = {
      mode: 'discovery-worker' as const,
      pid: 12345,
      running: true,
      startedAt: 1710000000000,
      lastHeartbeatAt: 1710000005000,
    };

    saveDiscoveryRuntimeHeartbeat(tempDir, heartbeat);

    assert.deepEqual(loadDiscoveryRuntimeHeartbeat(tempDir), heartbeat);

    clearDiscoveryRuntimeHeartbeat(tempDir);

    assert.equal(loadDiscoveryRuntimeHeartbeat(tempDir), null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
