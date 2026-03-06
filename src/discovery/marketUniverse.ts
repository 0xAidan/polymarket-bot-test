import { scoreMarketPriority } from './marketPriority.js';
import { DiscoveryPriorityTier, MarketCacheEntry } from './types.js';

export const buildMarketUniverse = (markets: MarketCacheEntry[]): MarketCacheEntry[] => {
  return markets
    .map(scoreMarketPriority)
    .sort((a, b) => {
      const tierRank: Record<DiscoveryPriorityTier, number> = {
        A: 0,
        B: 1,
        C: 2,
        EXCLUDED: 3,
      };
      const left = tierRank[a.priorityTier || 'EXCLUDED'];
      const right = tierRank[b.priorityTier || 'EXCLUDED'];
      if (left !== right) return left - right;
      return Number(b.priorityScore || 0) - Number(a.priorityScore || 0);
    });
};

export const getShortlistedMarketUniverse = (
  markets: MarketCacheEntry[],
  tiers: DiscoveryPriorityTier[] = ['A', 'B'],
): MarketCacheEntry[] => {
  const allowed = new Set(tiers);
  return buildMarketUniverse(markets).filter((market) => allowed.has(market.priorityTier || 'EXCLUDED'));
};
