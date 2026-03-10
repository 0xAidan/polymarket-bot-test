import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertTradeCanExecuteForWallet,
  hasExplicitTradeSizingConfig,
} from '../src/walletConfigSafety.js';
import { DetectedTrade, TrackedWallet } from '../src/types.js';

describe('walletConfigSafety', () => {
  it('treats a wallet without explicit sizing as unsafe', () => {
    const wallet: TrackedWallet = {
      address: '0xunsafe',
      addedAt: new Date(),
      active: true,
    };

    assert.equal(hasExplicitTradeSizingConfig(wallet), false);
  });

  it('treats fixed sizing with a positive amount as safe', () => {
    const wallet: TrackedWallet = {
      address: '0xsafe',
      addedAt: new Date(),
      active: true,
      tradeSizingMode: 'fixed',
      fixedTradeSize: 19,
    };

    assert.equal(hasExplicitTradeSizingConfig(wallet), true);
  });

  it('treats proportional sizing as safe without a fixed amount', () => {
    const wallet: TrackedWallet = {
      address: '0xproportional',
      addedAt: new Date(),
      active: true,
      tradeSizingMode: 'proportional',
    };

    assert.equal(hasExplicitTradeSizingConfig(wallet), true);
  });

  it('treats fixed sizing without a positive amount as unsafe', () => {
    const wallet: TrackedWallet = {
      address: '0xinvalidfixed',
      addedAt: new Date(),
      active: true,
      tradeSizingMode: 'fixed',
    };

    assert.equal(hasExplicitTradeSizingConfig(wallet), false);
  });

  it('blocks execution for a detected trade without explicit wallet sizing', () => {
    const trade: DetectedTrade = {
      walletAddress: '0xunsafe',
      marketId: 'market-1',
      outcome: 'YES',
      amount: '100',
      price: '0.48',
      side: 'BUY',
      timestamp: new Date(),
      transactionHash: 'tx-1',
    };

    assert.throws(
      () => assertTradeCanExecuteForWallet(trade),
      /explicit trade sizing/i
    );
  });
});
