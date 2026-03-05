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
  WalletStats,
  MarketCacheEntry,
  DiscoveryConfig,
  DEFAULT_DISCOVERY_CONFIG,
} from './types.js';

// ---------------------------------------------------------------------------
// DISCOVERY CONFIG (runtime-editable, persisted in SQLite)
// ---------------------------------------------------------------------------

export const getDiscoveryConfig = (): DiscoveryConfig => {
  const db = getDatabase();
  const rows = db.prepare('SELECT key, value FROM discovery_config').all() as { key: string; value: string }[];

  const stored: Record<string, string> = {};
  for (const row of rows) {
    stored[row.key] = row.value;
  }

  return {
    enabled: stored.enabled !== undefined ? stored.enabled === 'true' : config.discoveryEnabled,
    alchemyWsUrl: stored.alchemyWsUrl ?? config.discoveryAlchemyWsUrl,
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
        upsert.run(key, String(value));
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
        (tx_hash, maker, taker, asset_id, condition_id, market_slug, market_title, side, size, price, fee, source, detected_at, block_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.txHash,
      trade.maker,
      trade.taker,
      trade.assetId,
      trade.conditionId ?? null,
      trade.marketSlug ?? null,
      trade.marketTitle ?? null,
      trade.side ?? null,
      trade.size,
      trade.price ?? null,
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
      (tx_hash, maker, taker, asset_id, condition_id, market_slug, market_title, side, size, price, fee, source, detected_at, block_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const t of trades) {
      const result = stmt.run(
        t.txHash, t.maker, t.taker, t.assetId,
        t.conditionId ?? null, t.marketSlug ?? null, t.marketTitle ?? null,
        t.side ?? null, t.size, t.price ?? null, t.fee, t.source, t.detectedAt, t.blockNumber ?? null,
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

export const getTotalTradeCount = (): number => {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM discovery_trades').get() as { cnt: number };
  return row.cnt;
};

// ---------------------------------------------------------------------------
// WALLETS
// ---------------------------------------------------------------------------

export const upsertWallet = (address: string, detectedAt: number): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_wallets (address, first_seen, last_active, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      last_active = MAX(last_active, excluded.last_active),
      updated_at = excluded.updated_at
  `).run(address, detectedAt, detectedAt, Math.floor(Date.now() / 1000));
};

export const getWalletStats = (address: string): WalletStats | null => {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM discovery_wallets WHERE address = ?').get(address) as any;
  if (!row) return null;
  return rowToWalletStats(row);
};

export const getTopWallets = (
  sort: 'volume' | 'trades' | 'recent' = 'volume',
  limit = 50,
  offset = 0,
): WalletStats[] => {
  const db = getDatabase();
  const orderMap: Record<string, string> = {
    volume: 'volume_7d DESC',
    trades: 'trade_count_7d DESC',
    recent: 'last_active DESC',
  };
  const orderBy = orderMap[sort] || 'volume_7d DESC';
  const rows = db.prepare(
    `SELECT * FROM discovery_wallets ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).all(limit, offset) as any[];
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

const rowToWalletStats = (row: any): WalletStats => ({
  address: row.address,
  pseudonym: row.pseudonym ?? undefined,
  firstSeen: row.first_seen,
  lastActive: row.last_active,
  tradeCount7d: row.trade_count_7d,
  volume7d: row.volume_7d,
  volumePrev7d: row.volume_prev_7d,
  largestTrade: row.largest_trade,
  uniqueMarkets7d: row.unique_markets_7d,
  avgTradeSize: row.avg_trade_size,
  isTracked: row.is_tracked === 1,
  updatedAt: row.updated_at,
});

// ---------------------------------------------------------------------------
// MARKET CACHE
// ---------------------------------------------------------------------------

export const upsertMarketCache = (entry: MarketCacheEntry): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_market_cache (condition_id, slug, title, volume_24h, token_ids, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(condition_id) DO UPDATE SET
      slug = excluded.slug,
      title = excluded.title,
      volume_24h = excluded.volume_24h,
      token_ids = excluded.token_ids,
      updated_at = excluded.updated_at
  `).run(
    entry.conditionId,
    entry.slug ?? null,
    entry.title ?? null,
    entry.volume24h ?? null,
    JSON.stringify(entry.tokenIds),
    entry.updatedAt,
  );
};

export const getMarketByAssetId = (assetId: string): MarketCacheEntry | null => {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM discovery_market_cache').all() as any[];
  for (const row of rows) {
    const tokenIds: string[] = JSON.parse(row.token_ids || '[]');
    if (tokenIds.includes(assetId)) {
      return {
        conditionId: row.condition_id,
        slug: row.slug ?? undefined,
        title: row.title ?? undefined,
        volume24h: row.volume_24h ?? undefined,
        tokenIds,
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
    tokenIds: JSON.parse(row.token_ids || '[]'),
    updatedAt: row.updated_at,
  };
};

// ---------------------------------------------------------------------------
// STATS AGGREGATION (runs on schedule, e.g. every 5 min)
// ---------------------------------------------------------------------------

export const aggregateStats = (): void => {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 86400;
  const fourteenDaysAgo = now - 14 * 86400;

  // Get all unique wallet addresses from recent trades (both maker and taker)
  const walletRows = db.prepare(`
    SELECT DISTINCT address FROM (
      SELECT maker AS address FROM discovery_trades WHERE detected_at > ?
      UNION
      SELECT taker AS address FROM discovery_trades WHERE detected_at > ?
    )
  `).all(fourteenDaysAgo * 1000, fourteenDaysAgo * 1000) as { address: string }[];

  const updateStmt = db.prepare(`
    UPDATE discovery_wallets SET
      trade_count_7d = ?, volume_7d = ?, volume_prev_7d = ?,
      largest_trade = ?, unique_markets_7d = ?, avg_trade_size = ?,
      updated_at = ?
    WHERE address = ?
  `);

  const tx = db.transaction(() => {
    for (const { address } of walletRows) {
      const sevenDMs = sevenDaysAgo * 1000;
      const fourteenDMs = fourteenDaysAgo * 1000;

      // 7d stats
      const stats7d = db.prepare(`
        SELECT
          COUNT(*) as cnt,
          COALESCE(SUM(size), 0) as vol,
          COALESCE(MAX(size), 0) as maxTrade,
          COUNT(DISTINCT asset_id) as markets,
          COALESCE(AVG(size), 0) as avgSize
        FROM discovery_trades
        WHERE (maker = ? OR taker = ?) AND detected_at > ?
      `).get(address, address, sevenDMs) as any;

      // Previous 7d volume (for spike detection)
      const prev7d = db.prepare(`
        SELECT COALESCE(SUM(size), 0) as vol
        FROM discovery_trades
        WHERE (maker = ? OR taker = ?) AND detected_at > ? AND detected_at <= ?
      `).get(address, address, fourteenDMs, sevenDMs) as any;

      updateStmt.run(
        stats7d.cnt, stats7d.vol, prev7d.vol,
        stats7d.maxTrade, stats7d.markets, stats7d.avgSize,
        now, address,
      );
    }
  });
  tx();
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

export const runRetentionCleanup = (): number => {
  const cfg = getDiscoveryConfig();
  return purgeOldTrades(cfg.retentionDays);
};
