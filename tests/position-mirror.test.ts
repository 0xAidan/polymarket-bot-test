import test from 'node:test';
import assert from 'node:assert/strict';

import { PositionMirror } from '../src/positionMirror.ts';

test('calculateMirrorPreview ignores placeholder funder addresses and falls back to a resolved proxy wallet', async () => {
  const placeholderFunder = '0x_your_proxy_wallet_address_here';
  const resolvedProxy = '0x999900000000000000000000000000000000abcd';
  const trackedWallet = '0x111100000000000000000000000000000000abcd';

  const requestedUsers: string[] = [];
  const polymarketApi = {
    async getUserPositions(address: string) {
      requestedUsers.push(address);
      if (address === placeholderFunder) {
        throw new Error('Request failed with status code 400');
      }
      if (address === trackedWallet) {
        return [];
      }
      if (address === resolvedProxy) {
        return [];
      }
      throw new Error(`Unexpected positions lookup for ${address}`);
    },
    async getPortfolioValue(address: string) {
      assert.equal(address, trackedWallet);
      return { totalValue: 0 };
    },
    async getProxyWalletAddress(address: string) {
      assert.equal(address, '0x222200000000000000000000000000000000abcd');
      return resolvedProxy;
    },
  };

  const clobClient = {
    getWalletAddress() {
      return '0x222200000000000000000000000000000000abcd';
    },
    getFunderAddress() {
      return placeholderFunder;
    },
    async getUsdcBalance() {
      return 100;
    },
  };

  const mirror = new PositionMirror(polymarketApi as any, clobClient as any);
  const preview = await mirror.calculateMirrorPreview(trackedWallet, 10);

  assert.deepEqual(requestedUsers, [trackedWallet, resolvedProxy]);
  assert.equal(preview.yourUsdcBalance, 100);
  assert.equal(preview.theirPortfolioValue, 0);
  assert.deepEqual(preview.trades, []);
});

test('calculateMirrorPreview keeps tiny target positions visible as skipped rows', async () => {
  const trackedWallet = '0x111100000000000000000000000000000000abcd';
  const userWallet = '0x222200000000000000000000000000000000abcd';

  const polymarketApi = {
    async getUserPositions(address: string) {
      if (address === trackedWallet) {
        return [
          {
            asset: 'asset-yes',
            conditionId: 'condition-1',
            size: 1000,
            avgPrice: 0.5,
            curPrice: 0.8,
            title: 'Will example event happen?',
            outcome: 'Yes',
            redeemable: false,
            negativeRisk: false,
          },
        ];
      }

      if (address === userWallet) {
        return [];
      }

      throw new Error(`Unexpected positions lookup for ${address}`);
    },
    async getPortfolioValue(address: string) {
      assert.equal(address, trackedWallet);
      return { totalValue: 800 };
    },
    async getProxyWalletAddress(address: string) {
      assert.equal(address, userWallet);
      return null;
    },
  };

  const clobClient = {
    getWalletAddress() {
      return userWallet;
    },
    getFunderAddress() {
      return null;
    },
    async getUsdcBalance() {
      return 0.01;
    },
  };

  const mirror = new PositionMirror(polymarketApi as any, clobClient as any);
  const preview = await mirror.calculateMirrorPreview(trackedWallet, 10);

  assert.equal(preview.trades.length, 1);
  assert.equal(preview.trades[0]?.status, 'skipped');
  assert.match(preview.trades[0]?.warning || '', /too small|minimum order size/i);
  assert.equal(preview.trades[0]?.marketTitle, 'Will example event happen?');
});
