export type DiscoveryTrustLevel = 'provisional' | 'verified' | 'suppressed';

export interface VerificationDecision {
  trustLevel: DiscoveryTrustLevel;
  reason?: string;
}

type VerificationWalletInput = {
  whaleScore?: number;
  volume7d?: number;
  tradeCount7d?: number;
  lastSignalAt?: number;
  activePositions?: number;
  totalCost?: number;
  roiPct?: number | null;
  totalPnl?: number;
};

const MIN_SURFACED_SCORE = 20;
const MIN_SURFACED_VOLUME = 2500;
const MIN_SURFACED_TRADES = 4;
const MIN_SURFACED_FALLBACK_VOLUME = 750;
const MIN_VERIFIED_COST_BASIS = 500;
const MIN_COST_BASIS_TO_AVOID_SUPPRESSION = 250;

export const evaluateWalletVerificationGate = (
  wallet: VerificationWalletInput,
): VerificationDecision => {
  const hasSignal = Number(wallet.lastSignalAt || 0) > 0;
  const hasSurfacingEvidence =
    hasSignal ||
    Number(wallet.whaleScore || 0) >= MIN_SURFACED_SCORE ||
    Number(wallet.volume7d || 0) >= MIN_SURFACED_VOLUME ||
    (
      Number(wallet.tradeCount7d || 0) >= MIN_SURFACED_TRADES &&
      Number(wallet.volume7d || 0) >= MIN_SURFACED_FALLBACK_VOLUME
    );

  if (!hasSurfacingEvidence) {
    return { trustLevel: 'suppressed', reason: 'Insufficient evidence to surface this wallet yet.' };
  }

  if (Number(wallet.activePositions || 0) > 0) {
    if (Number(wallet.totalCost || 0) < MIN_COST_BASIS_TO_AVOID_SUPPRESSION) {
      return { trustLevel: 'suppressed', reason: 'Suppressed because the verified cost basis is too small to trust.' };
    }

    if (Number(wallet.totalCost || 0) >= MIN_VERIFIED_COST_BASIS) {
      return { trustLevel: 'verified' };
    }
  }

  return { trustLevel: 'provisional', reason: 'Useful discovery signal, but verification evidence is still limited.' };
};
