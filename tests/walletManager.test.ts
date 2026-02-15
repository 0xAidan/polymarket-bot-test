import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { config } from '../src/config.js';
import { lockAllWallets } from '../src/secureKeyManager.js';
import {
  initWalletManager,
  addTradingWallet,
  removeTradingWallet,
  toggleTradingWallet,
  updateTradingWalletLabel,
  getTradingWallets,
  getActiveTradingWallets,
  addCopyAssignment,
  removeCopyAssignment,
  getCopyAssignments,
  getAssignmentsForTrackedWallet,
} from '../src/walletManager.js';

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

let tempDir: string;

describe('WalletManager', () => {
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'wm-test-'));
    (config as any).dataDir = tempDir;
    (config as any).storageBackend = 'json';
    lockAllWallets();
    await initWalletManager();
  });

  afterEach(() => {
    lockAllWallets();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('trading wallet CRUD', () => {
    it('addTradingWallet creates and returns wallet', async () => {
      const wallet = await addTradingWallet('main', 'Main Wallet', TEST_KEY, 'pass');
      assert.equal(wallet.id, 'main');
      assert.equal(wallet.label, 'Main Wallet');
      assert.equal(wallet.address, TEST_ADDR);
      assert.equal(wallet.isActive, true);
    });

    it('addTradingWallet rejects duplicate ID', async () => {
      await addTradingWallet('dup', 'Dup', TEST_KEY, 'pass');
      await assert.rejects(
        () => addTradingWallet('dup', 'Dup2', TEST_KEY, 'pass'),
        /already exists/
      );
    });

    it('getTradingWallets returns all wallets', async () => {
      await addTradingWallet('w1', 'W1', TEST_KEY, 'pass');
      const wallets = getTradingWallets();
      assert.equal(wallets.length, 1);
      assert.equal(wallets[0].id, 'w1');
    });

    it('removeTradingWallet removes wallet and its assignments', async () => {
      await addTradingWallet('rm', 'RM', TEST_KEY, 'pass');
      await addCopyAssignment('0xabc', 'rm');
      assert.equal(getCopyAssignments().length, 1);

      await removeTradingWallet('rm');
      assert.equal(getTradingWallets().length, 0);
      assert.equal(getCopyAssignments().length, 0);
    });

    it('toggleTradingWallet flips active state', async () => {
      await addTradingWallet('tg', 'Toggle', TEST_KEY, 'pass');
      assert.equal(getTradingWallets()[0].isActive, true);

      await toggleTradingWallet('tg');
      assert.equal(getTradingWallets()[0].isActive, false);

      await toggleTradingWallet('tg', true);
      assert.equal(getTradingWallets()[0].isActive, true);
    });

    it('updateTradingWalletLabel changes label', async () => {
      await addTradingWallet('lb', 'Old', TEST_KEY, 'pass');
      const updated = await updateTradingWalletLabel('lb', 'New Label');
      assert.equal(updated.label, 'New Label');
    });

    it('getActiveTradingWallets filters inactive', async () => {
      await addTradingWallet('a1', 'Active', TEST_KEY, 'pass');
      assert.equal(getActiveTradingWallets().length, 1);

      await toggleTradingWallet('a1', false);
      assert.equal(getActiveTradingWallets().length, 0);
    });
  });

  describe('copy assignments', () => {
    beforeEach(async () => {
      await addTradingWallet('w1', 'W1', TEST_KEY, 'pass');
    });

    it('addCopyAssignment creates assignment', async () => {
      const assignment = await addCopyAssignment('0xTracked1', 'w1', false);
      assert.equal(assignment.trackedWalletAddress, '0xtracked1');
      assert.equal(assignment.tradingWalletId, 'w1');
      assert.equal(assignment.useOwnConfig, false);
    });

    it('addCopyAssignment rejects duplicate', async () => {
      await addCopyAssignment('0xTracked1', 'w1');
      await assert.rejects(
        () => addCopyAssignment('0xTracked1', 'w1'),
        /already exists/
      );
    });

    it('addCopyAssignment rejects nonexistent trading wallet', async () => {
      await assert.rejects(
        () => addCopyAssignment('0x1', 'nonexistent'),
        /not found/
      );
    });

    it('removeCopyAssignment removes assignment', async () => {
      await addCopyAssignment('0xTracked1', 'w1');
      assert.equal(getCopyAssignments().length, 1);

      await removeCopyAssignment('0xTracked1', 'w1');
      assert.equal(getCopyAssignments().length, 0);
    });

    it('removeCopyAssignment throws for nonexistent', async () => {
      await assert.rejects(
        () => removeCopyAssignment('0xGhost', 'w1'),
        /not found/
      );
    });

    it('getAssignmentsForTrackedWallet filters correctly', async () => {
      await addCopyAssignment('0xA', 'w1');
      await addCopyAssignment('0xB', 'w1');

      const forA = getAssignmentsForTrackedWallet('0xA');
      assert.equal(forA.length, 1);
      assert.equal(forA[0].tradingWalletAddress || forA[0].trackedWalletAddress, '0xa');
    });
  });
});
