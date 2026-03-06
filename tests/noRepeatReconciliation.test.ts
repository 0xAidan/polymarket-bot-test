import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decidePendingOrderReconciliation } from '../src/noRepeatReconciliation.js';

describe('decidePendingOrderReconciliation', () => {
  it('keeps the block when the order is still open', () => {
    const decision = decidePendingOrderReconciliation({
      pendingOrderId: 'order-1',
      openOrderIds: new Set(['order-1']),
      currentPositionSize: 0,
      baselinePositionSize: 0,
      tradeSide: 'BUY'
    });

    assert.equal(decision, 'still_open');
  });

  it('marks the block executed only when position size increased', () => {
    const decision = decidePendingOrderReconciliation({
      pendingOrderId: 'order-2',
      openOrderIds: new Set(),
      currentPositionSize: 17,
      baselinePositionSize: 12,
      missingOrderChecks: 0,
      tradeSide: 'BUY'
    });

    assert.equal(decision, 'executed');
  });

  it('keeps the block when the order disappears only once without new position growth', () => {
    const decision = decidePendingOrderReconciliation({
      pendingOrderId: 'order-3',
      openOrderIds: new Set(),
      currentPositionSize: 12,
      baselinePositionSize: 12,
      missingOrderChecks: 0,
      tradeSide: 'BUY'
    });

    assert.equal(decision, 'await_more_evidence');
  });

  it('clears the block after repeated missing order snapshots with no new position growth', () => {
    const decision = decidePendingOrderReconciliation({
      pendingOrderId: 'order-4',
      openOrderIds: new Set(),
      currentPositionSize: 12,
      baselinePositionSize: 12,
      missingOrderChecks: 1,
      tradeSide: 'BUY'
    });

    assert.equal(decision, 'clear_pending');
  });

  it('marks pending sell orders executed when position size drops', () => {
    const decision = decidePendingOrderReconciliation({
      pendingOrderId: 'order-5',
      openOrderIds: new Set(),
      currentPositionSize: 6,
      baselinePositionSize: 10,
      missingOrderChecks: 0,
      tradeSide: 'SELL'
    });

    assert.equal(decision, 'executed');
  });
});
