export const shouldRunRecoveryBackfill = (
  lastRecoveredAtMs: number | undefined,
  nowMs = Date.now(),
  maxCheckpointAgeMs = 5 * 60 * 1000,
): boolean => {
  if (!lastRecoveredAtMs) return true;
  return nowMs - lastRecoveredAtMs >= maxCheckpointAgeMs;
};
