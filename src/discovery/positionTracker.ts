/**
 * Position Tracker
 *
 * Accumulates trades into per-wallet per-market positions. Tracks average
 * entry price, total cost, and share count. Periodically refreshes current
 * market prices from Gamma API to compute unrealized PnL and ROI.
 *
 * IMPORTANT: Only processes trades with both `side` and `price` defined.
 * Chain-sourced trades that lack this data are skipped for position building
 * but still contribute to volume stats in discovery_wallets.
 */

import axios from 'axios';
import { config } from '../config.js';
import { DiscoveredTrade, WalletPosition } from './types.js';
import { getDatabase } from '../database.js';
import {
  upsertPosition,
  getActivePositionKeys,
  batchUpdatePrices,
  aggregateWalletPnL,
} from './statsStore.js';

const PRICE_REFRESH_RATE_LIMIT_MS = 200; // 5 req/s

interface OfficialPositionResponse {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  size?: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  realizedPnl?: number;
  curPrice?: number;
  title?: string;
  slug?: string;
  outcome?: string;
  redeemable?: boolean;
  mergeable?: boolean;
}

const parsePositionSize = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const isLiveOpenPosition = (
  position: Pick<OfficialPositionResponse, 'size' | 'redeemable'> | Pick<WalletPosition, 'shares' | 'positionStatus'>
): boolean => {
  const shares = 'shares' in position ? parsePositionSize(position.shares) : parsePositionSize(position.size);
  const isRedeemable = 'redeemable' in position
    ? Boolean(position.redeemable)
    : Boolean((position as Pick<WalletPosition, 'positionStatus'>).positionStatus === 'redeemable');
  return shares > 0 && !isRedeemable;
};

export const filterLiveWalletPositions = <T extends Pick<WalletPosition, 'shares' | 'positionStatus'>>(positions: T[]): T[] =>
  positions.filter((position) => isLiveOpenPosition(position));

export const updatePosition = (trade: DiscoveredTrade): void => {
  if (!trade.side || trade.price === undefined || trade.price === null) return;
  if (!trade.conditionId) return;
  if (!trade.assetId) return;
  if (trade.size <= 0) return;

  try {
    upsertPosition(
      trade.maker,
      trade.conditionId,
      trade.assetId,
      trade.side.toUpperCase(),
      trade.size,
      trade.price,
      trade.outcome,
      trade.marketTitle,
      trade.marketSlug,
    );
  } catch (err) {
    console.error('[PositionTracker] Failed to update position:', err);
  }
};

export const refreshPositionPrices = async (): Promise<void> => {
  const positionKeys = getActivePositionKeys();
  if (positionKeys.length === 0) {
    try {
      aggregateWalletPnL();
    } catch (err) {
      console.error('[PositionTracker] PnL aggregation failed:', err);
    }
    return;
  }

  const conditionIds = [...new Set(positionKeys.map((k) => k.conditionId))];
  console.log(`[PositionTracker] Refreshing prices for ${conditionIds.length} markets / ${positionKeys.length} outcome positions...`);
  const updates: { conditionId: string; assetId: string; price: number; outcome?: string }[] = [];
  let missingMarkets = 0;
  let missingAssetPrices = 0;
  let priced = 0;

  for (const conditionId of conditionIds) {
    try {
      const resp = await axios.get(`${config.polymarketGammaApiUrl}/markets`, {
        params: { condition_ids: conditionId },
        timeout: 10_000,
      });
      const markets = (resp.data || []) as any[];
      const market = markets.find(
        (m) => String(m?.conditionId || '').toLowerCase() === conditionId.toLowerCase()
      );

      if (!market) {
        missingMarkets++;
      } else {
        const keysForCondition = positionKeys.filter((k) => k.conditionId === conditionId);
        for (const key of keysForCondition) {
          const resolved = resolveAssetPrice(market, key.assetId);
          const price = resolved.price;
          if (price > 0) {
            updates.push({ conditionId, assetId: key.assetId, price, outcome: resolved.outcome });
            priced++;
          } else {
            missingAssetPrices++;
          }
        }
      }
    } catch (err: any) {
      if (err.response?.status !== 404) {
        console.error(`[PositionTracker] Price fetch failed for ${conditionId.slice(0, 12)}:`, err.message);
      }
      missingMarkets++;
    }
    await sleep(PRICE_REFRESH_RATE_LIMIT_MS);
  }

  if (updates.length > 0) {
    batchUpdatePrices(updates);
    console.log(`[PositionTracker] Updated prices for ${updates.length} outcome positions`);
  }
  console.log(`[PositionTracker] Pricing summary: priced=${priced}, missingMarkets=${missingMarkets}, missingAssetPrices=${missingAssetPrices}`);

  try {
    aggregateWalletPnL();
  } catch (err) {
    console.error('[PositionTracker] PnL aggregation failed:', err);
  }
};

export const fetchAuthoritativePositions = async (address: string): Promise<WalletPosition[]> => {
  const resp = await axios.get(`${config.polymarketDataApiUrl}/positions`, {
    params: {
      user: address,
      sizeThreshold: 0,
      limit: 500,
      sortBy: 'CURRENT',
      sortDirection: 'DESC',
    },
    timeout: 12_000,
  });

  const rows = Array.isArray(resp.data) ? resp.data : [];
  return rows
    .filter((row) => isLiveOpenPosition(row as OfficialPositionResponse))
    .map((row) => mapOfficialPositionToWalletPosition(row));
};

export const mapOfficialPositionToWalletPosition = (
  position: OfficialPositionResponse,
  dataSource: 'verified' | 'cached' = 'verified'
): WalletPosition => {
  const updatedAt = Date.now();
  const shares = Number(position.size || 0);
  const avgEntry = Number(position.avgPrice || 0);
  const totalCost = Number(position.initialValue ?? shares * avgEntry);
  const positionStatus: WalletPosition['positionStatus'] = position.redeemable
    ? 'redeemable'
    : shares > 0
      ? 'open'
      : 'closed';

  return {
    address: String(position.proxyWallet || '').toLowerCase(),
    conditionId: String(position.conditionId || ''),
    assetId: String(position.asset || ''),
    outcome: position.outcome,
    marketSlug: position.slug,
    marketTitle: position.title,
    shares,
    avgEntry,
    totalCost,
    totalTrades: 0,
    firstEntry: updatedAt,
    lastEntry: updatedAt,
    currentPrice: Number(position.curPrice || 0),
    priceUpdatedAt: updatedAt,
    unrealizedPnl: Number(position.cashPnl || 0),
    roiPct: Number(position.percentPnl || 0),
    realizedPnl: Number(position.realizedPnl || 0),
    currentValue: Number(position.currentValue || 0),
    dataSource,
    positionStatus,
    updatedAt,
  };
};

export const summarizeAuthoritativePositions = (
  positions: WalletPosition[]
): { totalPnl: number; totalCost: number; roiPct: number | null; activePositions: number } => {
  const activePositions = filterLiveWalletPositions(positions);
  const totalPnl = activePositions.reduce((sum, position) => sum + Number(position.unrealizedPnl || 0), 0);
  const totalCost = activePositions.reduce((sum, position) => sum + Number(position.totalCost || 0), 0);

  return {
    totalPnl,
    totalCost,
    roiPct: totalCost > 0 ? (totalPnl / totalCost) * 100 : null,
    activePositions: activePositions.length,
  };
};

export const buildPositionVerificationSummary = (
  derivedPositions: WalletPosition[],
  verifiedPositions: WalletPosition[],
): {
  derivedCount: number;
  verifiedCount: number;
  sharedCount: number;
  onlyDerivedCount: number;
  onlyVerifiedCount: number;
} => {
  const toKey = (position: WalletPosition) => `${position.conditionId}:${position.assetId}`;
  const derivedKeys = new Set(derivedPositions.map(toKey));
  const verifiedKeys = new Set(verifiedPositions.map(toKey));
  const sharedCount = [...derivedKeys].filter((key) => verifiedKeys.has(key)).length;

  return {
    derivedCount: derivedKeys.size,
    verifiedCount: verifiedKeys.size,
    sharedCount,
    onlyDerivedCount: [...derivedKeys].filter((key) => !verifiedKeys.has(key)).length,
    onlyVerifiedCount: [...verifiedKeys].filter((key) => !derivedKeys.has(key)).length,
  };
};

/**
 * Backfill positions from existing discovery_trades.
 * Clears existing positions and rebuilds from all trades that have
 * valid side and price data. Safe to call multiple times.
 */
export const backfillPositions = (): void => {
  const db = getDatabase();

  const tradeCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM discovery_trades WHERE side IS NOT NULL AND price IS NOT NULL AND price > 0 AND condition_id IS NOT NULL`
  ).get() as { cnt: number };

  if (tradeCount.cnt === 0) {
    console.log('[PositionTracker] No trades with side/price to backfill from');
    return;
  }

  const posCount = db.prepare('SELECT COUNT(*) as cnt FROM discovery_positions').get() as { cnt: number };
  if (posCount.cnt > 0) {
    console.log(`[PositionTracker] Rebuilding positions (clearing ${posCount.cnt} existing)...`);
    db.prepare('DELETE FROM discovery_positions').run();
  }

  console.log(`[PositionTracker] Backfilling positions from ${tradeCount.cnt} trades...`);
  const trades = db.prepare(`
    SELECT * FROM discovery_trades WHERE side IS NOT NULL AND price IS NOT NULL AND price > 0 AND condition_id IS NOT NULL
    ORDER BY detected_at ASC
  `).all() as any[];

  let processed = 0;
  for (const t of trades) {
    try {
      for (const trackedTrade of buildBackfillPositionTrades(t)) {
        upsertPosition(
          trackedTrade.address,
          trackedTrade.conditionId,
          trackedTrade.assetId,
          trackedTrade.side,
          trackedTrade.size,
          trackedTrade.price,
          trackedTrade.outcome,
          trackedTrade.marketTitle,
          trackedTrade.marketSlug,
        );
        processed++;
      }
    } catch {
      /* skip bad rows */
    }
  }
  console.log(`[PositionTracker] Backfilled ${processed} position updates from trades`);
};

export const buildBackfillPositionTrades = (trade: {
  maker: string;
  condition_id: string;
  asset_id: string;
  side: string;
  size: number;
  price: number;
  outcome?: string;
  market_title?: string;
  market_slug?: string;
}): Array<{
  address: string;
  conditionId: string;
  assetId: string;
  side: string;
  size: number;
  price: number;
  outcome?: string;
  marketTitle?: string;
  marketSlug?: string;
}> => {
  return [{
    address: trade.maker,
    conditionId: trade.condition_id,
    assetId: trade.asset_id,
    side: trade.side.toUpperCase(),
    size: trade.size,
    price: trade.price,
    outcome: trade.outcome,
    marketTitle: trade.market_title,
    marketSlug: trade.market_slug,
  }];
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const resolveAssetPrice = (market: any, assetId: string): { price: number; outcome?: string } => {
  const normalizedAssetId = String(assetId || '');
  const tokenIds = parseStringArray(market?.clobTokenIds);
  const outcomePrices = parseNumberArray(market?.outcomePrices);
  const outcomes = parseStringArray(market?.outcomes);
  const assetIdx = tokenIds.findIndex((tokenId) => tokenId === normalizedAssetId);
  if (assetIdx >= 0 && assetIdx < outcomePrices.length) {
    const tokenPrice = outcomePrices[assetIdx];
    if (Number.isFinite(tokenPrice) && tokenPrice > 0) {
      return { price: tokenPrice, outcome: outcomes[assetIdx] };
    }
  }

  const fallback = Number.parseFloat(String(market?.lastTradePrice || market?.bestBid || market?.bestAsk || '0'));
  return { price: Number.isFinite(fallback) && fallback > 0 ? fallback : 0 };
};

const parseStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch { /* ignore parse error */ }
  }
  return [];
};

const parseNumberArray = (value: unknown): number[] => {
  if (Array.isArray(value)) {
    return value.map((v) => Number.parseFloat(String(v))).filter((v) => Number.isFinite(v));
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => Number.parseFloat(String(v))).filter((v) => Number.isFinite(v));
      }
    } catch { /* ignore parse error */ }
  }
  return [];
};
