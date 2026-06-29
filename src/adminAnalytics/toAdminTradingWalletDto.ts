import type { TradingWallet } from '../types.js';

export type AdminTradingWalletDto = {
  id: string;
  label: string;
  address: string;
  proxyAddress: string | null;
  polymarketFunderAddress: string | null;
  isActive: boolean;
  createdAt: string;
  hasCredentials: boolean;
};

export const toAdminTradingWalletDto = (wallet: TradingWallet): AdminTradingWalletDto => ({
  id: wallet.id,
  label: wallet.label,
  address: wallet.address,
  proxyAddress: wallet.proxyAddress ?? null,
  polymarketFunderAddress: wallet.polymarketFunderAddress ?? null,
  isActive: wallet.isActive,
  createdAt: wallet.createdAt,
  hasCredentials: Boolean(wallet.hasCredentials),
});
