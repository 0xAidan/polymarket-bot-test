import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../src/config.js';
import {
  seedJungleAgentsIfMissing,
  loadAgents,
  updateAgent,
} from '../src/jungleAgentsStore.js';
import { syncMissingAgentAddressesFromPolymarket } from '../src/jungleAgentsPolymarketSync.js';

describe('jungleAgentsPolymarketSync', () => {
  let savedDataDir: string;
  let tempDir: string;

  beforeEach(async () => {
    savedDataDir = config.dataDir;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jungle-sync-'));
    (config as { dataDir: string }).dataDir = tempDir;
    await seedJungleAgentsIfMissing();
  });

  afterEach(() => {
    (config as { dataDir: string }).dataDir = savedDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips agents that already have addresses', async () => {
    const agents = await loadAgents();
    let i = 0;
    for (const agent of agents) {
      const hex = (i + 1).toString(16).padStart(40, '0');
      await updateAgent(agent.id, { polymarketAddress: `0x${hex}` });
      i++;
    }
    const result = await syncMissingAgentAddressesFromPolymarket();
    assert.equal(result.synced, 0);
    assert.equal(result.skipped, agents.length);
  });
});
