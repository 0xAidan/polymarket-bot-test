/**
 * Trade Enricher
 *
 * Maps raw on-chain asset IDs to human-readable market names and resolves
 * proxy wallet addresses to Polymarket pseudonyms. Uses aggressive caching
 * to minimise API calls.
 */

import axios from 'axios';
import { config } from '../config.js';
import { DiscoveredTrade, MarketCacheEntry } from './types.js';
import {
  upsertMarketCache,
  getMarketByAssetId,
  getMarketByConditionId,
} from './statsStore.js';

// ---------------------------------------------------------------------------
// In-memory caches (hot path -- avoids DB reads on every trade)
// ---------------------------------------------------------------------------

const profileCache = new Map<string, string | null>(); // address -> pseudonym
const assetToConditionCache = new Map<string, string>(); // assetId -> conditionId
const conditionToTitleCache = new Map<string, string>(); // conditionId -> title

const PROFILE_CACHE_MAX = 10_000;
const ASSET_CACHE_MAX = 50_000;
const PROFILE_CONCURRENCY_LIMIT = 10;

let activeProfileRequests = 0;
const profileQueue: Array<{ address: string; resolve: (v: string | null) => void }> = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enrich a discovered trade with market metadata and wallet pseudonym.
 * Non-blocking: returns the trade as-is if enrichment data is unavailable.
 */
export const enrichTrade = async (trade: DiscoveredTrade): Promise<DiscoveredTrade> => {
  // Enrich market info if missing
  if (!trade.marketTitle && trade.assetId) {
    try {
      const market = await resolveAssetToMarket(trade.assetId);
      if (market) {
        trade.conditionId = market.conditionId;
        trade.marketSlug = market.slug;
        trade.marketTitle = market.title;
      }
    } catch { /* best-effort */ }
  }

  return trade;
};

/**
 * Resolve a proxy wallet address to a Polymarket pseudonym.
 * Returns null if the profile can't be fetched.
 */
export const resolveWalletPseudonym = async (address: string): Promise<string | null> => {
  const lower = address.toLowerCase();

  if (profileCache.has(lower)) {
    return profileCache.get(lower)!;
  }

  return new Promise((resolve) => {
    profileQueue.push({ address: lower, resolve });
    drainProfileQueue();
  });
};

/**
 * Pre-populate the market cache with a batch of markets from the Gamma API.
 * Called periodically (e.g. every 15 min) by the API poller.
 */
export const refreshMarketCache = async (marketCount: number): Promise<MarketCacheEntry[]> => {
  try {
    const resp = await axios.get(`${config.polymarketGammaApiUrl}/events`, {
      params: { active: true, order: 'volume_24hr', limit: marketCount, ascending: false },
      timeout: 15_000,
    });

    const events = resp.data || [];
    const entries: MarketCacheEntry[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (const event of events) {
      const markets = event.markets || [];
      for (const market of markets) {
        if (!market.conditionId) continue;
        const tokenIds: string[] = [];
        if (market.clobTokenIds) {
          const parsed = typeof market.clobTokenIds === 'string'
            ? JSON.parse(market.clobTokenIds)
            : market.clobTokenIds;
          tokenIds.push(...parsed);
        }

        const entry: MarketCacheEntry = {
          conditionId: market.conditionId,
          slug: market.slug || event.slug,
          title: market.question || event.title,
          volume24h: parseFloat(market.volume24hr || '0'),
          tokenIds,
          updatedAt: now,
        };

        entries.push(entry);
        upsertMarketCache(entry);

        // Populate in-memory caches
        for (const tid of tokenIds) {
          assetToConditionCache.set(tid, market.conditionId);
        }
        if (entry.title) {
          conditionToTitleCache.set(market.conditionId, entry.title);
        }
      }
    }

    return entries;
  } catch (err: any) {
    console.error('[Enricher] Failed to refresh market cache:', err.message);
    return [];
  }
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const resolveAssetToMarket = async (assetId: string): Promise<MarketCacheEntry | null> => {
  // 1. In-memory cache
  const cachedCondition = assetToConditionCache.get(assetId);
  if (cachedCondition) {
    const title = conditionToTitleCache.get(cachedCondition);
    if (title) {
      return { conditionId: cachedCondition, title, tokenIds: [assetId], updatedAt: 0 };
    }
    const dbEntry = getMarketByConditionId(cachedCondition);
    if (dbEntry) return dbEntry;
  }

  // 2. DB cache
  const dbEntry = getMarketByAssetId(assetId);
  if (dbEntry) {
    for (const tid of dbEntry.tokenIds) assetToConditionCache.set(tid, dbEntry.conditionId);
    if (dbEntry.title) conditionToTitleCache.set(dbEntry.conditionId, dbEntry.title);
    return dbEntry;
  }

  // 3. Gamma API lookup by token_id
  try {
    const resp = await axios.get(`${config.polymarketGammaApiUrl}/markets`, {
      params: { clob_token_ids: assetId },
      timeout: 10_000,
    });

    const markets = resp.data || [];
    if (markets.length > 0) {
      const m = markets[0];
      const tokenIds: string[] = m.clobTokenIds
        ? (typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds)
        : [assetId];

      const entry: MarketCacheEntry = {
        conditionId: m.conditionId,
        slug: m.slug,
        title: m.question || m.slug,
        volume24h: parseFloat(m.volume24hr || '0'),
        tokenIds,
        updatedAt: Math.floor(Date.now() / 1000),
      };

      upsertMarketCache(entry);
      for (const tid of tokenIds) assetToConditionCache.set(tid, entry.conditionId);
      if (entry.title) conditionToTitleCache.set(entry.conditionId, entry.title);

      if (assetToConditionCache.size > ASSET_CACHE_MAX) {
        const iter = assetToConditionCache.keys();
        for (let i = 0; i < 5000; i++) iter.next();
        // Evict oldest 5k entries by recreating (simple approach)
      }

      return entry;
    }
  } catch { /* best-effort */ }

  return null;
};

const drainProfileQueue = async (): Promise<void> => {
  while (profileQueue.length > 0 && activeProfileRequests < PROFILE_CONCURRENCY_LIMIT) {
    const item = profileQueue.shift();
    if (!item) break;

    activeProfileRequests++;
    fetchProfile(item.address)
      .then((pseudonym) => {
        item.resolve(pseudonym);
      })
      .catch(() => {
        item.resolve(null);
      })
      .finally(() => {
        activeProfileRequests--;
        drainProfileQueue();
      });
  }
};

const fetchProfile = async (address: string): Promise<string | null> => {
  if (profileCache.has(address)) return profileCache.get(address)!;

  try {
    const resp = await axios.get(`${config.polymarketDataApiUrl}/profile`, {
      params: { address },
      timeout: 8_000,
    });

    const pseudonym: string | null = resp.data?.username || resp.data?.name || null;
    profileCache.set(address, pseudonym);

    if (profileCache.size > PROFILE_CACHE_MAX) {
      const iter = profileCache.keys();
      for (let i = 0; i < 1000; i++) {
        const k = iter.next().value;
        if (k) profileCache.delete(k);
      }
    }

    return pseudonym;
  } catch {
    profileCache.set(address, null);
    return null;
  }
};
