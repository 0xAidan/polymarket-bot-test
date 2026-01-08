import { ethers, Contract } from 'ethers';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config.js';
import { Storage } from './storage.js';

// USDC contract addresses on Polygon
// Native USDC (new, recommended by Circle)
const USDC_NATIVE_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
// Bridged USDC (old, legacy)
const USDC_BRIDGED_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
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
  private provider: any | null = null;
  private usdcNativeContract: Contract | null = null;
  private usdcBridgedContract: Contract | null = null;
  private history: Map<string, WalletBalanceHistory> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private isTracking = false;
  private balanceCache: Map<string, { balance: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 60000; // Cache balances for 1 minute
  private lastRpcCallTime = 0;
  private readonly MIN_RPC_INTERVAL_MS = 1000; // Minimum 1 second between RPC calls

  /**
   * Initialize the balance tracker
   */
  async initialize(): Promise<void> {
    try {
      await Storage.ensureDataDir();
      
      // Create provider with better timeout settings
      this.provider = new (ethers as any).providers.JsonRpcProvider(config.polygonRpcUrl, {
        name: 'polygon',
        chainId: 137
      });
      
      // Test the provider connection
      try {
        const blockNumber = await this.provider.getBlockNumber();
        console.log(`[Balance] RPC connected. Current block: ${blockNumber}`);
      } catch (error: any) {
        console.warn(`[Balance] RPC connection test failed: ${error.message}`);
        console.warn(`[Balance] Using RPC: ${config.polygonRpcUrl}`);
      }
      
      // Create USDC contract instances for both native and bridged
      this.usdcNativeContract = new Contract(
        USDC_NATIVE_ADDRESS,
        ERC20_ABI,
        this.provider
      );
      
      this.usdcBridgedContract = new Contract(
        USDC_BRIDGED_ADDRESS,
        ERC20_ABI,
        this.provider
      );

      // Load existing history
      await this.loadHistory();
      console.log('[Balance] Balance tracker initialized with both USDC variants');
    } catch (error: any) {
      console.error('[Balance] Failed to initialize balance tracker:', error);
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
   * Retry helper for RPC calls with exponential backoff
   * Handles rate limit errors gracefully
   */
  private async getBalanceWithRetry(
    callFn: () => Promise<bigint>,
    label: string,
    address: string,
    maxRetries = 2
  ): Promise<number> {
    let lastError: any;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Add delay between retries (exponential backoff)
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Max 10 seconds
          console.log(`[Balance] Retrying ${label} (attempt ${attempt + 1}/${maxRetries + 1}) after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Rate limit: ensure minimum time between RPC calls
        const timeSinceLastCall = Date.now() - this.lastRpcCallTime;
        if (timeSinceLastCall < this.MIN_RPC_INTERVAL_MS) {
          await new Promise(resolve => setTimeout(resolve, this.MIN_RPC_INTERVAL_MS - timeSinceLastCall));
        }
        
        const balance = await Promise.race([
          callFn(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
        ]);
        
        const balanceNumber = parseFloat((ethers as any).utils.formatUnits(balance, USDC_DECIMALS));
        this.lastRpcCallTime = Date.now();
        
        if (balanceNumber > 0) {
          console.log(`[Balance] ✓ ${label} for ${address.substring(0, 10)}...: ${balanceNumber} USDC`);
        }
        
        return balanceNumber;
      } catch (error: any) {
        lastError = error;
        const errorMsg = error.message || String(error);
        
        // Check if it's a rate limit error
        if (errorMsg.includes('rate limit') || 
            errorMsg.includes('Too many requests') || 
            errorMsg.includes('rate limit exhausted') ||
            error?.code === -32090) {
          // For rate limits, don't retry immediately - wait longer
          if (attempt < maxRetries) {
            const delay = 60000; // Wait 1 minute for rate limits
            console.warn(`[Balance] ⚠️ Rate limit hit for ${label}. Waiting ${delay/1000}s before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          } else {
            throw new Error(`Rate limit exhausted for ${label}. Please wait before trying again.`);
          }
        }
        
        // For other errors, retry with exponential backoff
        if (attempt < maxRetries) {
          continue;
        }
      }
    }
    
    throw lastError || new Error(`Failed to get ${label} balance after ${maxRetries + 1} attempts`);
  }

  /**
   * Get current USDC balance for a wallet
   * Checks both native and bridged USDC, returns the sum
   * Uses caching to reduce RPC calls
   */
  async getBalance(address: string): Promise<number> {
    // Ensure initialized
    if (!this.usdcNativeContract || !this.usdcBridgedContract || !this.provider) {
      await this.initialize();
    }

    try {
      // Normalize address to checksummed format for consistent querying
      let normalizedAddress: string;
      try {
        normalizedAddress = (ethers as any).utils.getAddress(address);
      } catch {
        // If address is invalid, use as-is and let the contract call fail
        normalizedAddress = address;
      }

      let totalBalance = 0;
      let nativeBalanceNumber = 0;
      let bridgedBalanceNumber = 0;
      
      // Check cached balance first
      const cacheKey = normalizedAddress.toLowerCase();
      const cached = this.balanceCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL_MS) {
        console.log(`[Balance] Using cached balance for ${normalizedAddress.substring(0, 10)}...: ${cached.balance} USDC`);
        return cached.balance;
      }

      // Rate limit: ensure minimum time between RPC calls
      const timeSinceLastCall = Date.now() - this.lastRpcCallTime;
      if (timeSinceLastCall < this.MIN_RPC_INTERVAL_MS) {
        await new Promise(resolve => setTimeout(resolve, this.MIN_RPC_INTERVAL_MS - timeSinceLastCall));
      }

      // Check native USDC with retry logic
      try {
        nativeBalanceNumber = await this.getBalanceWithRetry(
          () => this.usdcNativeContract!.balanceOf(normalizedAddress),
          'Native USDC',
          normalizedAddress
        );
        totalBalance += nativeBalanceNumber;
      } catch (error: any) {
        // If rate limited, use cached value if available
        if (error.message?.includes('rate limit') || error.message?.includes('Too many requests')) {
          console.warn(`[Balance] ⚠️ Rate limited for Native USDC. ${cached ? 'Using cached value.' : 'Skipping check.'}`);
          if (cached) {
            return cached.balance;
          }
        } else {
          console.warn(`[Balance] ✗ Native USDC failed: ${error.message}`);
        }
      }
      
      // Small delay between contract calls to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check bridged USDC with retry logic
      try {
        bridgedBalanceNumber = await this.getBalanceWithRetry(
          () => this.usdcBridgedContract!.balanceOf(normalizedAddress),
          'Bridged USDC',
          normalizedAddress
        );
        totalBalance += bridgedBalanceNumber;
      } catch (error: any) {
        // If rate limited, continue with what we have
        if (error.message?.includes('rate limit') || error.message?.includes('Too many requests')) {
          console.warn(`[Balance] ⚠️ Rate limited for Bridged USDC. Continuing with partial balance.`);
        } else {
          console.warn(`[Balance] ✗ Bridged USDC failed: ${error.message}`);
        }
      }
      
      // Update cache
      this.balanceCache.set(cacheKey, { balance: totalBalance, timestamp: Date.now() });
      this.lastRpcCallTime = Date.now();
      
      console.log(`[Balance] Total for ${normalizedAddress}: ${totalBalance} USDC (Native: ${nativeBalanceNumber}, Bridged: ${bridgedBalanceNumber})`);
      
      // If both queries succeeded but balance is 0, that's valid - return 0
      // But if there were errors, we should know about them (they're already logged)
      return totalBalance;
    } catch (error: any) {
      console.error(`[Balance] CRITICAL: Failed to get balance for ${address}:`, error.message);
      console.error('[Balance] Error details:', error);
      console.error('[Balance] Stack:', error.stack);
      // Re-throw so the API can handle it properly
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
    if (!this.usdcNativeContract || !this.usdcBridgedContract || !this.provider) {
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

  /**
   * Get balance history for charting
   * Returns array of {timestamp, balance} points for the past 24-48 hours
   */
  getBalanceHistory(address: string): Array<{ timestamp: Date; balance: number }> {
    const addressLower = address.toLowerCase();
    const walletHistory = this.history.get(addressLower);
    
    if (!walletHistory || walletHistory.snapshots.length === 0) {
      return [];
    }

    // Return all snapshots sorted by timestamp
    return walletHistory.snapshots
      .map(s => ({
        timestamp: s.timestamp,
        balance: s.balance
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
}
