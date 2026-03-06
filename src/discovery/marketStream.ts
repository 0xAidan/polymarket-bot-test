import { MarketCacheEntry } from './types.js';

export const buildMarketStreamSubscriptions = (markets: MarketCacheEntry[]): string[] => {
  const subscriptions = new Set<string>();

  for (const market of markets) {
    if (!market.priorityTier || market.priorityTier === 'EXCLUDED' || market.priorityTier === 'C') continue;
    for (const tokenId of market.tokenIds) {
      const normalized = String(tokenId || '').trim();
      if (normalized) subscriptions.add(normalized);
    }
  }

  return [...subscriptions];
};

export class MarketStream {
  private subscribedAssets: string[] = [];

  updateMarkets(markets: MarketCacheEntry[]): void {
    this.subscribedAssets = buildMarketStreamSubscriptions(markets);
  }

  getStatus(): { subscribedAssets: number } {
    return { subscribedAssets: this.subscribedAssets.length };
  }

  start(): void {
    /* Stream wiring lands incrementally; shortlist ownership starts here. */
  }

  stop(): void {
    this.subscribedAssets = [];
  }
}
