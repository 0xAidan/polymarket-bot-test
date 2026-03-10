import test from 'node:test';
import assert from 'node:assert/strict';
import { startMonitoringServices } from '../src/startup.js';

test('startMonitoringServices starts copy trader only', async () => {
  const calls: string[] = [];

  await startMonitoringServices(
    {
      start: async () => {
        calls.push('copyTrader');
      },
    },
    {
      start: async () => {
        calls.push('discovery');
      },
    },
  );

  assert.deepEqual(calls, ['copyTrader']);
});

test('startMonitoringServices tolerates missing discovery manager', async () => {
  let copyTraderStarted = false;

  await startMonitoringServices(
    {
      start: async () => {
        copyTraderStarted = true;
      },
    },
    null,
  );

  assert.equal(copyTraderStarted, true);
});

test('startMonitoringServices reports discovery inline-start deprecation', async () => {
  let copyTraderStarted = false;
  let receivedError: unknown = null;

  await startMonitoringServices(
    {
      start: async () => {
        copyTraderStarted = true;
      },
    },
    {
      start: async () => {
        // Discovery no longer started from this path.
      },
    },
    (error) => {
      receivedError = error;
    },
  );

  assert.equal(copyTraderStarted, true);
  assert.equal(
    (receivedError as Error)?.message,
    'Discovery startup is managed by discovery worker process',
  );
});
