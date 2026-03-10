import { DetectedTrade, TrackedWallet, TradeSizingMode } from './types.js';

type WalletSizingConfig = Pick<TrackedWallet, 'tradeSizingMode' | 'fixedTradeSize'>;
type TradeSizingConfig = Pick<DetectedTrade, 'tradeSizingMode' | 'fixedTradeSize' | 'walletAddress'>;

function isConfiguredFixedMode(mode: TradeSizingMode | undefined, fixedTradeSize: number | undefined): boolean {
  return mode === 'fixed' && typeof fixedTradeSize === 'number' && fixedTradeSize > 0;
}

function isConfiguredProportionalMode(mode: TradeSizingMode | undefined): boolean {
  return mode === 'proportional';
}

export function hasExplicitTradeSizingConfig(config: WalletSizingConfig | TradeSizingConfig): boolean {
  return isConfiguredFixedMode(config.tradeSizingMode, config.fixedTradeSize)
    || isConfiguredProportionalMode(config.tradeSizingMode);
}

export function getMissingTradeSizingMessage(walletAddress: string): string {
  return `Wallet ${walletAddress} cannot be enabled or traded because it has no explicit trade sizing config. Set fixed or proportional sizing first.`;
}

export function assertWalletCanBeEnabled(wallet: TrackedWallet): void {
  if (!hasExplicitTradeSizingConfig(wallet)) {
    throw new Error(getMissingTradeSizingMessage(wallet.address));
  }
}

export function assertTradeCanExecuteForWallet(trade: DetectedTrade): void {
  if (!hasExplicitTradeSizingConfig(trade)) {
    throw new Error(getMissingTradeSizingMessage(trade.walletAddress));
  }
}
