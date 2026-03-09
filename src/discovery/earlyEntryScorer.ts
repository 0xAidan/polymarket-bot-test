export const computeEarlyEntryScore = (input: {
  entryPrice?: number | null;
  currentPrice?: number | null;
}): number => {
  const entryPrice = Number(input.entryPrice);
  const currentPrice = Number(input.currentPrice);

  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice)) return 0;
  if (entryPrice <= 0 || currentPrice <= 0) return 0;

  const edge = currentPrice - entryPrice;
  if (edge <= 0) return 0;

  return Math.max(0, Math.min(100, Math.round((edge / Math.max(currentPrice, 0.01)) * 100 * 10) / 10));
};
