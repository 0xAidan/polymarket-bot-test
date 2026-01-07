import { ethers } from 'ethers';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config.js';
import { Storage } from './storage.js';

// USDC contract address on Polygon
const USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
// USDC has 6 decimals
const USDC_DECIMALS = 6;

// ABI for ERC20 balanceOf function
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

interface BalanceSnapshot {
  timestamp: Date;
  balance: number; // Balance in USDC (already converted from wei)
}

interface WalletBalanceHistory {
  address: string;
  snapshots: BalanceSnapshot[];
}

const BALANCE_HISTORY_FILE = path.join(config.dataDir, 'balance_history.json');

/**
 * Tracks wallet balances over time to calculate 24h changes
 */
export class BalanceTracker {
  private provider: ethers.Provider | null = null;
  private usdcContract: ethers.Contract | null = null;
  private history: Map<string, WalletBalanceHistory> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private isTracking = false;

  /**
   * Initialize the balance tracker
   */
  async initialize(): Promise<void> {
    try {
      await Storage.ensureDataDir();
      this.provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
      
      // Create USDC contract instance
      this.usdcContract = new ethers.Contract(
        USDC_CONTRACT_ADDRESS,
        ERC20_ABI,
        this.provider
      );

      // Load existing history
      await this.loadHistory();
      console.log('Balance tracker initialized');
    } catch (error: any) {
      console.error('Failed to initialize balance tracker:', error);
      throw error;
    }
  }

  /**
   * Load balance history from file
   */
  private async loadHistory(): Promise<void> {
    try {
      const data = await fs.readFile(BALANCE_HISTORY_FILE, 'utf-8');
      const historyData = JSON.parse(data);
      
      this.history.clear();
      for (const [address, walletHistory] of Object.entries(historyData)) {
        const wh = walletHistory as any;
        this.history.set(address.toLowerCase(), {
          address: wh.address,
          snapshots: wh.snapshots.map((s: any) => ({
            timestamp: new Date(s.timestamp),
            balance: s.balance
          }))
        });
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet, start with empty history
        this.history.clear();
      } else {
        console.error('Failed to load balance history:', error);
      }
    }
  }

  /**
   * Save balance history to file
   */
  private async saveHistory(): Promise<void> {
    try {
      await Storage.ensureDataDir();
      const historyData: Record<string, any> = {};
      
      for (const [address, walletHistory] of this.history.entries()) {
        historyData[address] = {
          address: walletHistory.address,
          snapshots: walletHistory.snapshots.map(s => ({
            timestamp: s.timestamp.toISOString(),
            balance: s.balance
          }))
        };
      }
      
      await fs.writeFile(BALANCE_HISTORY_FILE, JSON.stringify(historyData, null, 2));
    } catch (error) {
      console.error('Failed to save balance history:', error);
    }
  }

  /**
   * Get current USDC balance for a wallet
   * Always fetches fresh from the blockchain
   */
  async getBalance(address: string): Promise<number> {
    // Ensure initialized
    if (!this.usdcContract || !this.provider) {
      await this.initialize();
    }

    try {
      // Always fetch fresh balance from blockchain
      const balance = await this.usdcContract!.balanceOf(address);
      // Convert from wei to USDC (6 decimals)
      const balanceNumber = parseFloat(ethers.formatUnits(balance, USDC_DECIMALS));
      console.log(`Balance fetched for ${address.substring(0, 8)}...: ${balanceNumber} USDC`);
      return balanceNumber;
    } catch (error: any) {
      console.error(`Failed to get balance for ${address}:`, error.message);
      console.error('Error details:', error);
      // Re-throw to allow caller to handle the error
      throw new Error(`Failed to fetch balance: ${error.message}`);
    }
  }

  /**
   * Record a balance snapshot for a wallet
   */
  async recordBalance(address: string): Promise<void> {
    try {
      const balance = await this.getBalance(address);
      const addressLower = address.toLowerCase();
      
      if (!this.history.has(addressLower)) {
        this.history.set(addressLower, {
          address: address,
          snapshots: []
        });
      }

      const walletHistory = this.history.get(addressLower)!;
      const now = new Date();

      // Add new snapshot
      walletHistory.snapshots.push({
        timestamp: now,
        balance: balance
      });

      // Keep only last 48 hours of history (to ensure we have 24h data)
      const cutoffTime = new Date(now.getTime() - 48 * 60 * 60 * 1000);
      walletHistory.snapshots = walletHistory.snapshots.filter(
        s => s.timestamp >= cutoffTime
      );

      // Sort by timestamp
      walletHistory.snapshots.sort((a, b) => 
        a.timestamp.getTime() - b.timestamp.getTime()
      );

      await this.saveHistory();
    } catch (error: any) {
      // Log error but don't throw - we don't want to break tracking for other wallets
      console.error(`Failed to record balance for ${address}:`, error.message);
    }
  }

  /**
   * Get current balance and 24h change for a wallet
   * Always fetches fresh balance from blockchain
   */
  async getBalanceWithChange(address: string): Promise<{
    currentBalance: number;
    change24h: number; // Percentage change
    balance24hAgo: number | null;
  }> {
    // Ensure initialized before fetching
    if (!this.usdcContract || !this.provider) {
      await this.initialize();
    }

    // Always fetch fresh balance from blockchain
    const currentBalance = await this.getBalance(address);
    const addressLower = address.toLowerCase();

    // Find balance 24 hours ago from history
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const walletHistory = this.history.get(addressLower);
    let balance24hAgo: number | null = null;
    let change24h = 0;

    if (walletHistory && walletHistory.snapshots.length > 0) {
      // Find the closest snapshot to 24 hours ago
      let closestSnapshot: BalanceSnapshot | null = null;
      let minDiff = Infinity;

      for (const snapshot of walletHistory.snapshots) {
        const diff = Math.abs(snapshot.timestamp.getTime() - twentyFourHoursAgo.getTime());
        if (diff < minDiff) {
          minDiff = diff;
          closestSnapshot = snapshot;
        }
      }

      if (closestSnapshot && minDiff < 25 * 60 * 60 * 1000) { // Only use if within 25 hours
        balance24hAgo = closestSnapshot.balance;
        if (balance24hAgo > 0) {
          change24h = ((currentBalance - balance24hAgo) / balance24hAgo) * 100;
        } else if (currentBalance > 0) {
          // If balance was 0 and now has value, it's a 100% increase
          change24h = 100;
        }
      }
    }

    return {
      currentBalance,
      change24h,
      balance24hAgo
    };
  }

  /**
   * Start periodic balance tracking for wallets
   */
  async startTracking(walletAddresses: string[]): Promise<void> {
    if (this.isTracking) {
      return;
    }

    this.isTracking = true;
    const trackingInterval = 5 * 60 * 1000; // Track every 5 minutes

    // Record initial balances
    for (const address of walletAddresses) {
      await this.recordBalance(address);
    }

    // Set up periodic tracking
    this.pollingInterval = setInterval(async () => {
      try {
        for (const address of walletAddresses) {
          await this.recordBalance(address);
        }
      } catch (error) {
        console.error('Error during balance tracking:', error);
      }
    }, trackingInterval);

    console.log(`Started balance tracking for ${walletAddresses.length} wallets`);
  }

  /**
   * Stop balance tracking
   */
  stopTracking(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.isTracking = false;
  }

  /**
   * Update tracked wallets (add/remove)
   */
  async updateTrackedWallets(walletAddresses: string[]): Promise<void> {
    if (this.isTracking) {
      // Record balances for new wallets
      for (const address of walletAddresses) {
        if (!this.history.has(address.toLowerCase())) {
          await this.recordBalance(address);
        }
      }
    }
  }
}
