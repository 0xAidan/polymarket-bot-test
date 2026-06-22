import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase, closeDatabase, getDatabase } from '../src/database.js';
import { purgeAllHostedAccounts } from '../src/authAccountPurge.js';
import { config } from '../src/config.js';

describe('authAccountPurge', () => {
  let tempDir = '';
  let originalDataDir = config.dataDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-purge-'));
    config.dataDir = tempDir;
    await initDatabase();

    const db = getDatabase();
    const now = Date.now();
    db.prepare(`
      INSERT INTO app_tenants (id, slug, name, created_at_ms, updated_at_ms)
      VALUES ('tenant_test', 'test-workspace', 'Test Workspace', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO app_users (id, oidc_subject, email, display_name, last_active_tenant_id, created_at_ms, updated_at_ms)
      VALUES ('user_test', 'auth0|abc', 'user@example.com', 'User', 'tenant_test', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO app_tenant_memberships (user_id, tenant_id, role, created_at_ms)
      VALUES ('user_test', 'tenant_test', 'owner', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO tracked_wallets (tenant_id, address, added_at, active)
      VALUES ('tenant_test', '0xabc123', ?, 1)
    `).run(new Date().toISOString());

    await fs.mkdir(path.join(tempDir, 'keystores', 'tenant_test'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'keystores', 'tenant_test', 'wallet.keystore.json'), '{}');
    await fs.writeFile(path.join(tempDir, 'balance_history_tenant_test.json'), '[]');
  });

  afterEach(async () => {
    closeDatabase();
    config.dataDir = originalDataDir;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('removes all users, tenants, and tenant-scoped files', async () => {
    const result = await purgeAllHostedAccounts();
    assert.equal(result.usersRemoved, 1);
    assert.equal(result.tenantsRemoved, 1);
    assert.equal(result.trackedWalletsRemoved, 1);

    const db = getDatabase();
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM app_users').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM app_tenants').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM tracked_wallets').get() as { count: number }).count, 0);

    await assert.rejects(() => fs.stat(path.join(tempDir, 'keystores', 'tenant_test')));
    await assert.rejects(() => fs.stat(path.join(tempDir, 'balance_history_tenant_test.json')));
  });
});
