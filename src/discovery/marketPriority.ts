import { DiscoveryPriorityTier, MarketCacheEntry } from './types.js';

const HIGH_INFORMATION_BOOST = 30;
const PRIMARY_DISCOVERY_BOOST = 20;
const ENTERTAINMENT_PENALTY = 30;
const RECURRING_PENALTY = 20;
const NOVELTY_KEYWORDS = ['first', 'before', 'approval', 'ban', 'launch', 'announce', 'cut rates'];

const computeActivityScore = (volume24h?: number): number => {
  const volume = Number(volume24h || 0);
  if (volume <= 0) return 0;
  return Math.min(45, Math.round(Math.log10(volume + 1) * 9));
};

const computeNoveltyScore = (market: MarketCacheEntry): number => {
  const haystack = `${market.title || ''} ${market.slug || ''}`.toLowerCase();
  const keywordHits = NOVELTY_KEYWORDS.filter((keyword) => haystack.includes(keyword)).length;
  return Math.min(25, keywordHits * 8 + (market.highInformationPriority ? 5 : 0));
};

const resolveTier = (market: MarketCacheEntry, priorityScore: number): DiscoveryPriorityTier => {
  if (!market.primaryDiscoveryEligible) return 'EXCLUDED';
  if (market.highInformationPriority && priorityScore >= 60) return 'A';
  if (priorityScore >= 40) return 'B';
  return 'C';
};

const buildInclusionReason = (market: MarketCacheEntry, tier: DiscoveryPriorityTier): string => {
  if (tier === 'EXCLUDED') return 'Excluded from primary discovery because the market is outside the trusted core universe.';
  if (market.highInformationPriority) return 'High-information market with strong discovery value.';
  if (tier === 'B') return 'Primary-discovery market with enough activity to monitor without promoting to the top tier.';
  return 'Primary-discovery market kept in a lower-priority tier for optional or background coverage.';
};

export const scoreMarketPriority = (market: MarketCacheEntry): MarketCacheEntry => {
  const activityScore = computeActivityScore(market.volume24h);
  const noveltyScore = computeNoveltyScore(market);

  let priorityScore = activityScore + noveltyScore;
  if (market.highInformationPriority) priorityScore += HIGH_INFORMATION_BOOST;
  if (market.primaryDiscoveryEligible) priorityScore += PRIMARY_DISCOVERY_BOOST;
  if (market.category === 'entertainment') priorityScore -= ENTERTAINMENT_PENALTY;
  if (market.isRecurring) priorityScore -= RECURRING_PENALTY;
  priorityScore = Math.max(0, Math.min(100, priorityScore));

  const priorityTier = resolveTier(market, priorityScore);

  return {
    ...market,
    priorityTier,
    priorityScore,
    noveltyScore,
    activityScore,
    inclusionReason: buildInclusionReason(market, priorityTier),
  };
};
