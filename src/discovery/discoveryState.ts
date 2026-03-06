import { DiscoveredTrade } from './types.js';
import { getDiscoveryDatabase } from './discoveryDatabase.js';

type WalletStateRow = {
  address: string;
  trade_count: number;
  total_volume: number;
  last_trade_at?: number;
};

type MarketStateRow = {
  condition_id: string;
  trade_count: number;
  total_volume: number;
  last_trade_at?: number;
};

type WalletMarketStateRow = {
  address: string;
  condition_id: string;
  trade_count: number;
  total_volume: number;
  last_trade_at?: number;
};

export const applyDiscoveredTradesToState = (trades: DiscoveredTrade[]): void => {
  if (trades.length === 0) return;

  const db = getDiscoveryDatabase();
  const upsertWalletState = db.prepare(`
    INSERT INTO discovery_wallet_state (address, trade_count, total_volume, last_trade_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      trade_count = discovery_wallet_state.trade_count + excluded.trade_count,
      total_volume = discovery_wallet_state.total_volume + excluded.total_volume,
      last_trade_at = MAX(discovery_wallet_state.last_trade_at, excluded.last_trade_at),
      updated_at = excluded.updated_at
  `);
  const upsertMarketState = db.prepare(`
    INSERT INTO discovery_market_state (condition_id, trade_count, total_volume, last_trade_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(condition_id) DO UPDATE SET
      trade_count = discovery_market_state.trade_count + excluded.trade_count,
      total_volume = discovery_market_state.total_volume + excluded.total_volume,
      last_trade_at = MAX(discovery_market_state.last_trade_at, excluded.last_trade_at),
      updated_at = excluded.updated_at
  `);
  const upsertWalletMarketState = db.prepare(`
    INSERT INTO discovery_wallet_market_state (address, condition_id, trade_count, total_volume, last_trade_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(address, condition_id) DO UPDATE SET
      trade_count = discovery_wallet_market_state.trade_count + excluded.trade_count,
      total_volume = discovery_wallet_market_state.total_volume + excluded.total_volume,
      last_trade_at = MAX(discovery_wallet_market_state.last_trade_at, excluded.last_trade_at),
      updated_at = excluded.updated_at
  `);

  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    for (const trade of trades) {
      const address = String(trade.maker || '').trim().toLowerCase();
      const conditionId = String(trade.conditionId || '').trim();
      const totalVolume = Number(trade.notionalUsd ?? (trade.price !== undefined ? trade.price * trade.size : 0));
      if (!address || !conditionId || !Number.isFinite(totalVolume)) continue;

      upsertWalletState.run(address, 1, totalVolume, trade.detectedAt, now);
      upsertMarketState.run(conditionId, 1, totalVolume, trade.detectedAt, now);
      upsertWalletMarketState.run(address, conditionId, 1, totalVolume, trade.detectedAt, now);
    }
  });

  tx();
};

export const getWalletState = (address: string) => {
  const db = getDiscoveryDatabase();
  const row = db.prepare(
    'SELECT address, trade_count, total_volume, last_trade_at FROM discovery_wallet_state WHERE address = ?'
  ).get(address.toLowerCase()) as WalletStateRow | undefined;

  if (!row) return null;

  return {
    address: row.address,
    tradeCount: row.trade_count,
    totalVolume: row.total_volume,
    lastTradeAt: row.last_trade_at,
  };
};

export const getMarketState = (conditionId: string) => {
  const db = getDiscoveryDatabase();
  const row = db.prepare(
    'SELECT condition_id, trade_count, total_volume, last_trade_at FROM discovery_market_state WHERE condition_id = ?'
  ).get(conditionId) as MarketStateRow | undefined;

  if (!row) return null;

  return {
    conditionId: row.condition_id,
    tradeCount: row.trade_count,
    totalVolume: row.total_volume,
    lastTradeAt: row.last_trade_at,
  };
};

export const getWalletMarketState = (address: string, conditionId: string) => {
  const db = getDiscoveryDatabase();
  const row = db.prepare(`
    SELECT address, condition_id, trade_count, total_volume, last_trade_at
    FROM discovery_wallet_market_state
    WHERE address = ? AND condition_id = ?
  `).get(address.toLowerCase(), conditionId) as WalletMarketStateRow | undefined;

  if (!row) return null;

  return {
    address: row.address,
    conditionId: row.condition_id,
    tradeCount: row.trade_count,
    totalVolume: row.total_volume,
    lastTradeAt: row.last_trade_at,
  };
};
