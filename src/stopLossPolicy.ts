export const resolveStopLossPositionValue = (position: {
  size?: string | number;
  curPrice?: string | number;
  asset?: string;
  asset_id?: string;
}): number => {
  const size = parseFloat(String(position.size ?? '0'));
  const curPrice = parseFloat(String(position.curPrice ?? 'NaN'));
  if (!Number.isFinite(curPrice) || curPrice < 0) {
    throw new Error(
      `Cannot evaluate stop-loss safely because curPrice is missing/invalid for token ${position.asset || position.asset_id || 'unknown'}`
    );
  }
  return size * curPrice;
};
