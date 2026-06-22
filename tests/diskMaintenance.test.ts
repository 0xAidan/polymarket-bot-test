import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  pruneBackupDirectory,
  pruneEnvBackupFiles,
  removeStaleBackupDirectories,
} from '../src/diskMaintenance.js';

describe('diskMaintenance', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'disk-maint-'));
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('removes stale backup directories but keeps active data dir', async () => {
    const activeDataDir = path.join(tempRoot, 'data');
    await fs.mkdir(activeDataDir, { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'data.bak-on-root'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'data.bak-on-root', 'old.db'), 'stale');
    await fs.mkdir(path.join(tempRoot, 'data.backup-20260101'), { recursive: true });

    const removed = await removeStaleBackupDirectories(tempRoot, activeDataDir);
    assert.equal(removed, 2);
    assert.equal(await fs.stat(activeDataDir).then(() => true), true);
    await assert.rejects(() => fs.stat(path.join(tempRoot, 'data.bak-on-root')));
  });

  it('prunes old backup files by retention days', async () => {
    const backupDir = path.join(tempRoot, 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const oldFile = path.join(backupDir, 'copytrade-old.db');
    const newFile = path.join(backupDir, 'copytrade-new.db');
    await fs.writeFile(oldFile, 'old');
    await fs.writeFile(newFile, 'new');
    const oldTime = new Date(Date.now() - 30 * 86400 * 1000);
    await fs.utimes(oldFile, oldTime, oldTime);

    const removed = await pruneBackupDirectory(backupDir, 14);
    assert.equal(removed, 1);
    await assert.rejects(() => fs.stat(oldFile));
    assert.equal(await fs.stat(newFile).then(() => true), true);
  });

  it('removes .env.backup files from app root', async () => {
    await fs.writeFile(path.join(tempRoot, '.env.backup-old'), 'SECRET=old');
    await fs.writeFile(path.join(tempRoot, '.env'), 'SECRET=live');

    const removed = await pruneEnvBackupFiles(tempRoot);
    assert.equal(removed, 1);
    await assert.rejects(() => fs.stat(path.join(tempRoot, '.env.backup-old')));
    assert.equal(await fs.stat(path.join(tempRoot, '.env')).then(() => true), true);
  });
});
