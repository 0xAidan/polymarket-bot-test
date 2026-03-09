import test from 'node:test';
import assert from 'node:assert/strict';

test('startDiscoveryWorker initializes the database and starts the manager explicitly', async () => {
  const calls: string[] = [];
  const { closeDatabase } = await import('../src/database.js');
  closeDatabase();

  const fakeManager = {
    async start() {
      calls.push('start');
    },
  };

  const { startDiscoveryWorker } = await import('../src/discovery/discoveryWorker.js');
  const startedManager = await startDiscoveryWorker(fakeManager as any);

  assert.equal(startedManager, fakeManager);
  assert.deepEqual(calls, ['start']);
});
