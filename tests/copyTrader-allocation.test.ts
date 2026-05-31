import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAllocationGate } from '../src/copyTrader.ts';

test('evaluateAllocationGate blocks discovery-tagged wallets without allocation state', () => {
  const gate = evaluateAllocationGate(['discovery'], null);

  assert.equal(gate.allowed, false);
  assert.match(gate.reason || '', /no allocation policy state/i);
});

test('evaluateAllocationGate allows manual wallets without allocation state at neutral weight', () => {
  const gate = evaluateAllocationGate([], null);

  assert.equal(gate.allowed, true);
  assert.equal(gate.weight, 1);
});

test('evaluateAllocationGate blocks paused wallets', () => {
  const gate = evaluateAllocationGate(['discovery'], {
    state: 'PAUSED',
    targetWeight: 0,
    pauseReason: 'Trust deteriorated',
  });

  assert.equal(gate.allowed, false);
  assert.match(gate.reason || '', /Trust deteriorated/);
});

test('evaluateAllocationGate clamps active allocation weight into safe bounds', () => {
  const gate = evaluateAllocationGate(['discovery'], {
    state: 'HOT_STREAK',
    targetWeight: 3.4,
  });

  assert.equal(gate.allowed, true);
  assert.equal(gate.weight, 2);
});
