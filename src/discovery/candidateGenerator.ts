import { evaluateWalletVerificationGate } from './verificationService.js';

export const buildDiscoveryCandidates = <T extends {
  address?: string;
  whaleScore?: number;
  volume7d?: number;
  tradeCount7d?: number;
  lastSignalAt?: number;
  activePositions?: number;
  totalCost?: number;
  roiPct?: number | null;
  totalPnl?: number;
}>(wallets: T[]) => {
  return wallets.map((wallet) => ({
    ...wallet,
    verification: evaluateWalletVerificationGate(wallet),
  }));
};
