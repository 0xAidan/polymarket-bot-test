export type PendingOrderDecision = 'still_open' | 'executed' | 'await_more_evidence' | 'clear_pending';

export const decidePendingOrderReconciliation = ({
  pendingOrderId,
  openOrderIds,
  currentPositionSize,
  baselinePositionSize,
  missingOrderChecks,
  tradeSide,
}: {
  pendingOrderId?: string;
  openOrderIds: Set<string>;
  currentPositionSize: number | null;
  baselinePositionSize?: number;
  missingOrderChecks?: number;
  tradeSide: 'BUY' | 'SELL';
}): PendingOrderDecision => {
  const MAX_MISSING_ORDER_CHECKS = 2;

  if (pendingOrderId && openOrderIds.has(pendingOrderId)) {
    return 'still_open';
  }

  const baselineSize = baselinePositionSize ?? 0;
  if (currentPositionSize !== null) {
    const sizeDelta = currentPositionSize - baselineSize;
    const didIncreasePosition = sizeDelta > 0.000001;
    const didDecreasePosition = sizeDelta < -0.000001;

    if ((tradeSide === 'BUY' && didIncreasePosition) || (tradeSide === 'SELL' && didDecreasePosition)) {
      return 'executed';
    }
  }

  if ((missingOrderChecks ?? 0) + 1 < MAX_MISSING_ORDER_CHECKS) {
    return 'await_more_evidence';
  }

  return 'clear_pending';
};
