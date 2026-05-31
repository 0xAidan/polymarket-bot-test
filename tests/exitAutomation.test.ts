import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { LadderExitManager } from '../src/ladderExitManager.js';
import { SmartStopLossManager } from '../src/smartStopLoss.js';

describe('exit automation logic', () => {
  let savedAuthMode: string;
  let savedStorage: string;

  beforeEach(() => {
    savedAuthMode = config.authMode;
    savedStorage = config.storageBackend;
    (config as any).authMode = 'legacy';
    (config as any).storageBackend = 'json';
  });

  afterEach(() => {
    (config as any).authMode = savedAuthMode;
    (config as any).storageBackend = savedStorage;
  });

  it('ladder exits trigger only when price reaches configured step', () => {
    const manager = new LadderExitManager();
    const ladder = manager.createLadder(
      'token-1',
      'condition-1',
      'Example market',
      'YES',
      0.50,
      100,
      [{ triggerPrice: 0.60, sellPercent: 25 }]
    );

    const belowTrigger = manager.checkLadders(new Map([[ladder.tokenId, 0.59]]));
    assert.equal(belowTrigger.length, 0);

    const atTrigger = manager.checkLadders(new Map([[ladder.tokenId, 0.60]]));
    assert.equal(atTrigger.length, 1);
    assert.equal(atTrigger[0].ladder.id, ladder.id);
    assert.equal(atTrigger[0].sharesToSell, 25);
  });

  it('stop-loss updates trailing floor and triggers once price falls through it', () => {
    const manager = new SmartStopLossManager();
    const order = manager.createStopLoss(
      'token-2',
      'condition-2',
      'Stop-loss market',
      'NO',
      0.50,
      40,
      { initialStopPrice: 0.40, trailingPercent: 10, profitLockThreshold: 0.20 }
    );

    const notTriggered = manager.updatePrices(new Map([[order.tokenId, 0.70]]));
    assert.equal(notTriggered.length, 0);

    const updatedOrder = manager.getOrder(order.id);
    assert.ok(updatedOrder);
    assert.equal(updatedOrder.currentStopPrice, 0.63);

    const triggered = manager.updatePrices(new Map([[order.tokenId, 0.62]]));
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].id, order.id);
    assert.equal(triggered[0].isActive, false);
  });
});
