import { DiscoveryMarketCategory, MarketCacheEntry } from './types.js';

const SPORTS_KEYWORDS = [
  'vs',
  'v',
  'nba',
  'nfl',
  'mlb',
  'nhl',
  'soccer',
  'football',
  'basketball',
  'baseball',
  'tennis',
  'golf',
  'ufc',
  'mma',
  'f1',
  'formula 1',
  'champions league',
  'premier league',
  'ncaa',
  'world cup',
];
const CRYPTO_KEYWORDS = [
  'bitcoin',
  'btc',
  'ethereum',
  'eth',
  'solana',
  'sol',
  'dogecoin',
  'doge',
  'xrp',
  'cardano',
  'ada',
  'crypto',
  'memecoin',
  'token',
  'coin',
];
const POLITICS_KEYWORDS = [
  'president',
  'election',
  'senate',
  'house',
  'democrat',
  'republican',
  'trump',
  'biden',
  'campaign',
  'primary',
  'governor',
  'mayor',
  'parliament',
];
const MACRO_KEYWORDS = [
  'fed',
  'rate',
  'rates',
  'inflation',
  'cpi',
  'recession',
  'gdp',
  'unemployment',
  'economy',
  'treasury',
  'yield',
  'fomc',
];
const COMPANY_KEYWORDS = [
  'tesla',
  'apple',
  'microsoft',
  'google',
  'meta',
  'amazon',
  'nvidia',
  'openai',
  'spacex',
  'ipo',
  'earnings',
  'approval',
  'acquisition',
  'merger',
  'ceo',
];
const LEGAL_KEYWORDS = [
  'court',
  'supreme court',
  'sec',
  'doj',
  'law',
  'legal',
  'lawsuit',
  'regulation',
  'regulatory',
  'ban',
  'approved by',
  'ruling',
];
const GEOPOLITICS_KEYWORDS = [
  'war',
  'ceasefire',
  'ukraine',
  'russia',
  'china',
  'taiwan',
  'israel',
  'gaza',
  'nato',
  'missile',
  'sanction',
  'geopolit',
];
const ENTERTAINMENT_KEYWORDS = [
  'taylor swift',
  'oscar',
  'grammy',
  'emmy',
  'movie',
  'album',
  'celebrity',
  'box office',
  'tv show',
  'super bowl halftime',
];
const HIGH_INFORMATION_CATEGORIES: DiscoveryMarketCategory[] = [
  'politics',
  'macro',
  'company',
  'legal',
  'geopolitics',
];

export const classifyDiscoveryMarket = (
  input: Pick<MarketCacheEntry, 'title' | 'slug'>
): Pick<
  MarketCacheEntry,
  'category' | 'isSportsLike' | 'isRecurring' | 'primaryDiscoveryEligible' | 'emergingEligible' | 'sharpWalletEligible' | 'highInformationPriority'
> => {
  const haystack = `${input.title || ''} ${input.slug || ''}`.toLowerCase();
  const tokens = new Set(
    haystack
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter(Boolean)
  );
  const isSportsLike = SPORTS_KEYWORDS.some((keyword) => matchesKeyword(haystack, tokens, keyword));
  const isCryptoLike = CRYPTO_KEYWORDS.some((keyword) => matchesKeyword(haystack, tokens, keyword));
  const category = resolveCategory(haystack, isSportsLike, isCryptoLike);
  const primaryDiscoveryEligible = category !== 'crypto' && category !== 'sports';

  return {
    category,
    isSportsLike,
    isRecurring: isSportsLike,
    primaryDiscoveryEligible,
    emergingEligible: primaryDiscoveryEligible,
    sharpWalletEligible: category !== 'crypto',
    highInformationPriority: HIGH_INFORMATION_CATEGORIES.includes(category),
  };
};

const resolveCategory = (
  haystack: string,
  isSportsLike: boolean,
  isCryptoLike: boolean,
): DiscoveryMarketCategory => {
  if (isSportsLike) return 'sports';
  if (isCryptoLike) return 'crypto';
  if (POLITICS_KEYWORDS.some((keyword) => haystack.includes(keyword))) return 'politics';
  if (MACRO_KEYWORDS.some((keyword) => haystack.includes(keyword))) return 'macro';
  if (COMPANY_KEYWORDS.some((keyword) => haystack.includes(keyword))) return 'company';
  if (LEGAL_KEYWORDS.some((keyword) => haystack.includes(keyword))) return 'legal';
  if (GEOPOLITICS_KEYWORDS.some((keyword) => haystack.includes(keyword))) return 'geopolitics';
  if (ENTERTAINMENT_KEYWORDS.some((keyword) => haystack.includes(keyword))) return 'entertainment';
  return 'event';
};

const matchesKeyword = (haystack: string, tokens: Set<string>, keyword: string): boolean => {
  return keyword.includes(' ') ? haystack.includes(keyword) : tokens.has(keyword);
};
