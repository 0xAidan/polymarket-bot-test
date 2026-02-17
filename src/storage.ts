import { promises as fs } from 'fs';
import path from 'path';
import { 
  TrackedWallet, 
  TradeSideFilter,
  NoRepeatTradesConfig,
  PriceLimitsConfig,
  RateLimitingConfig,
  TradeValueFiltersConfig,
  ExecutedPosition
} from './types.js';
import { config } from './config.js';
import {
  initDatabase,
  dbLoadTrackedWallets,
  dbSaveTrackedWallets,
  dbLoadConfig,
  dbSaveConfig,
  dbLoadExecutedPositions,
  dbSaveExecutedPositions,
} from './database.js';

// Use getters so tests can patch config.dataDir at runtime
function walletsFile() { return path.join(config.dataDir, 'tracked_wallets.json'); }
function configFile() { return path.join(config.dataDir, 'bot_config.json'); }
function executedPositionsFile() { return path.join(config.dataDir, 'executed_positions.json'); }

// ============================================================================
// DEFAULT VALUES FOR NEW CONFIGURATION OPTIONS
// ============================================================================

const DEFAULT_NO_REPEAT_TRADES: NoRepeatTradesConfig = {
  enabled: false,
  blockPeriodHours: 24
};

const DEFAULT_PRICE_LIMITS: PriceLimitsConfig = {
  minPrice: 0.01,
  maxPrice: 0.99
};

const DEFAULT_SLIPPAGE_PERCENT = 2; // 2%

const DEFAULT_TRADE_SIDE_FILTER: TradeSideFilter = 'all';

const DEFAULT_RATE_LIMITING: RateLimitingConfig = {
  enabled: false,
  maxTradesPerHour: 10,
  maxTradesPerDay: 50
};

const DEFAULT_TRADE_VALUE_FILTERS: TradeValueFiltersConfig = {
  enabled: false,
  minTradeValueUSD: null,
  maxTradeValueUSD: null
};

// ============================================================================
// DUAL-BACKEND HELPER
// ============================================================================

/** True when SQLite is selected and available */
function useSqlite(): boolean {
  return config.storageBackend === 'sqlite';
}

/** Lazy-init SQLite. Returns true on success, false on failure (falls back to JSON). */
async function ensureSqlite(): Promise<boolean> {
  try {
    await initDatabase();
    return true;
  } catch (err) {
    console.error('[Storage] SQLite init failed, falling back to JSON:', err);
    return false;
  }
}

/**
 * Storage manager for tracked wallets.
 * Dual-backend: dispatches to JSON or SQLite based on config.storageBackend.
 * If SQLite init fails, automatically falls back to JSON.
 */
export class Storage {
  /**
   * Ensure data directory exists
   */
  static async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(config.dataDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create data directory:', error);
      throw error;
    }
  }

  // ============================================================================
  // TRACKED WALLETS
  // ============================================================================

  private static async _loadTrackedWalletsJson(): Promise<TrackedWallet[]> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(walletsFile(), 'utf-8');
      const wallets = JSON.parse(data);
      return wallets.map((w: any) => ({
        ...w,
        addedAt: new Date(w.addedAt),
        lastSeen: w.lastSeen ? new Date(w.lastSeen) : undefined
      }));
    } catch (error: any) {
      if (error.code === 'ENOENT') return [];
      console.error('Failed to load tracked wallets:', error);
      throw error;
    }
  }

  private static async _loadTrackedWalletsSqlite(): Promise<TrackedWallet[]> {
    return dbLoadTrackedWallets();
  }

  static async loadTrackedWallets(): Promise<TrackedWallet[]> {
    if (useSqlite() && await ensureSqlite()) {
      return this._loadTrackedWalletsSqlite();
    }
    return this._loadTrackedWalletsJson();
  }

  private static async _saveTrackedWalletsJson(wallets: TrackedWallet[]): Promise<void> {
    await this.ensureDataDir();
    await fs.writeFile(walletsFile(), JSON.stringify(wallets, null, 2));
  }

  private static async _saveTrackedWalletsSqlite(wallets: TrackedWallet[]): Promise<void> {
    dbSaveTrackedWallets(wallets);
  }

  static async saveTrackedWallets(wallets: TrackedWallet[]): Promise<void> {
    try {
      if (useSqlite() && await ensureSqlite()) {
        return this._saveTrackedWalletsSqlite(wallets);
      }
      return this._saveTrackedWalletsJson(wallets);
    } catch (error) {
      console.error('Failed to save tracked wallets:', error);
      throw error;
    }
  }

  static async addWallet(address: string): Promise<TrackedWallet> {
    const wallets = await this.loadTrackedWallets();
    
    if (wallets.find(w => w.address.toLowerCase() === address.toLowerCase())) {
      throw new Error('Wallet already being tracked');
    }

    const newWallet: TrackedWallet = {
      address: address.toLowerCase(),
      addedAt: new Date(),
      active: false
    };
    
    wallets.push(newWallet);
    await this.saveTrackedWallets(wallets);
    
    return newWallet;
  }

  static async removeWallet(address: string): Promise<void> {
    const wallets = await this.loadTrackedWallets();
    const filtered = wallets.filter(
      w => w.address.toLowerCase() !== address.toLowerCase()
    );
    await this.saveTrackedWallets(filtered);
  }

  static async getActiveWallets(): Promise<TrackedWallet[]> {
    const wallets = await this.loadTrackedWallets();
    return wallets.filter(w => w.active);
  }

  static async toggleWalletActive(address: string, active?: boolean): Promise<TrackedWallet> {
    const wallets = await this.loadTrackedWallets();
    const wallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    wallet.active = active !== undefined ? active : !wallet.active;
    await this.saveTrackedWallets(wallets);
    return wallet;
  }

  static async updateWalletLabel(address: string, label: string): Promise<TrackedWallet> {
    const wallets = await this.loadTrackedWallets();
    const wallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    wallet.label = label.trim() || undefined;
    await this.saveTrackedWallets(wallets);
    return wallet;
  }

  static async updateWalletTags(address: string, tags: string[]): Promise<TrackedWallet> {
    const wallets = await this.loadTrackedWallets();
    const wallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());

    if (!wallet) {
      throw new Error('Wallet not found');
    }

    // Normalize: lowercase, trim, deduplicate, remove empty
    const normalizedTags = [...new Set(
      tags.map(t => t.trim().toLowerCase()).filter(t => t.length > 0)
    )];
    wallet.tags = normalizedTags.length > 0 ? normalizedTags : undefined;
    await this.saveTrackedWallets(wallets);
    return wallet;
  }

  static async updateWalletTradeConfig(
    address: string,
    walletConfig: {
      tradeSizingMode?: 'fixed' | 'proportional' | null;
      fixedTradeSize?: number | null;
      thresholdEnabled?: boolean | null;
      thresholdPercent?: number | null;
      tradeSideFilter?: TradeSideFilter | null;
      noRepeatEnabled?: boolean | null;
      noRepeatPeriodHours?: number | null;
      priceLimitsMin?: number | null;
      priceLimitsMax?: number | null;
      rateLimitEnabled?: boolean | null;
      rateLimitPerHour?: number | null;
      rateLimitPerDay?: number | null;
      valueFilterEnabled?: boolean | null;
      valueFilterMin?: number | null;
      valueFilterMax?: number | null;
      slippagePercent?: number | null;
    }
  ): Promise<TrackedWallet> {
    const wallets = await this.loadTrackedWallets();
    const wallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    const updateField = <T>(current: T | undefined, newVal: T | null | undefined): T | undefined => {
      if (newVal === undefined) return current;
      if (newVal === null) return undefined;
      return newVal;
    };

    wallet.tradeSizingMode = updateField(wallet.tradeSizingMode, walletConfig.tradeSizingMode);
    wallet.fixedTradeSize = updateField(wallet.fixedTradeSize, walletConfig.fixedTradeSize);
    wallet.thresholdEnabled = updateField(wallet.thresholdEnabled, walletConfig.thresholdEnabled);
    wallet.thresholdPercent = updateField(wallet.thresholdPercent, walletConfig.thresholdPercent);
    wallet.tradeSideFilter = updateField(wallet.tradeSideFilter, walletConfig.tradeSideFilter);
    wallet.noRepeatEnabled = updateField(wallet.noRepeatEnabled, walletConfig.noRepeatEnabled);
    wallet.noRepeatPeriodHours = updateField(wallet.noRepeatPeriodHours, walletConfig.noRepeatPeriodHours);
    wallet.priceLimitsMin = updateField(wallet.priceLimitsMin, walletConfig.priceLimitsMin);
    wallet.priceLimitsMax = updateField(wallet.priceLimitsMax, walletConfig.priceLimitsMax);
    wallet.rateLimitEnabled = updateField(wallet.rateLimitEnabled, walletConfig.rateLimitEnabled);
    wallet.rateLimitPerHour = updateField(wallet.rateLimitPerHour, walletConfig.rateLimitPerHour);
    wallet.rateLimitPerDay = updateField(wallet.rateLimitPerDay, walletConfig.rateLimitPerDay);
    wallet.valueFilterEnabled = updateField(wallet.valueFilterEnabled, walletConfig.valueFilterEnabled);
    wallet.valueFilterMin = updateField(wallet.valueFilterMin, walletConfig.valueFilterMin);
    wallet.valueFilterMax = updateField(wallet.valueFilterMax, walletConfig.valueFilterMax);
    wallet.slippagePercent = updateField(wallet.slippagePercent, walletConfig.slippagePercent);

    await this.saveTrackedWallets(wallets);
    return wallet;
  }

  static async clearWalletTradeConfig(address: string): Promise<TrackedWallet> {
    return this.updateWalletTradeConfig(address, {
      tradeSizingMode: null,
      fixedTradeSize: null,
      thresholdEnabled: null,
      thresholdPercent: null,
      tradeSideFilter: null,
      noRepeatEnabled: null,
      noRepeatPeriodHours: null,
      priceLimitsMin: null,
      priceLimitsMax: null,
      rateLimitEnabled: null,
      rateLimitPerHour: null,
      rateLimitPerDay: null,
      valueFilterEnabled: null,
      valueFilterMin: null,
      valueFilterMax: null,
      slippagePercent: null
    });
  }

  // ============================================================================
  // BOT CONFIGURATION
  // ============================================================================

  private static async _loadConfigJson(): Promise<any> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(configFile(), 'utf-8');
      return JSON.parse(data);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { 
          tradeSize: '2',
          monitoringIntervalMs: 15000
        };
      }
      console.error('Failed to load bot config:', error);
      throw error;
    }
  }

  private static async _loadConfigSqlite(): Promise<any> {
    const data = dbLoadConfig();
    if (Object.keys(data).length === 0) {
      return {
        tradeSize: '2',
        monitoringIntervalMs: 15000
      };
    }
    return data;
  }

  static async loadConfig(): Promise<any> {
    if (useSqlite() && await ensureSqlite()) {
      return this._loadConfigSqlite();
    }
    return this._loadConfigJson();
  }

  private static async _saveConfigJson(configData: any): Promise<void> {
    await this.ensureDataDir();
    await fs.writeFile(configFile(), JSON.stringify(configData, null, 2));
  }

  private static async _saveConfigSqlite(configData: any): Promise<void> {
    dbSaveConfig(configData);
  }

  static async saveConfig(configData: any): Promise<void> {
    try {
      if (useSqlite() && await ensureSqlite()) {
        return this._saveConfigSqlite(configData);
      }
      return this._saveConfigJson(configData);
    } catch (error) {
      console.error('Failed to save bot config:', error);
      throw error;
    }
  }

  static async getTradeSize(): Promise<string> {
    const cfg = await this.loadConfig();
    return cfg.tradeSize || '2';
  }

  static async setTradeSize(size: string): Promise<void> {
    const cfg = await this.loadConfig();
    cfg.tradeSize = size;
    await this.saveConfig(cfg);
  }

  static async getMonitoringInterval(): Promise<number> {
    const cfg = await this.loadConfig();
    return cfg.monitoringIntervalMs || parseInt(process.env.MONITORING_INTERVAL_MS || '15000', 10);
  }

  static async setMonitoringInterval(intervalMs: number): Promise<void> {
    const cfg = await this.loadConfig();
    cfg.monitoringIntervalMs = intervalMs;
    await this.saveConfig(cfg);
  }

  static async getPositionThreshold(): Promise<{ enabled: boolean; percent: number }> {
    const cfg = await this.loadConfig();
    return {
      enabled: cfg.positionThresholdEnabled || false,
      percent: cfg.positionThresholdPercent || 10
    };
  }

  /** @deprecated Use per-wallet trade config instead (updateWalletTradeConfig) */
  static async setPositionThreshold(enabled: boolean, percent: number): Promise<void> {
    const cfg = await this.loadConfig();
    cfg.positionThresholdEnabled = enabled;
    cfg.positionThresholdPercent = percent;
    await this.saveConfig(cfg);
  }

  static async getUsageStopLoss(): Promise<{ enabled: boolean; maxCommitmentPercent: number }> {
    const cfg = await this.loadConfig();
    return {
      enabled: cfg.usageStopLossEnabled || false,
      maxCommitmentPercent: cfg.usageStopLossPercent || 80
    };
  }

  static async setUsageStopLoss(enabled: boolean, maxCommitmentPercent: number): Promise<void> {
    const cfg = await this.loadConfig();
    cfg.usageStopLossEnabled = enabled;
    cfg.usageStopLossPercent = maxCommitmentPercent;
    await this.saveConfig(cfg);
  }

  // ============================================================================
  // ADVANCED TRADE FILTER CONFIGURATION METHODS
  // ============================================================================

  static async getNoRepeatTrades(): Promise<NoRepeatTradesConfig> {
    const cfg = await this.loadConfig();
    return {
      enabled: cfg.noRepeatTradesEnabled ?? DEFAULT_NO_REPEAT_TRADES.enabled,
      blockPeriodHours: cfg.noRepeatTradesBlockPeriodHours ?? DEFAULT_NO_REPEAT_TRADES.blockPeriodHours
    };
  }

  static async setNoRepeatTrades(enabled: boolean, blockPeriodHours: number): Promise<void> {
    const cfg = await this.loadConfig();
    cfg.noRepeatTradesEnabled = enabled;
    cfg.noRepeatTradesBlockPeriodHours = blockPeriodHours;
    await this.saveConfig(cfg);
  }

  static async getPriceLimits(): Promise<PriceLimitsConfig> {
    const cfg = await this.loadConfig();
    return {
      minPrice: cfg.priceLimitsMin ?? DEFAULT_PRICE_LIMITS.minPrice,
      maxPrice: cfg.priceLimitsMax ?? DEFAULT_PRICE_LIMITS.maxPrice
    };
  }

  static async setPriceLimits(minPrice: number, maxPrice: number): Promise<void> {
    const cfg = await this.loadConfig();
    cfg.priceLimitsMin = minPrice;
    cfg.priceLimitsMax = maxPrice;
    await this.saveConfig(cfg);
  }

  static async getSlippagePercent(): Promise<number> {
    const cfg = await this.loadConfig();
    return cfg.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT;
  }

  static async setSlippagePercent(percent: number): Promise<void> {
    const cfg = await this.loadConfig();
    cfg.slippagePercent = percent;
    await this.saveConfig(cfg);
  }

  static async getTradeSideFilter(): Promise<TradeSideFilter> {
    const cfg = await this.loadConfig();
    return cfg.tradeSideFilter ?? DEFAULT_TRADE_SIDE_FILTER;
  }

  static async setTradeSideFilter(filter: TradeSideFilter): Promise<void> {
    const cfg = await this.loadConfig();
    cfg.tradeSideFilter = filter;
    await this.saveConfig(cfg);
  }

  static async getRateLimiting(): Promise<RateLimitingConfig> {
    const cfg = await this.loadConfig();
    return {
      enabled: cfg.rateLimitingEnabled ?? DEFAULT_RATE_LIMITING.enabled,
      maxTradesPerHour: cfg.rateLimitingMaxPerHour ?? DEFAULT_RATE_LIMITING.maxTradesPerHour,
      maxTradesPerDay: cfg.rateLimitingMaxPerDay ?? DEFAULT_RATE_LIMITING.maxTradesPerDay
    };
  }

  static async setRateLimiting(enabled: boolean, maxTradesPerHour: number, maxTradesPerDay: number): Promise<void> {
    const cfg = await this.loadConfig();
    cfg.rateLimitingEnabled = enabled;
    cfg.rateLimitingMaxPerHour = maxTradesPerHour;
    cfg.rateLimitingMaxPerDay = maxTradesPerDay;
    await this.saveConfig(cfg);
  }

  static async getTradeValueFilters(): Promise<TradeValueFiltersConfig> {
    const cfg = await this.loadConfig();
    return {
      enabled: cfg.tradeValueFiltersEnabled ?? DEFAULT_TRADE_VALUE_FILTERS.enabled,
      minTradeValueUSD: cfg.tradeValueFiltersMin ?? DEFAULT_TRADE_VALUE_FILTERS.minTradeValueUSD,
      maxTradeValueUSD: cfg.tradeValueFiltersMax ?? DEFAULT_TRADE_VALUE_FILTERS.maxTradeValueUSD
    };
  }

  static async setTradeValueFilters(
    enabled: boolean, 
    minTradeValueUSD: number | null, 
    maxTradeValueUSD: number | null
  ): Promise<void> {
    const cfg = await this.loadConfig();
    cfg.tradeValueFiltersEnabled = enabled;
    cfg.tradeValueFiltersMin = minTradeValueUSD;
    cfg.tradeValueFiltersMax = maxTradeValueUSD;
    await this.saveConfig(cfg);
  }

  // ============================================================================
  // EXECUTED POSITIONS TRACKING (for no-repeat-trades)
  // ============================================================================

  private static async _loadExecutedPositionsJson(): Promise<ExecutedPosition[]> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(executedPositionsFile(), 'utf-8');
      return JSON.parse(data);
    } catch (error: any) {
      if (error.code === 'ENOENT') return [];
      console.error('Failed to load executed positions:', error);
      throw error;
    }
  }

  private static async _loadExecutedPositionsSqlite(): Promise<ExecutedPosition[]> {
    return dbLoadExecutedPositions();
  }

  static async loadExecutedPositions(): Promise<ExecutedPosition[]> {
    if (useSqlite() && await ensureSqlite()) {
      return this._loadExecutedPositionsSqlite();
    }
    return this._loadExecutedPositionsJson();
  }

  private static async _saveExecutedPositionsJson(positions: ExecutedPosition[]): Promise<void> {
    await this.ensureDataDir();
    await fs.writeFile(executedPositionsFile(), JSON.stringify(positions, null, 2));
  }

  private static async _saveExecutedPositionsSqlite(positions: ExecutedPosition[]): Promise<void> {
    dbSaveExecutedPositions(positions);
  }

  static async saveExecutedPositions(positions: ExecutedPosition[]): Promise<void> {
    try {
      if (useSqlite() && await ensureSqlite()) {
        return this._saveExecutedPositionsSqlite(positions);
      }
      return this._saveExecutedPositionsJson(positions);
    } catch (error) {
      console.error('Failed to save executed positions:', error);
      throw error;
    }
  }

  static async addExecutedPosition(
    marketId: string, 
    side: 'YES' | 'NO', 
    walletAddress: string
  ): Promise<void> {
    const positions = await this.loadExecutedPositions();
    
    const existing = positions.find(
      p => p.marketId === marketId && p.side === side
    );
    
    if (!existing) {
      positions.push({
        marketId,
        side,
        timestamp: Date.now(),
        walletAddress: walletAddress.toLowerCase()
      });
      await this.saveExecutedPositions(positions);
    }
  }

  static async isPositionBlocked(
    marketId: string, 
    side: 'YES' | 'NO', 
    blockPeriodHours: number
  ): Promise<boolean> {
    const positions = await this.loadExecutedPositions();
    
    if (blockPeriodHours === 0) {
      return positions.some(
        p => p.marketId === marketId && p.side === side
      );
    }
    
    const blockPeriodMs = blockPeriodHours * 60 * 60 * 1000;
    const cutoffTime = Date.now() - blockPeriodMs;
    
    return positions.some(
      p => p.marketId === marketId && 
           p.side === side && 
           p.timestamp > cutoffTime
    );
  }

  static async getExecutedPositions(): Promise<ExecutedPosition[]> {
    return this.loadExecutedPositions();
  }

  static async clearExecutedPositions(): Promise<void> {
    await this.saveExecutedPositions([]);
  }

  static async cleanupExpiredPositions(blockPeriodHours: number): Promise<number> {
    if (blockPeriodHours === 0) return 0;
    
    const positions = await this.loadExecutedPositions();
    const blockPeriodMs = blockPeriodHours * 60 * 60 * 1000;
    const cutoffTime = Date.now() - blockPeriodMs;
    
    const validPositions = positions.filter(p => p.timestamp > cutoffTime);
    const removedCount = positions.length - validPositions.length;
    
    if (removedCount > 0) {
      await this.saveExecutedPositions(validPositions);
      console.log(`Cleaned up ${removedCount} expired executed position records`);
    }
    
    return removedCount;
  }

  static async getWallet(address: string): Promise<TrackedWallet | null> {
    const wallets = await this.loadTrackedWallets();
    return wallets.find(w => w.address.toLowerCase() === address.toLowerCase()) || null;
  }
}
