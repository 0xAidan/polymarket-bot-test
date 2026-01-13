import { promises as fs } from 'fs';
import path from 'path';
import { TrackedWallet } from './types.js';
import { config } from './config.js';

const WALLETS_FILE = path.join(config.dataDir, 'tracked_wallets.json');
const CONFIG_FILE = path.join(config.dataDir, 'bot_config.json');

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
   * Load tracked wallets from file
   */
  static async loadTrackedWallets(): Promise<TrackedWallet[]> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(WALLETS_FILE, 'utf-8');
      const wallets = JSON.parse(data);
      // Convert date strings back to Date objects
      return wallets.map((w: any) => ({
        ...w,
        addedAt: new Date(w.addedAt),
        lastSeen: w.lastSeen ? new Date(w.lastSeen) : undefined
      }));
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet, return empty array
        return [];
      }
      console.error('Failed to load tracked wallets:', error);
      throw error;
    }
  }

  /**
   * Save tracked wallets to file
   */
  static async saveTrackedWallets(wallets: TrackedWallet[]): Promise<void> {
    try {
      await this.ensureDataDir();
      await fs.writeFile(WALLETS_FILE, JSON.stringify(wallets, null, 2));
    } catch (error) {
      console.error('Failed to save tracked wallets:', error);
      throw error;
    }
  }

  /**
   * Add a wallet to track
   */
  static async addWallet(address: string): Promise<void> {
    const wallets = await this.loadTrackedWallets();
    
    // Check if wallet already exists
    if (wallets.find(w => w.address.toLowerCase() === address.toLowerCase())) {
      throw new Error('Wallet already being tracked');
    }

    wallets.push({
      address: address.toLowerCase(),
      addedAt: new Date(),
      active: true
    });

    await this.saveTrackedWallets(wallets);
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
   * Toggle wallet autoBumpToMinimum setting
   * When enabled, orders will automatically increase to meet market minimum size
   * This is for "high-value" wallets where you want 100% trade success rate
   */
  static async toggleAutoBumpToMinimum(address: string, enabled?: boolean): Promise<TrackedWallet> {
    const wallets = await this.loadTrackedWallets();
    const wallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    wallet.autoBumpToMinimum = enabled !== undefined ? enabled : !wallet.autoBumpToMinimum;
    await this.saveTrackedWallets(wallets);
    return wallet;
  }

  /**
   * Load bot configuration
   */
  static async loadConfig(): Promise<any> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(CONFIG_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet, return default config
        return { 
          tradeSize: '2', // Default trade size in USDC
          monitoringIntervalMs: 15000 // Default 15 seconds (matches config.ts default)
        };
      }
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
      await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2));
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
}
