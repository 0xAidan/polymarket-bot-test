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
   * Load bot configuration
   */
  static async loadConfig(): Promise<{ tradeSizeUsd?: number }> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(CONFIG_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet, return defaults
        return { tradeSizeUsd: 20 }; // Default $20 per trade
      }
      console.error('Failed to load bot config:', error);
      return { tradeSizeUsd: 20 };
    }
  }

  /**
   * Save bot configuration
   */
  static async saveConfig(config: { tradeSizeUsd?: number }): Promise<void> {
    try {
      await this.ensureDataDir();
      await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Failed to save bot config:', error);
      throw error;
    }
  }
}
