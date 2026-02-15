import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { config } from '../src/config.js';
import {
  addEncryptedWallet,
  removeEncryptedWallet,
  unlockAllWallets,
  getSigner,
  getWalletAddress,
  isWalletUnlocked,
  getUnlockedWalletIds,
  listStoredWalletIds,
  lockAllWallets,
} from '../src/secureKeyManager.js';

// Test private key (DO NOT use in production — this is a well-known test key)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

let tempDir: string;

describe('SecureKeyManager', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'keys-test-'));
    (config as any).dataDir = tempDir;
    lockAllWallets();
  });

  afterEach(() => {
    lockAllWallets();
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
});
