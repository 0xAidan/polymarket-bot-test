/**
 * Discovery Stats Store
 *
 * CRUD operations for discovery_trades, discovery_wallets, discovery_market_cache,
 * and discovery_config tables. Also handles the periodic stats aggregation job
 * and data retention cleanup.
 */

import { getDatabase } from '../database.js';
import { config } from '../config.js';
import {
  DiscoveredTrade,
  DiscoveryMarketCategory,
  WalletStats,
  MarketCacheEntry,
  DiscoveryConfig,
  DEFAULT_DISCOVERY_CONFIG,
  WalletPosition,
  DiscoverySignal,
  SignalType,
  SignalSeverity,
} from './types.js';
import { classifyDiscoveryMarket } from './marketClassifier.js';

// ---------------------------------------------------------------------------
// DISCOVERY CONFIG (runtime-editable, persisted in SQLite)
// ---------------------------------------------------------------------------

const normalizeAlchemyWsUrl = (raw?: string): string => {
  const value = (raw || '').trim();
  if (!value) return '';
  if (value.startsWith('ws://') || value.startsWith('wss://')) return value;
  return `wss://polygon-mainnet.g.alchemy.com/v2/${value}`;
};

export const getDiscoveryConfig = (): DiscoveryConfig => {
  const db = getDatabase();
  const rows = db.prepare('SELECT key, value FROM discovery_config').all() as { key: string; value: string }[];

  const stored: Record<string, string> = {};
  for (const row of rows) {
    stored[row.key] = row.value;
  }

  return {
    enabled: stored.enabled !== undefined ? stored.enabled === 'true' : config.discoveryEnabled,
    alchemyWsUrl: normalizeAlchemyWsUrl(stored.alchemyWsUrl ?? config.discoveryAlchemyWsUrl),
    pollIntervalMs: stored.pollIntervalMs !== undefined ? parseInt(stored.pollIntervalMs, 10) : config.discoveryPollIntervalMs,
    marketCount: stored.marketCount !== undefined ? parseInt(stored.marketCount, 10) : config.discoveryMarketCount,
    statsIntervalMs: stored.statsIntervalMs !== undefined ? parseInt(stored.statsIntervalMs, 10) : config.discoveryStatsIntervalMs,
    retentionDays: stored.retentionDays !== undefined ? parseInt(stored.retentionDays, 10) : DEFAULT_DISCOVERY_CONFIG.retentionDays,
  };
};

export const updateDiscoveryConfig = (updates: Partial<DiscoveryConfig>): void => {
  const db = getDatabase();
  const upsert = db.prepare(
    'INSERT INTO discovery_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        if (key === 'alchemyWsUrl') {
          upsert.run(key, normalizeAlchemyWsUrl(String(value)));
        } else {
          upsert.run(key, String(value));
        }
      }
    }
  });
  tx();
};

// ---------------------------------------------------------------------------
// TRADES
// ---------------------------------------------------------------------------

export const insertTrade = (trade: DiscoveredTrade): boolean => {
  const db = getDatabase();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO discovery_trades
        (tx_hash, event_key, maker, taker, asset_id, condition_id, market_slug, market_title, side, size, price, notional_usd, fee, source, detected_at, block_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.txHash,
      trade.eventKey ?? null,
      trade.maker,
      trade.taker,
      trade.assetId,
      trade.conditionId ?? null,
      trade.marketSlug ?? null,
      trade.marketTitle ?? null,
      trade.side ?? null,
      trade.size,
      trade.price ?? null,
      trade.notionalUsd ?? (trade.price !== undefined ? trade.size * trade.price : null),
      trade.fee,
      trade.source,
      trade.detectedAt,
      trade.blockNumber ?? null,
    );
    return true;
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
    throw err;
  }
};

export const insertTradeBatch = (trades: DiscoveredTrade[]): number => {
  if (trades.length === 0) return 0;
  const db = getDatabase();
  let inserted = 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO discovery_trades
      (tx_hash, event_key, maker, taker, asset_id, condition_id, market_slug, market_title, side, size, price, notional_usd, fee, source, detected_at, block_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const t of trades) {
      const result = stmt.run(
        t.txHash, t.eventKey ?? null, t.maker, t.taker, t.assetId,
        t.conditionId ?? null, t.marketSlug ?? null, t.marketTitle ?? null,
        t.side ?? null, t.size, t.price ?? null, t.notionalUsd ?? (t.price !== undefined ? t.size * t.price : null),
        t.fee, t.source, t.detectedAt, t.blockNumber ?? null,
      );
      if (result.changes > 0) inserted++;
    }
  });
  tx();
  return inserted;
};

export const tradeExistsByHash = (txHash: string): boolean => {
  const db = getDatabase();
  const row = db.prepare('SELECT 1 FROM discovery_trades WHERE tx_hash = ?').get(txHash);
  return !!row;
};

export const tradeExistsByEventKey = (eventKey: string): boolean => {
  if (!eventKey) return false;
  const db = getDatabase();
  const row = db.prepare('SELECT 1 FROM discovery_trades WHERE event_key = ?').get(eventKey);
  return !!row;
};

export const getTotalTradeCount = (): number => {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM discovery_trades').get() as { cnt: number };
  return row.cnt;
};

// ---------------------------------------------------------------------------
// WALLETS
// ---------------------------------------------------------------------------

export const upsertWallet = (address: string, detectedAt: number): void => {
  const normalizedAddress = String(address || '').trim().toLowerCase();
  if (!normalizedAddress) return;
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_wallets (address, first_seen, last_active, prior_active_at, updated_at)
    VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(address) DO UPDATE SET
      prior_active_at = CASE
        WHEN excluded.last_active > discovery_wallets.last_active THEN discovery_wallets.last_active
        ELSE discovery_wallets.prior_active_at
      END,
      last_active = MAX(last_active, excluded.last_active),
      updated_at = excluded.updated_at
  `).run(normalizedAddress, detectedAt, detectedAt, Math.floor(Date.now() / 1000));
};

export const getWalletStats = (address: string): WalletStats | null => {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM discovery_wallets WHERE address = ?').get(address) as any;
  if (!row) return null;
  return rowToWalletStats(row);
};

export const getTopWallets = (
  sort: 'volume' | 'trades' | 'recent' | 'score' | 'roi' = 'volume',
  limit = 50,
  offset = 0,
  filters?: { minScore?: number; heat?: string; hasSignals?: boolean },
): WalletStats[] => {
  const db = getDatabase();
  const orderMap: Record<string, string> = {
    volume: 'volume_7d DESC',
    trades: 'trade_count_7d DESC',
    recent: 'last_active DESC',
    score: 'whale_score DESC',
    roi: 'roi_pct DESC',
  };
  const orderBy = orderMap[sort] || 'volume_7d DESC';
  let where = 'WHERE 1=1';
  const params: any[] = [];
  if (filters?.minScore !== undefined) {
    where += ' AND whale_score >= ?';
    params.push(filters.minScore);
  }
  if (filters?.heat) {
    where += ' AND heat_indicator = ?';
    params.push(filters.heat);
  }
  if (filters?.hasSignals) {
    where += ' AND last_signal_at IS NOT NULL';
  }
  params.push(limit, offset);
  const rows = db.prepare(
    `SELECT * FROM discovery_wallets ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).all(...params) as any[];
  return rows.map(rowToWalletStats);
};

export const getTotalWalletCount = (): number => {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM discovery_wallets').get() as { cnt: number };
  return row.cnt;
};

export const markWalletTracked = (address: string, tracked: boolean): void => {
  const db = getDatabase();
  db.prepare('UPDATE discovery_wallets SET is_tracked = ? WHERE address = ?').run(tracked ? 1 : 0, address.toLowerCase());
};

export const aggregateWalletPnL = (): void => {
  const db = getDatabase();
  db.exec(`
    UPDATE discovery_wallets SET
      total_pnl = COALESCE((SELECT SUM(unrealized_pnl) FROM discovery_positions WHERE address = discovery_wallets.address AND shares > 0), 0),
      roi_pct = CASE
        WHEN COALESCE((SELECT COUNT(*) FROM discovery_positions WHERE address = discovery_wallets.address AND shares > 0 AND current_price IS NOT NULL), 0) = 0
          THEN NULL
        WHEN COALESCE((SELECT SUM(total_cost) FROM discovery_positions WHERE address = discovery_wallets.address AND shares > 0), 0) > 0
        THEN COALESCE((SELECT SUM(unrealized_pnl) FROM discovery_positions WHERE address = discovery_wallets.address AND shares > 0), 0) /
             (SELECT SUM(total_cost) FROM discovery_positions WHERE address = discovery_wallets.address AND shares > 0) * 100
        ELSE 0
      END,
      active_positions = COALESCE((SELECT COUNT(*) FROM discovery_positions WHERE address = discovery_wallets.address AND shares > 0), 0),
      win_rate = COALESCE((
        SELECT CASE WHEN COUNT(*) > 0 THEN SUM(CASE WHEN unrealized_pnl > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100 ELSE 0 END
        FROM discovery_positions WHERE address = discovery_wallets.address AND shares > 0
      ), 0)
  `);
};

const rowToWalletStats = (row: any): WalletStats => ({
  address: row.address,
  pseudonym: row.pseudonym ?? undefined,
  firstSeen: row.first_seen,
  lastActive: row.last_active,
  priorActiveAt: row.prior_active_at ?? undefined,
  tradeCount7d: row.trade_count_7d,
  volume7d: row.volume_7d,
  volumePrev7d: row.volume_prev_7d,
  highInformationVolume7d: row.high_information_volume_7d ?? 0,
  focusCategory: row.focus_category ?? undefined,
  largestTrade: row.largest_trade,
  uniqueMarkets7d: row.unique_markets_7d,
  avgTradeSize: row.avg_trade_size,
  isTracked: row.is_tracked === 1,
  updatedAt: row.updated_at,
  whaleScore: row.whale_score ?? 0,
  heatIndicator: (row.heat_indicator ?? 'NEW') as WalletStats['heatIndicator'],
  totalPnl: row.total_pnl ?? 0,
  roiPct: row.roi_pct ?? null,
  winRate: row.win_rate ?? 0,
  activePositions: row.active_positions ?? 0,
  lastSignalType: row.last_signal_type ?? undefined,
  lastSignalAt: row.last_signal_at ?? undefined,
});

// ---------------------------------------------------------------------------
// MARKET CACHE
// ---------------------------------------------------------------------------

export const upsertMarketCache = (entry: MarketCacheEntry): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_market_cache (condition_id, slug, title, volume_24h, token_ids, outcomes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(condition_id) DO UPDATE SET
      slug = excluded.slug,
      title = excluded.title,
      volume_24h = excluded.volume_24h,
      token_ids = excluded.token_ids,
      outcomes = excluded.outcomes,
      updated_at = excluded.updated_at
  `).run(
    entry.conditionId,
    entry.slug ?? null,
    entry.title ?? null,
    entry.volume24h ?? null,
    JSON.stringify(entry.tokenIds),
    JSON.stringify(entry.outcomes ?? []),
    entry.updatedAt,
  );
};

export const getMarketByAssetId = (assetId: string): MarketCacheEntry | null => {
  const db = getDatabase();
  const normalizedAssetId = String(assetId ?? '').trim();
  if (!normalizedAssetId) return null;
  const rows = db.prepare('SELECT * FROM discovery_market_cache').all() as any[];
  for (const row of rows) {
    const tokenIds: string[] = (JSON.parse(row.token_ids || '[]') as unknown[])
      .map((tokenId) => String(tokenId ?? '').trim())
      .filter(Boolean);
    if (tokenIds.includes(normalizedAssetId)) {
      return {
        conditionId: row.condition_id,
        slug: row.slug ?? undefined,
        title: row.title ?? undefined,
        volume24h: row.volume_24h ?? undefined,
        tokenIds,
        outcomes: (JSON.parse(row.outcomes || '[]') as unknown[]).map((outcome) => String(outcome)),
        updatedAt: row.updated_at,
      };
    }
  }
  return null;
};

export const getMarketByConditionId = (conditionId: string): MarketCacheEntry | null => {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM discovery_market_cache WHERE condition_id = ?').get(conditionId) as any;
  if (!row) return null;
  return {
    conditionId: row.condition_id,
    slug: row.slug ?? undefined,
    title: row.title ?? undefined,
    volume24h: row.volume_24h ?? undefined,
    tokenIds: (JSON.parse(row.token_ids || '[]') as unknown[])
      .map((tokenId) => String(tokenId ?? '').trim())
      .filter(Boolean),
    outcomes: (JSON.parse(row.outcomes || '[]') as unknown[]).map((outcome) => String(outcome)),
    updatedAt: row.updated_at,
  };
};

// ---------------------------------------------------------------------------
// STATS AGGREGATION (runs on schedule, e.g. every 5 min)
// ---------------------------------------------------------------------------

export const aggregateStats = (): void => {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const walletRows = db.prepare(`
    SELECT address
    FROM discovery_wallets
    WHERE address IS NOT NULL AND address != ''
  `).all() as { address: string }[];

  refreshWalletStats(walletRows.map((row) => row.address), now);
};

export const refreshWalletStats = (
  addresses: string[],
  nowSeconds = Math.floor(Date.now() / 1000),
): void => {
  const normalizedAddresses = [...new Set(
    addresses
      .map((address) => String(address || '').trim().toLowerCase())
      .filter(Boolean)
  )];
  if (normalizedAddresses.length === 0) return;

  const db = getDatabase();
  const sevenDaysAgo = nowSeconds - 7 * 86400;
  const fourteenDaysAgo = nowSeconds - 14 * 86400;
  const updateStmt = db.prepare(`
    UPDATE discovery_wallets SET
      trade_count_7d = ?, volume_7d = ?, volume_prev_7d = ?,
      high_information_volume_7d = ?, focus_category = ?, largest_trade = ?, unique_markets_7d = ?, avg_trade_size = ?,
      updated_at = ?
    WHERE address = ?
  `);

  const tx = db.transaction(() => {
    for (const address of normalizedAddresses) {
      const sevenDMs = sevenDaysAgo * 1000;
      const fourteenDMs = fourteenDaysAgo * 1000;
      const trades = db.prepare(`
        SELECT
          condition_id,
          market_slug,
          market_title,
          price,
          size,
          notional_usd,
          detected_at
        FROM discovery_trades
        WHERE maker = ? AND detected_at > ?
      `).all(address, fourteenDMs) as Array<{
        condition_id?: string;
        market_slug?: string;
        market_title?: string;
        price?: number | null;
        size?: number | null;
        notional_usd?: number | null;
        detected_at: number;
      }>;

      const summary = summarizePrimaryDiscoveryTrades(trades, sevenDMs);

      updateStmt.run(
        summary.tradeCount7d,
        summary.volume7d,
        summary.volumePrev7d,
        summary.highInformationVolume7d,
        summary.focusCategory ?? null,
        summary.largestTrade,
        summary.uniqueMarkets7d,
        summary.avgTradeSize,
        nowSeconds, address,
      );
    }
  });
  tx();
};

const summarizePrimaryDiscoveryTrades = (
  trades: Array<{
    condition_id?: string;
    market_slug?: string;
    market_title?: string;
    price?: number | null;
    size?: number | null;
    notional_usd?: number | null;
    detected_at: number;
  }>,
  sevenDaysAgoMs: number,
): {
  tradeCount7d: number;
  volume7d: number;
  volumePrev7d: number;
  highInformationVolume7d: number;
  focusCategory?: DiscoveryMarketCategory;
  largestTrade: number;
  uniqueMarkets7d: number;
  avgTradeSize: number;
} => {
  let tradeCount7d = 0;
  let volume7d = 0;
  let volumePrev7d = 0;
  let highInformationVolume7d = 0;
  let largestTrade = 0;
  const uniqueMarkets = new Set<string>();
  const categoryVolumes = new Map<DiscoveryMarketCategory, number>();

  for (const trade of trades) {
    const classification = classifyDiscoveryMarket({
      title: trade.market_title,
      slug: trade.market_slug,
    });
    if (!classification.primaryDiscoveryEligible) continue;

    const notional = getStoredTradeNotional(trade);
    if (trade.detected_at > sevenDaysAgoMs) {
      tradeCount7d++;
      volume7d += notional;
      largestTrade = Math.max(largestTrade, notional);
      if (trade.condition_id) uniqueMarkets.add(trade.condition_id);
      if (classification.highInformationPriority) highInformationVolume7d += notional;
      const category = classification.category ?? 'event';
      categoryVolumes.set(category, (categoryVolumes.get(category) ?? 0) + notional);
      continue;
    }

    volumePrev7d += notional;
  }

  let focusCategory: DiscoveryMarketCategory | undefined;
  let focusCategoryVolume = 0;
  for (const [category, totalVolume] of categoryVolumes.entries()) {
    if (totalVolume <= focusCategoryVolume) continue;
    focusCategory = category;
    focusCategoryVolume = totalVolume;
  }

  return {
    tradeCount7d,
    volume7d,
    volumePrev7d,
    highInformationVolume7d,
    focusCategory,
    largestTrade,
    uniqueMarkets7d: uniqueMarkets.size,
    avgTradeSize: tradeCount7d > 0 ? volume7d / tradeCount7d : 0,
  };
};

const getStoredTradeNotional = (trade: {
  price?: number | null;
  size?: number | null;
  notional_usd?: number | null;
}): number => {
  if (Number.isFinite(trade.notional_usd) && Number(trade.notional_usd) > 0) {
    return Number(trade.notional_usd);
  }
  if (Number.isFinite(trade.price) && Number.isFinite(trade.size)) {
    return Number(trade.price) * Number(trade.size);
  }
  return Number(trade.size ?? 0);
};

// ---------------------------------------------------------------------------
// DATA RETENTION
// ---------------------------------------------------------------------------

export const purgeOldTrades = (olderThanDays: number): number => {
  const db = getDatabase();
  const cutoff = (Date.now() - olderThanDays * 86400 * 1000);
  const result = db.prepare('DELETE FROM discovery_trades WHERE detected_at < ?').run(cutoff);
  return result.changes;
};

export const purgeAllDiscoveryData = (): {
  trades: number;
  tradeFactsV2: number;
  wallets: number;
  walletsV2: number;
  walletFeaturesV2: number;
  marketUniverseV2: number;
  alertsV2: number;
  watchlist: number;
  positions: number;
  signals: number;
  marketCache: number;
  evaluations: number;
  evalObservations: number;
  costs: number;
  total: number;
} => {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const trades = db.prepare('DELETE FROM discovery_trades').run().changes;
    const tradeFactsV2 = db.prepare('DELETE FROM discovery_trade_facts_v2').run().changes;
    const wallets = db.prepare('DELETE FROM discovery_wallets').run().changes;
    const walletsV2 = db.prepare('DELETE FROM discovery_wallet_scores_v2').run().changes;
    const walletFeaturesV2 = db.prepare('DELETE FROM discovery_wallet_features_v2').run().changes;
    const marketUniverseV2 = db.prepare('DELETE FROM discovery_market_universe_v2').run().changes;
    const alertsV2 = db.prepare('DELETE FROM discovery_alerts_v2').run().changes;
    const watchlist = db.prepare('DELETE FROM discovery_watchlist').run().changes;
    const positions = db.prepare('DELETE FROM discovery_positions').run().changes;
    const signals = db.prepare('DELETE FROM discovery_signals').run().changes;
    const marketCache = db.prepare('DELETE FROM discovery_market_cache').run().changes;
    const evaluations = db.prepare('DELETE FROM discovery_eval_snapshots_v2').run().changes;
    const evalObservations = db.prepare('DELETE FROM discovery_eval_observations_v2').run().changes;
    const costs = db.prepare('DELETE FROM discovery_cost_snapshots_v2').run().changes;
    return {
      trades,
      tradeFactsV2,
      wallets,
      walletsV2,
      walletFeaturesV2,
      marketUniverseV2,
      alertsV2,
      watchlist,
      positions,
      signals,
      marketCache,
      evaluations,
      evalObservations,
      costs,
      total: trades +
        tradeFactsV2 +
        wallets +
        walletsV2 +
        walletFeaturesV2 +
        marketUniverseV2 +
        alertsV2 +
        watchlist +
        positions +
        signals +
        marketCache +
        evaluations +
        evalObservations +
        costs,
    };
  });
  return tx();
};

export const runRetentionCleanup = (): number => {
  const cfg = getDiscoveryConfig();
  return purgeOldTrades(cfg.retentionDays);
};

// ---------------------------------------------------------------------------
// POSITIONS
// ---------------------------------------------------------------------------

export const upsertPosition = (
  address: string,
  conditionId: string,
  assetId: string,
  side: string,
  size: number,
  price: number,
  outcome?: string,
  marketTitle?: string,
  marketSlug?: string,
): void => {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const cost = size * price;

  const existing = db.prepare(
    'SELECT shares, avg_entry, total_cost, total_trades FROM discovery_positions WHERE address = ? AND condition_id = ? AND asset_id = ?'
  ).get(address, conditionId, assetId) as { shares: number; avg_entry: number; total_cost: number; total_trades: number } | undefined;

  if (!existing) {
    db.prepare(`
      INSERT INTO discovery_positions (address, condition_id, asset_id, outcome, market_slug, market_title, side, shares, avg_entry, total_cost, total_trades, first_entry, last_entry, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(address, conditionId, assetId, outcome ?? null, marketSlug ?? null, marketTitle ?? null, side, size, price, cost, now, now, now);
    return;
  }

  if (side === 'BUY') {
    const newShares = existing.shares + size;
    const newCost = existing.total_cost + cost;
    const newAvg = newShares > 0 ? newCost / newShares : 0;
    db.prepare(`
      UPDATE discovery_positions SET
        shares = ?, avg_entry = ?, total_cost = ?, total_trades = total_trades + 1,
        last_entry = ?, side = 'BUY', outcome = COALESCE(?, outcome), market_title = COALESCE(?, market_title), market_slug = COALESCE(?, market_slug), updated_at = ?
      WHERE address = ? AND condition_id = ? AND asset_id = ?
    `).run(newShares, newAvg, newCost, now, outcome ?? null, marketTitle ?? null, marketSlug ?? null, now, address, conditionId, assetId);
  } else if (side === 'SELL') {
    const newShares = Math.max(0, existing.shares - size);
    const newCost = existing.total_trades > 0 ? existing.avg_entry * newShares : 0;
    db.prepare(`
      UPDATE discovery_positions SET
        shares = ?, total_cost = ?, total_trades = total_trades + 1,
        last_entry = ?, outcome = COALESCE(?, outcome), updated_at = ?
      WHERE address = ? AND condition_id = ? AND asset_id = ?
    `).run(newShares, newCost, now, outcome ?? null, now, address, conditionId, assetId);
  }
};

export const getPositionsByAddress = (address: string): WalletPosition[] => {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM discovery_positions WHERE address = ? ORDER BY total_cost DESC').all(address) as any[];
  return rows.map(rowToPosition);
};

export const getPositionsByConditionId = (conditionId: string): WalletPosition[] => {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM discovery_positions WHERE condition_id = ? ORDER BY total_cost DESC').all(conditionId) as any[];
  return rows.map(rowToPosition);
};

export const getSmartMoneyCountForMarket = (conditionId: string, scoreThreshold: number): number => {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT COUNT(DISTINCT dp.address) as cnt
    FROM discovery_positions dp
    JOIN discovery_wallets dw ON dp.address = dw.address
    WHERE dp.condition_id = ? AND dp.shares > 0 AND dw.whale_score > ?
  `).get(conditionId, scoreThreshold) as { cnt: number };
  return row?.cnt ?? 0;
};

export const getActivePositionKeys = (): Array<{ conditionId: string; assetId: string }> => {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT DISTINCT condition_id, asset_id FROM discovery_positions WHERE shares > 0')
    .all() as { condition_id: string; asset_id: string }[];
  return rows.map((r) => ({ conditionId: r.condition_id, assetId: r.asset_id }));
};

export const getPositionValue = (address: string, conditionId: string): number => {
  const db = getDatabase();
  const row = db
    .prepare('SELECT COALESCE(SUM(total_cost), 0) as total_cost FROM discovery_positions WHERE address = ? AND condition_id = ?')
    .get(address, conditionId) as { total_cost: number } | undefined;
  return row?.total_cost ?? 0;
};

export const batchUpdatePrices = (updates: { conditionId: string; assetId: string; price: number; outcome?: string }[]): void => {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    UPDATE discovery_positions SET
      current_price = ?,
      price_updated_at = ?,
      outcome = COALESCE(?, outcome),
      unrealized_pnl = (? - avg_entry) * shares,
      roi_pct = CASE WHEN total_cost > 0 THEN ((? - avg_entry) * shares) / total_cost * 100 ELSE 0 END,
      updated_at = ?
    WHERE condition_id = ? AND asset_id = ? AND shares > 0
  `);
  const tx = db.transaction(() => {
    for (const u of updates) {
      stmt.run(u.price, now, u.outcome ?? null, u.price, u.price, now, u.conditionId, u.assetId);
    }
  });
  tx();
};

const rowToPosition = (row: any): WalletPosition => ({
  id: row.id,
  address: row.address,
  conditionId: row.condition_id,
  assetId: row.asset_id,
  outcome: row.outcome ?? undefined,
  marketSlug: row.market_slug ?? undefined,
  marketTitle: row.market_title ?? undefined,
  side: row.side ?? undefined,
  shares: row.shares,
  avgEntry: row.avg_entry,
  totalCost: row.total_cost,
  totalTrades: row.total_trades,
  firstEntry: row.first_entry,
  lastEntry: row.last_entry,
  currentPrice: row.current_price ?? undefined,
  priceUpdatedAt: row.price_updated_at ?? undefined,
  unrealizedPnl: row.unrealized_pnl,
  roiPct: row.roi_pct,
  updatedAt: row.updated_at,
});

// ---------------------------------------------------------------------------
// SIGNALS
// ---------------------------------------------------------------------------

export const insertSignal = (signal: Omit<DiscoverySignal, 'id' | 'dismissed'>): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_signals (signal_type, severity, address, condition_id, market_title, title, description, metadata, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signal.signalType,
    signal.severity,
    signal.address,
    signal.conditionId ?? null,
    signal.marketTitle ?? null,
    signal.title,
    signal.description,
    signal.metadata ? JSON.stringify(signal.metadata) : null,
    signal.detectedAt,
  );

  db.prepare('UPDATE discovery_wallets SET last_signal_type = ?, last_signal_at = ? WHERE address = ?')
    .run(signal.signalType, signal.detectedAt, signal.address);
};

export const refreshWalletSignalState = (addresses: string[]): void => {
  const normalizedAddresses = [...new Set(
    addresses
      .map((address) => String(address || '').trim().toLowerCase())
      .filter(Boolean)
  )];
  if (normalizedAddresses.length === 0) return;

  const db = getDatabase();
  const latestSignalStmt = db.prepare(`
    SELECT signal_type, detected_at
    FROM discovery_signals
    WHERE address = ? AND dismissed = 0
    ORDER BY detected_at DESC
    LIMIT 1
  `);
  const updateStmt = db.prepare(`
    UPDATE discovery_wallets
    SET last_signal_type = ?, last_signal_at = ?
    WHERE address = ?
  `);

  const tx = db.transaction(() => {
    for (const address of normalizedAddresses) {
      const latest = latestSignalStmt.get(address) as { signal_type: string; detected_at: number } | undefined;
      updateStmt.run(latest?.signal_type ?? null, latest?.detected_at ?? null, address);
    }
  });
  tx();
};

export const signalExistsRecently = (signalType: string, address: string, conditionId: string | undefined, hoursBack: number): boolean => {
  const db = getDatabase();
  const cutoff = Date.now() - hoursBack * 3600 * 1000;
  const row = conditionId
    ? db.prepare('SELECT 1 FROM discovery_signals WHERE signal_type = ? AND address = ? AND condition_id = ? AND detected_at > ?').get(signalType, address, conditionId, cutoff)
    : db.prepare('SELECT 1 FROM discovery_signals WHERE signal_type = ? AND address = ? AND detected_at > ?').get(signalType, address, cutoff);
  return !!row;
};

export const getSignalCountToday = (): number => {
  const db = getDatabase();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM discovery_signals WHERE detected_at > ?')
    .get(todayStart.getTime()) as { cnt: number };
  return row?.cnt ?? 0;
};

export const getRecentSignals = (limit: number, offset: number, filters?: { severity?: string; signalType?: string }): DiscoverySignal[] => {
  const db = getDatabase();
  let sql = 'SELECT * FROM discovery_signals WHERE dismissed = 0';
  const params: any[] = [];
  if (filters?.severity) {
    sql += ' AND severity = ?';
    params.push(filters.severity);
  }
  if (filters?.signalType) {
    sql += ' AND signal_type = ?';
    params.push(filters.signalType);
  }
  sql += ' ORDER BY detected_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToSignal).filter(shouldExposeDiscoverySignal);
};

export const getSignalsForAddress = (address: string, limit = 20): DiscoverySignal[] => {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM discovery_signals WHERE address = ? AND dismissed = 0 ORDER BY detected_at DESC LIMIT ?'
  ).all(address, limit) as any[];
  return rows.map(rowToSignal);
};

export const getUnusualMarkets = (days: number): any[] => {
  const db = getDatabase();
  const cutoff = Date.now() - days * 86400 * 1000;
  return db.prepare(`
    SELECT condition_id, market_title,
      COUNT(*) as signal_count,
      GROUP_CONCAT(DISTINCT address) as wallets,
      GROUP_CONCAT(DISTINCT signal_type) as signal_types,
      MIN(detected_at) as first_detected,
      MAX(detected_at) as last_detected
    FROM discovery_signals
    WHERE signal_type IN ('MARKET_PIONEER', 'COORDINATED_ENTRY')
      AND detected_at > ? AND condition_id IS NOT NULL
    GROUP BY condition_id
    ORDER BY signal_count DESC, last_detected DESC
  `).all(cutoff) as any[];
};

export const dismissSignal = (id: number): void => {
  const db = getDatabase();
  const row = db.prepare('SELECT address FROM discovery_signals WHERE id = ?').get(id) as { address?: string } | undefined;
  db.prepare('UPDATE discovery_signals SET dismissed = 1 WHERE id = ?').run(id);
  if (row?.address) refreshWalletSignalState([row.address]);
};

export const cleanupOldSignals = (days: number): number => {
  const db = getDatabase();
  const cutoff = Date.now() - days * 86400 * 1000;
  const addresses = db.prepare('SELECT DISTINCT address FROM discovery_signals WHERE detected_at < ?').all(cutoff) as { address: string }[];
  const result = db.prepare('DELETE FROM discovery_signals WHERE detected_at < ?').run(cutoff);
  refreshWalletSignalState(addresses.map((row) => row.address));
  return result.changes;
};

export const cleanupStalePositions = (days: number): number => {
  const db = getDatabase();
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const result = db.prepare('DELETE FROM discovery_positions WHERE shares = 0 AND updated_at < ?').run(cutoff);
  return result.changes;
};

const rowToSignal = (row: any): DiscoverySignal => ({
  id: row.id,
  signalType: row.signal_type as SignalType,
  severity: row.severity as SignalSeverity,
  address: row.address,
  conditionId: row.condition_id ?? undefined,
  marketTitle: row.market_title ?? undefined,
  title: row.title,
  description: row.description,
  metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  detectedAt: row.detected_at,
  dismissed: row.dismissed === 1,
});

export const shouldExposeDiscoverySignal = (signal: Pick<DiscoverySignal, 'signalType' | 'severity' | 'metadata'>): boolean => {
  if (signal.signalType !== 'SIZE_ANOMALY') return true;
  const meta = signal.metadata || {};
  const notional = Number((meta as any).notionalUsd ?? (meta as any).tradeSize ?? 0);
  return (signal.severity === 'high' || signal.severity === 'critical') && Number.isFinite(notional) && notional >= 5000;
};
