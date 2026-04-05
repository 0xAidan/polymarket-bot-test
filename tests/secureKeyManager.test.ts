import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { config } from '../src/config.js';
import { runWithTenant } from '../src/tenantContext.js';
import {
  addEncryptedWallet,
  removeEncryptedWallet,
  unlockAllWallets,
  getSigner,
  getWalletAddress,
  getBuilderCredentials,
  isWalletUnlocked,
  getUnlockedWalletIds,
  listStoredWalletIds,
  lockAllWallets,
  migrateEnvPrivateKey,
} from '../src/secureKeyManager.js';

// Test private key (DO NOT use in production — this is a well-known test key)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

let tempDir: string;

describe('SecureKeyManager', () => {
  let savedAuthMode: string;
  let savedStorage: string;
  let savedPrivateKey: string | undefined;
  let savedAuthSessionSecret: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'keys-test-'));
    (config as any).dataDir = tempDir;
    savedAuthMode = config.authMode;
    savedStorage = config.storageBackend;
    savedPrivateKey = config.privateKey;
    savedAuthSessionSecret = config.authSessionSecret;
    (config as any).authMode = 'legacy';
    (config as any).storageBackend = 'json';
    lockAllWallets();
  });

  afterEach(() => {
    lockAllWallets();
    (config as any).authMode = savedAuthMode;
    (config as any).storageBackend = savedStorage;
    (config as any).privateKey = savedPrivateKey;
    (config as any).authSessionSecret = savedAuthSessionSecret;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('addEncryptedWallet stores and returns correct address', async () => {
    const address = await addEncryptedWallet('test-wallet', TEST_PRIVATE_KEY, 'mypassword');
    assert.equal(address, TEST_ADDRESS);

    // Verify file was created
    const ids = await listStoredWalletIds();
    assert.ok(ids.includes('test-wallet'));
  });

  it('addEncryptedWallet rejects duplicate wallet IDs', async () => {
    await addEncryptedWallet('dup-wallet', TEST_PRIVATE_KEY, 'pass');
    await assert.rejects(
      () => addEncryptedWallet('dup-wallet', TEST_PRIVATE_KEY, 'pass'),
      /already exists/
    );
  });

  it('addEncryptedWallet rejects invalid private keys', async () => {
    await assert.rejects(
      () => addEncryptedWallet('bad', 'not-a-key', 'pass'),
      /Invalid private key/
    );
  });

  it('unlockAllWallets decrypts stored wallets', async () => {
    await addEncryptedWallet('w1', TEST_PRIVATE_KEY, 'secret');
    lockAllWallets();
    assert.equal(isWalletUnlocked(), false);

    const ids = await unlockAllWallets('secret');
    assert.equal(ids.length, 1);
    assert.ok(ids.includes('w1'));
    assert.equal(isWalletUnlocked(), true);
  });

  it('unlockAllWallets fails with wrong password', async () => {
    await addEncryptedWallet('w2', TEST_PRIVATE_KEY, 'correct');
    lockAllWallets();

    await assert.rejects(
      () => unlockAllWallets('wrong'),
      /Failed to decrypt/
    );
  });

  it('getSigner returns correct ethers.Wallet after unlock', async () => {
    await addEncryptedWallet('signer-test', TEST_PRIVATE_KEY, 'pw');
    const signer = getSigner('signer-test');
    assert.equal(signer.address, TEST_ADDRESS);
  });

  it('getSigner throws when wallet is not unlocked', () => {
    assert.throws(
      () => getSigner('nonexistent'),
      /not found or not unlocked/
    );
  });

  it('getWalletAddress returns address', async () => {
    await addEncryptedWallet('addr-test', TEST_PRIVATE_KEY, 'pw');
    const addr = getWalletAddress('addr-test');
    assert.equal(addr, TEST_ADDRESS);
  });

  it('removeEncryptedWallet deletes keystore file', async () => {
    await addEncryptedWallet('removable', TEST_PRIVATE_KEY, 'pw');
    let ids = await listStoredWalletIds();
    assert.ok(ids.includes('removable'));

    await removeEncryptedWallet('removable');
    ids = await listStoredWalletIds();
    assert.ok(!ids.includes('removable'));
  });

  it('removeEncryptedWallet throws for nonexistent wallet', async () => {
    await assert.rejects(
      () => removeEncryptedWallet('ghost'),
      /not found/
    );
  });

  it('lockAllWallets clears memory', async () => {
    await addEncryptedWallet('lock-test', TEST_PRIVATE_KEY, 'pw');
    assert.equal(getUnlockedWalletIds().length, 1);

    lockAllWallets();
    assert.equal(getUnlockedWalletIds().length, 0);
    assert.equal(isWalletUnlocked(), false);
  });

  it('listStoredWalletIds lists without decrypting', async () => {
    await addEncryptedWallet('a', TEST_PRIVATE_KEY, 'pw');
    lockAllWallets();

    const ids = await listStoredWalletIds();
    assert.ok(ids.includes('a'));
    assert.equal(isWalletUnlocked(), false);
  });

  it('isolates keystore files by tenant context', async () => {
    await runWithTenant('tenant-a', () => addEncryptedWallet('main', TEST_PRIVATE_KEY, 'pw'));
    await runWithTenant('tenant-b', () => addEncryptedWallet('main', TEST_PRIVATE_KEY, 'pw'));

    const tenantAIds = await runWithTenant('tenant-a', () => listStoredWalletIds());
    const tenantBIds = await runWithTenant('tenant-b', () => listStoredWalletIds());

    assert.deepEqual(tenantAIds, ['main']);
    assert.deepEqual(tenantBIds, ['main']);
  });

  it('migrateEnvPrivateKey does nothing in hosted multi-tenant mode', async () => {
    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'sqlite';
    (config as any).privateKey = TEST_PRIVATE_KEY;

    const migrated = await migrateEnvPrivateKey('secret');
    assert.equal(migrated, null);

    const ids = await runWithTenant('tenant-hosted', () => listStoredWalletIds());
    assert.deepEqual(ids, []);
  });

  it('migrateEnvPrivateKey imports .env private key as main in legacy mode', async () => {
    (config as any).authMode = 'legacy';
    (config as any).storageBackend = 'json';
    (config as any).privateKey = TEST_PRIVATE_KEY;

    const addr = await migrateEnvPrivateKey('secret');
    assert.equal(addr, TEST_ADDRESS);

    const ids = await listStoredWalletIds();
    assert.ok(ids.includes('main'));
  });

  it('hosted multitenant wallets auto-load from disk without a master password', async () => {
    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'sqlite';
    (config as any).authSessionSecret = 'hosted-session-secret';

    await runWithTenant('tenant-a', async () => {
      await addEncryptedWallet('main', TEST_PRIVATE_KEY, undefined, {
        apiKey: 'builder-key',
        apiSecret: 'builder-secret',
        apiPassphrase: 'builder-passphrase',
      });

      lockAllWallets();

      const signer = getSigner('main');
      const builderCreds = getBuilderCredentials('main');

      assert.equal(signer.address, TEST_ADDRESS);
      assert.deepEqual(builderCreds, {
        apiKey: 'builder-key',
        apiSecret: 'builder-secret',
        apiPassphrase: 'builder-passphrase',
      });
      assert.equal(isWalletUnlocked(), true);
    });
  });
});
