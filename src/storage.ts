import { promises as fs } from 'fs';
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
import { getDatabase } from './database.js';

const database = getDatabase();

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

interface WalletRow {
  address: string;
  added_at: string;
  active: number;
  last_seen: string | null;
  label: string | null;
  settings_json: string | null;
}

interface ExecutedPositionRow {
  market_id: string;
  side: 'YES' | 'NO';
  timestamp: number;
  wallet_address: string;
}

const deserializeWalletRow = (row: WalletRow): TrackedWallet => {
  const settings = row.settings_json ? JSON.parse(row.settings_json) : {};
  return {
    address: row.address,
    addedAt: new Date(row.added_at),
    active: Boolean(row.active),
    lastSeen: row.last_seen ? new Date(row.last_seen) : undefined,
    label: row.label ?? undefined,
    ...(settings as Partial<TrackedWallet>)
  };
};

const serializeWallet = (wallet: TrackedWallet) => {
  const { address, addedAt, active, lastSeen, label, ...settings } = wallet;
  const cleanedSettings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined) {
      cleanedSettings[key] = value;
    }
  }

  return {
    address: address.toLowerCase(),
    added_at: (addedAt ?? new Date()).toISOString(),
    active: active ? 1 : 0,
    last_seen: lastSeen ? lastSeen.toISOString() : null,
    label: label ?? null,
    settings_json: JSON.stringify(cleanedSettings)
  };
};

const deserializeExecutedPositionRow = (row: ExecutedPositionRow): ExecutedPosition => ({
  marketId: row.market_id,
  side: row.side,
  timestamp: row.timestamp,
  walletAddress: row.wallet_address
});

/**
 * Storage manager for tracked wallets
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

  /**
   * Load tracked wallets from the SQLite store
   */
  static async loadTrackedWallets(): Promise<TrackedWallet[]> {
    try {
      await this.ensureDataDir();
      const rows = database.prepare(
        `SELECT address, added_at, active, last_seen, label, settings_json
         FROM tracked_wallets
         ORDER BY datetime(added_at) ASC`
      ).all() as WalletRow[];

      return rows.map(deserializeWalletRow);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      console.error('Failed to load tracked wallets:', error);
      throw error;
    }
  }

  /**
   * Persist tracked wallets back to the SQLite store
   */
  static async saveTrackedWallets(wallets: TrackedWallet[]): Promise<void> {
    try {
      await this.ensureDataDir();
      const deleteStmt = database.prepare('DELETE FROM tracked_wallets');
      const insertStmt = database.prepare(`
        INSERT INTO tracked_wallets (address, added_at, active, last_seen, label, settings_json)
        VALUES (@address, @added_at, @active, @last_seen, @label, @settings_json)
      `);

      const tx = database.transaction((items: TrackedWallet[]) => {
        deleteStmt.run();
        for (const item of items) {
          insertStmt.run(serializeWallet(item));
        }
      });

      tx(wallets);
    } catch (error) {
      console.error('Failed to save tracked wallets:', error);
      throw error;
    }
  }

  /**
   * Add a wallet to track
   * New wallets default to active=false (must be explicitly enabled after configuration)
   */
  static async addWallet(address: string): Promise<TrackedWallet> {
    const wallets = await this.loadTrackedWallets();
    
    // Check if wallet already exists
    if (wallets.find(w => w.address.toLowerCase() === address.toLowerCase())) {
      throw new Error('Wallet already being tracked');
    }

    const newWallet: TrackedWallet = {
      address: address.toLowerCase(),
      addedAt: new Date(),
      active: false  // Default to OFF - must configure and enable
    };
    
    wallets.push(newWallet);
    await this.saveTrackedWallets(wallets);
    
    return newWallet;
  }

  /**
   * Remove a wallet from tracking
   */
  static async removeWallet(address: string): Promise<void> {
    const wallets = await this.loadTrackedWallets();
    const filtered = wallets.filter(
      w => w.address.toLowerCase() !== address.toLowerCase()
    );
    await this.saveTrackedWallets(filtered);
  }

  /**
   * Get all active tracked wallets
   */
  static async getActiveWallets(): Promise<TrackedWallet[]> {
    const wallets = await this.loadTrackedWallets();
    return wallets.filter(w => w.active);
  }

  /**
   * Toggle wallet active status (enable/disable copy trading)
   */
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

  /**
   * Update wallet label
   */
  static async updateWalletLabel(address: string, label: string): Promise<TrackedWallet> {
    const wallets = await this.loadTrackedWallets();
    const wallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    wallet.label = label.trim() || undefined; // Empty string becomes undefined
    await this.saveTrackedWallets(wallets);
    return wallet;
  }

  /**
   * Update wallet trade configuration (ALL settings are per-wallet)
   * Pass null to clear a value (revert to default)
   */
  static async updateWalletTradeConfig(
    address: string,
    walletConfig: {
      // Trade sizing
      tradeSizingMode?: 'fixed' | 'proportional' | null;
      fixedTradeSize?: number | null;
      thresholdEnabled?: boolean | null;
      thresholdPercent?: number | null;
      
      // Trade side filter
      tradeSideFilter?: TradeSideFilter | null;
      
      // Advanced filters
      noRepeatEnabled?: boolean | null;
      noRepeatPeriodHours?: number | null;  // 0 = forever
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

    // Helper to update field: undefined = don't change, null = clear, value = set
    const updateField = <T>(current: T | undefined, newVal: T | null | undefined): T | undefined => {
      if (newVal === undefined) return current;  // Don't change
      if (newVal === null) return undefined;     // Clear
      return newVal;                              // Set new value
    };

    // Trade sizing
    wallet.tradeSizingMode = updateField(wallet.tradeSizingMode, walletConfig.tradeSizingMode);
    wallet.fixedTradeSize = updateField(wallet.fixedTradeSize, walletConfig.fixedTradeSize);
    wallet.thresholdEnabled = updateField(wallet.thresholdEnabled, walletConfig.thresholdEnabled);
    wallet.thresholdPercent = updateField(wallet.thresholdPercent, walletConfig.thresholdPercent);
    
    // Trade side filter
    wallet.tradeSideFilter = updateField(wallet.tradeSideFilter, walletConfig.tradeSideFilter);
    
    // Advanced filters
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

  /**
   * Clear ALL wallet trade configuration (revert to defaults)
   */
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

  /**
   * Load bot configuration
   */
  static async loadConfig(): Promise<any> {
    try {
      await this.ensureDataDir();
      const row = database.prepare('SELECT data FROM bot_config WHERE id = 1').get() as { data: string } | undefined;
      if (!row) {
        return {
          tradeSize: '2',
          monitoringIntervalMs: 15000
        };
      }
      return JSON.parse(row.data);
    } catch (error) {
      console.error('Failed to load bot config:', error);
      throw error;
    }
  }

  /**
   * Save bot configuration
   */
  static async saveConfig(configData: any): Promise<void> {
    try {
      await this.ensureDataDir();
      database.prepare(`
        INSERT INTO bot_config (id, data) VALUES (1, @data)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data
      `).run({ data: JSON.stringify(configData) });
    } catch (error) {
      console.error('Failed to save bot config:', error);
      throw error;
    }
  }

  /**
   * Get configured trade size
   * Default is $2 USDC
   */
  static async getTradeSize(): Promise<string> {
    const config = await this.loadConfig();
    return config.tradeSize || '2';
  }

  /**
   * Set configured trade size
   */
  static async setTradeSize(size: string): Promise<void> {
    const config = await this.loadConfig();
    config.tradeSize = size;
    await this.saveConfig(config);
  }

  /**
   * Get configured monitoring interval (in milliseconds)
   */
  static async getMonitoringInterval(): Promise<number> {
    const config = await this.loadConfig();
    // Use stored value, or fall back to environment variable, or default to match config.ts
    return config.monitoringIntervalMs || parseInt(process.env.MONITORING_INTERVAL_MS || '15000', 10);
  }

  /**
   * Set configured monitoring interval (in milliseconds)
   */
  static async setMonitoringInterval(intervalMs: number): Promise<void> {
    const config = await this.loadConfig();
    config.monitoringIntervalMs = intervalMs;
    await this.saveConfig(config);
  }

  /**
   * Get position threshold configuration
   * Used to filter out small "noise" trades from tracked wallets
   */
  static async getPositionThreshold(): Promise<{ enabled: boolean; percent: number }> {
    const config = await this.loadConfig();
    return {
      enabled: config.positionThresholdEnabled || false,
      percent: config.positionThresholdPercent || 10 // Default 10%
    };
  }

  /**
   * Set position threshold configuration
   * @deprecated Use per-wallet trade config instead (updateWalletTradeConfig)
   */
  static async setPositionThreshold(enabled: boolean, percent: number): Promise<void> {
    const config = await this.loadConfig();
    config.positionThresholdEnabled = enabled;
    config.positionThresholdPercent = percent;
    await this.saveConfig(config);
  }

  /**
   * Get USDC usage stop-loss configuration
   * When enabled, stops taking new trades when X% of USDC is committed to open positions
   */
  static async getUsageStopLoss(): Promise<{ enabled: boolean; maxCommitmentPercent: number }> {
    const config = await this.loadConfig();
    return {
      enabled: config.usageStopLossEnabled || false,
      maxCommitmentPercent: config.usageStopLossPercent || 80 // Default 80%
    };
  }

  /**
   * Set USDC usage stop-loss configuration
   * @param enabled - Whether stop-loss is enabled
   * @param maxCommitmentPercent - Maximum % of USDC that can be committed to positions (1-99)
   */
  static async setUsageStopLoss(enabled: boolean, maxCommitmentPercent: number): Promise<void> {
    const config = await this.loadConfig();
    config.usageStopLossEnabled = enabled;
    config.usageStopLossPercent = maxCommitmentPercent;
    await this.saveConfig(config);
  }

  // ============================================================================
  // ADVANCED TRADE FILTER CONFIGURATION METHODS
  // ============================================================================

  /**
   * Get no-repeat-trades configuration
   * When enabled, prevents copying trades in markets where you already have a position
   */
  static async getNoRepeatTrades(): Promise<NoRepeatTradesConfig> {
    const config = await this.loadConfig();
    return {
      enabled: config.noRepeatTradesEnabled ?? DEFAULT_NO_REPEAT_TRADES.enabled,
      blockPeriodHours: config.noRepeatTradesBlockPeriodHours ?? DEFAULT_NO_REPEAT_TRADES.blockPeriodHours
    };
  }

  /**
   * Set no-repeat-trades configuration
   * @param enabled - Whether no-repeat-trades is enabled
   * @param blockPeriodHours - How long to block repeats (1, 6, 12, 24, 48, 168)
   */
  static async setNoRepeatTrades(enabled: boolean, blockPeriodHours: number): Promise<void> {
    const config = await this.loadConfig();
    config.noRepeatTradesEnabled = enabled;
    config.noRepeatTradesBlockPeriodHours = blockPeriodHours;
    await this.saveConfig(config);
  }

  /**
   * Get price limits configuration
   * Defines the min/max prices for trade execution
   */
  static async getPriceLimits(): Promise<PriceLimitsConfig> {
    const config = await this.loadConfig();
    return {
      minPrice: config.priceLimitsMin ?? DEFAULT_PRICE_LIMITS.minPrice,
      maxPrice: config.priceLimitsMax ?? DEFAULT_PRICE_LIMITS.maxPrice
    };
  }

  /**
   * Set price limits configuration
   * @param minPrice - Minimum executable price (0.01-0.98)
   * @param maxPrice - Maximum executable price (0.02-0.99)
   */
  static async setPriceLimits(minPrice: number, maxPrice: number): Promise<void> {
    const config = await this.loadConfig();
    config.priceLimitsMin = minPrice;
    config.priceLimitsMax = maxPrice;
    await this.saveConfig(config);
  }

  /**
   * Get slippage percentage configuration
   * Used to adjust order prices for immediate fills
   */
  static async getSlippagePercent(): Promise<number> {
    const config = await this.loadConfig();
    return config.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT;
  }

  /**
   * Set slippage percentage configuration
   * @param percent - Slippage percentage (0.5-10)
   */
  static async setSlippagePercent(percent: number): Promise<void> {
    const config = await this.loadConfig();
    config.slippagePercent = percent;
    await this.saveConfig(config);
  }

  /**
   * Get global trade side filter configuration
   * Determines which trade types to copy (BUY, SELL, or both)
   */
  static async getTradeSideFilter(): Promise<TradeSideFilter> {
    const config = await this.loadConfig();
    return config.tradeSideFilter ?? DEFAULT_TRADE_SIDE_FILTER;
  }

  /**
   * Set global trade side filter configuration
   * @param filter - 'all' | 'buy_only' | 'sell_only'
   */
  static async setTradeSideFilter(filter: TradeSideFilter): Promise<void> {
    const config = await this.loadConfig();
    config.tradeSideFilter = filter;
    await this.saveConfig(config);
  }

  /**
   * Get rate limiting configuration
   * Limits the number of trades per hour/day
   */
  static async getRateLimiting(): Promise<RateLimitingConfig> {
    const config = await this.loadConfig();
    return {
      enabled: config.rateLimitingEnabled ?? DEFAULT_RATE_LIMITING.enabled,
      maxTradesPerHour: config.rateLimitingMaxPerHour ?? DEFAULT_RATE_LIMITING.maxTradesPerHour,
      maxTradesPerDay: config.rateLimitingMaxPerDay ?? DEFAULT_RATE_LIMITING.maxTradesPerDay
    };
  }

  /**
   * Set rate limiting configuration
   * @param enabled - Whether rate limiting is enabled
   * @param maxTradesPerHour - Maximum trades per hour (1-100)
   * @param maxTradesPerDay - Maximum trades per day (1-500)
   */
  static async setRateLimiting(enabled: boolean, maxTradesPerHour: number, maxTradesPerDay: number): Promise<void> {
    const config = await this.loadConfig();
    config.rateLimitingEnabled = enabled;
    config.rateLimitingMaxPerHour = maxTradesPerHour;
    config.rateLimitingMaxPerDay = maxTradesPerDay;
    await this.saveConfig(config);
  }

  /**
   * Get trade value filters configuration
   * Filters trades by minimum/maximum USDC value
   */
  static async getTradeValueFilters(): Promise<TradeValueFiltersConfig> {
    const config = await this.loadConfig();
    return {
      enabled: config.tradeValueFiltersEnabled ?? DEFAULT_TRADE_VALUE_FILTERS.enabled,
      minTradeValueUSD: config.tradeValueFiltersMin ?? DEFAULT_TRADE_VALUE_FILTERS.minTradeValueUSD,
      maxTradeValueUSD: config.tradeValueFiltersMax ?? DEFAULT_TRADE_VALUE_FILTERS.maxTradeValueUSD
    };
  }

  /**
   * Set trade value filters configuration
   * @param enabled - Whether trade value filters are enabled
   * @param minTradeValueUSD - Minimum trade value in USDC (null for no minimum)
   * @param maxTradeValueUSD - Maximum trade value in USDC (null for no maximum)
   */
  static async setTradeValueFilters(
    enabled: boolean, 
    minTradeValueUSD: number | null, 
    maxTradeValueUSD: number | null
  ): Promise<void> {
    const config = await this.loadConfig();
    config.tradeValueFiltersEnabled = enabled;
    config.tradeValueFiltersMin = minTradeValueUSD;
    config.tradeValueFiltersMax = maxTradeValueUSD;
    await this.saveConfig(config);
  }

  // ============================================================================
  // EXECUTED POSITIONS TRACKING (for no-repeat-trades)
  // ============================================================================

  /**
   * Load executed positions from the SQLite store
   */
  static async loadExecutedPositions(): Promise<ExecutedPosition[]> {
    try {
      await this.ensureDataDir();
      const rows = database.prepare(
        'SELECT market_id, side, timestamp, wallet_address FROM executed_positions ORDER BY timestamp DESC'
      ).all() as ExecutedPositionRow[];
      return rows.map(deserializeExecutedPositionRow);
    } catch (error) {
      console.error('Failed to load executed positions:', error);
      throw error;
    }
  }

  /**
   * Save executed positions to the SQLite store
   */
  static async saveExecutedPositions(positions: ExecutedPosition[]): Promise<void> {
    try {
      await this.ensureDataDir();
      const deleteStmt = database.prepare('DELETE FROM executed_positions');
      const insertStmt = database.prepare(`
        INSERT INTO executed_positions (market_id, side, timestamp, wallet_address)
        VALUES (@market_id, @side, @timestamp, @wallet_address)
      `);

      const tx = database.transaction((rows: ExecutedPosition[]) => {
        deleteStmt.run();
        for (const row of rows) {
          insertStmt.run({
            market_id: row.marketId,
            side: row.side,
            timestamp: row.timestamp,
            wallet_address: row.walletAddress.toLowerCase()
          });
        }
      });

      tx(positions);
    } catch (error) {
      console.error('Failed to save executed positions:', error);
      throw error;
    }
  }

  /**
   * Add an executed position record
   * Used for no-repeat-trades tracking
   */
  static async addExecutedPosition(
    marketId: string, 
    side: 'YES' | 'NO', 
    walletAddress: string
  ): Promise<void> {
    const positions = await this.loadExecutedPositions();
    
    // Check if we already have this market+side (avoid duplicates)
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

  /**
   * Check if a market+side position has been executed within the block period
   * @param blockPeriodHours - Hours to block (0 = forever until manually cleared)
   * @returns true if the position exists and is within the block period (should be blocked)
   */
  static async isPositionBlocked(
    marketId: string, 
    side: 'YES' | 'NO', 
    blockPeriodHours: number
  ): Promise<boolean> {
    const positions = await this.loadExecutedPositions();
    
    // 0 = forever - any existing position blocks
    if (blockPeriodHours === 0) {
      return positions.some(
        p => p.marketId === marketId && p.side === side
      );
    }
    
    // Time-based blocking
    const blockPeriodMs = blockPeriodHours * 60 * 60 * 1000;
    const cutoffTime = Date.now() - blockPeriodMs;
    
    return positions.some(
      p => p.marketId === marketId && 
           p.side === side && 
           p.timestamp > cutoffTime
    );
  }

  /**
   * Get all executed positions (for UI display)
   */
  static async getExecutedPositions(): Promise<ExecutedPosition[]> {
    return this.loadExecutedPositions();
  }

  /**
   * Clear all executed positions history
   */
  static async clearExecutedPositions(): Promise<void> {
    await this.saveExecutedPositions([]);
  }

  /**
   * Cleanup expired executed positions
   * Removes positions older than the specified block period
   * @param blockPeriodHours - Hours after which positions expire (0 = never expire)
   */
  static async cleanupExpiredPositions(blockPeriodHours: number): Promise<number> {
    // If blockPeriodHours is 0 (forever), don't clean up anything
    if (blockPeriodHours === 0) {
      return 0;
    }
    
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

  /**
   * Get a specific wallet by address
   */
  static async getWallet(address: string): Promise<TrackedWallet | null> {
    const wallets = await this.loadTrackedWallets();
    return wallets.find(w => w.address.toLowerCase() === address.toLowerCase()) || null;
  }
}
