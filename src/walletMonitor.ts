import * as ethers from 'ethers';
import { config } from './config.js';
import { Storage } from './storage.js';
import { PolymarketApi } from './polymarketApi.js';
import { DetectedTrade } from './types.js';

/**
 * Monitors wallet addresses for Polymarket trades
 * Uses Polymarket Data API to detect trades and positions
 */
export class WalletMonitor {
  private provider: any | null = null;
  private api: PolymarketApi;
  private isMonitoring = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private currentIntervalMs: number = config.monitoringIntervalMs;
  private onTradeDetectedCallback: ((trade: DetectedTrade) => void) | null = null;

  constructor() {
    this.api = new PolymarketApi();
  }

  /**
   * Initialize the monitor with blockchain connection and API
   */
  async initialize(): Promise<void> {
    try {
      this.provider = new (ethers as any).providers.JsonRpcProvider(config.polygonRpcUrl);
      await this.api.initialize();
      console.log('Connected to Polygon network and Polymarket API');
    } catch (error) {
      console.error('Failed to initialize monitor:', error);
      throw error;
    }
  }

  /**
   * Start monitoring tracked wallets for trades
   * Polls Polymarket Data API for position changes
   */
  async startMonitoring(
    onTradeDetected: (trade: DetectedTrade) => void
  ): Promise<void> {
    if (!this.provider) {
      await this.initialize();
    }

    this.isMonitoring = true;
    this.onTradeDetectedCallback = onTradeDetected;
    this.currentIntervalMs = config.monitoringIntervalMs;
    console.log('Starting wallet monitoring...');

    // Start polling for trade history
    // Run immediately on start, then at intervals
    console.log(`[Monitor] Running initial trade check...`);
    await this.checkWalletsForTrades(onTradeDetected);
    
    this.startPolling();

    const wallets = await Storage.getActiveWallets();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Monitor] 📊 POLLING-BASED MONITORING STARTED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`[Monitor] Monitoring interval: ${this.currentIntervalMs}ms (${this.currentIntervalMs / 1000}s)`);
    console.log(`[Monitor] Active wallets: ${wallets.length}`);
    
    if (wallets.length === 0) {
      console.warn(`\n[Monitor] ⚠️  WARNING: No wallets are being tracked!`);
      console.warn(`[Monitor] Add wallets via the web UI or API to start copy trading`);
      console.warn(`[Monitor] Web UI: http://localhost:${config.port || 3000}\n`);
    } else {
      console.log(`[Monitor] Tracked wallet addresses:`);
      for (const wallet of wallets) {
        const status = wallet.active ? '✅ ACTIVE' : '⏸️  INACTIVE';
        console.log(`[Monitor]   • ${wallet.address.substring(0, 10)}...${wallet.address.substring(wallet.address.length - 8)} - ${status}`);
      }
      console.log(`${'='.repeat(60)}\n`);
    }
  }

  /**
   * Start the polling interval
   */
  private startPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    
    if (!this.onTradeDetectedCallback) {
      return;
    }

    this.pollingInterval = setInterval(async () => {
      if (!this.isMonitoring || !this.onTradeDetectedCallback) return;
      try {
        await this.checkWalletsForTrades(this.onTradeDetectedCallback);
      } catch (error: any) {
        console.error(`[Monitor] Error in polling cycle:`, error.message);
        console.error(`[Monitor] Stack:`, error.stack);
        // Continue polling even if one cycle fails
      }
    }, this.currentIntervalMs);
  }

  /**
   * Update the monitoring interval (takes effect immediately if monitoring is active)
   */
  async updateMonitoringInterval(intervalMs: number): Promise<void> {
    if (intervalMs < 1000) {
      throw new Error('Monitoring interval must be at least 1000ms (1 second)');
    }
    if (intervalMs > 300000) {
      throw new Error('Monitoring interval must be at most 300000ms (5 minutes)');
    }

    this.currentIntervalMs = intervalMs;
    
    // If monitoring is active, restart polling with new interval
    if (this.isMonitoring && this.onTradeDetectedCallback) {
      console.log(`[Monitor] Updating monitoring interval to ${intervalMs}ms (${intervalMs / 1000}s)`);
      this.startPolling();
    }
  }

  /**
   * Check tracked wallets for new trades via trade history API only
   */
  private async checkWalletsForTrades(
    onTradeDetected: (trade: DetectedTrade) => void
  ): Promise<void> {
    const wallets = await Storage.getActiveWallets();
    
    if (wallets.length === 0) {
      // No wallets to monitor, skip this check
      return;
    }

    console.log(`[Monitor] Checking ${wallets.length} wallet(s) for trades...`);
    console.log(`[Monitor] Tracked wallet addresses: ${wallets.map(w => w.address.substring(0, 8) + '...').join(', ')}`);

    for (const wallet of wallets) {
      try {
        const eoaAddress = wallet.address.toLowerCase();
        console.log(`[Monitor] Checking wallet ${eoaAddress.substring(0, 8)}... for trades (trade history)`);

        // Check for recent trades from trade history API
        try {
          console.log(`[Monitor] Fetching trade history for ${eoaAddress.substring(0, 8)}...`);
          let recentTrades: any[] = [];
          try {
            recentTrades = await this.api.getUserTrades(eoaAddress, 50);
            console.log(`[Monitor] Found ${recentTrades.length} trade(s) in history for ${eoaAddress.substring(0, 8)}...`);
          } catch (tradesError: any) {
            console.warn(`[Monitor] Failed to fetch trade history:`, tradesError.message);
            recentTrades = [];
          }
          
          const now = Date.now();
          
          let processedTradeCount = 0;
          for (const trade of recentTrades) {
            // FIXED: Handle both Unix seconds and milliseconds timestamps from Polymarket API
            let tradeTime: number;
            if (typeof trade.timestamp === 'number') {
              tradeTime = trade.timestamp < 1e12 ? trade.timestamp * 1000 : trade.timestamp;
            } else if (typeof trade.timestamp === 'string') {
              const parsed = new Date(trade.timestamp).getTime();
              if (parsed < 1577836800000) {
                tradeTime = parseInt(trade.timestamp, 10) * 1000;
              } else {
                tradeTime = parsed;
              }
            } else {
              tradeTime = 0;
            }

            // TIME WINDOW FILTER: Only process trades within the last 5 minutes
            // This prevents executing old historical trades on bot startup
            // The CopyTrader also has compound key deduplication as a backup
            const MAX_TRADE_AGE_MS = 5 * 60 * 1000; // 5 minutes
            if (now - tradeTime > MAX_TRADE_AGE_MS) {
              continue; // Skip trades older than 5 minutes
            }
            
            {
              processedTradeCount++;
              console.log(`[Monitor] Processing recent trade from ${new Date(tradeTime).toISOString()}:`, JSON.stringify(trade, null, 2).substring(0, 500));
              const detectedTrade = await this.parseTradeData(eoaAddress, trade);
              if (detectedTrade) {
                // Validate the detected trade before triggering
                const priceNum = parseFloat(detectedTrade.price || '0');
                const amountNum = parseFloat(detectedTrade.amount || '0');
                
                if (detectedTrade.marketId && detectedTrade.marketId !== 'unknown' &&
                    priceNum > 0 && priceNum <= 1 && amountNum > 0) {
                  console.log(`\n🔔 [Monitor] TRADE DETECTED: From trade history`);
                  console.log(`   Side: ${detectedTrade.side}`);
                  console.log(`   Amount: ${detectedTrade.amount} shares`);
                  console.log(`   Price: ${detectedTrade.price}`);
                  console.log(`   Market: ${detectedTrade.marketId}`);
                  console.log(`   Outcome: ${detectedTrade.outcome}`);
                  console.log(`   Time: ${new Date(tradeTime).toISOString()}`);
                  console.log(`[Monitor] 📤 Calling onTradeDetected callback...`);
                  try {
                    await onTradeDetected(detectedTrade);
                    console.log(`[Monitor] ✅ Callback completed successfully`);
                  } catch (callbackError: any) {
                    console.error(`[Monitor] ❌ Callback failed:`, callbackError.message);
                    console.error(`[Monitor]    Stack:`, callbackError.stack);
                  }
                } else {
                  console.warn(`[Monitor] ✗ Skipping invalid trade from history: marketId=${detectedTrade.marketId}, price=${detectedTrade.price}, amount=${detectedTrade.amount}`);
                }
              } else {
                console.warn(`[Monitor] ✗ Failed to parse trade data for ${eoaAddress.substring(0, 8)}...`);
              }
            }
          }
          console.log(`[Monitor] Processed ${processedTradeCount} trade(s) from history for ${eoaAddress.substring(0, 8)}...`);
        } catch (error: any) {
          if (error.response?.status !== 404) {
            console.warn(`[Monitor] ⚠️ Trade history not available for ${eoaAddress.substring(0, 8)}...:`, error.message);
          }
        }
      } catch (error: any) {
        // Log error but continue monitoring other wallets
        const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
        console.error(`[Monitor] ✗ Error monitoring wallet ${wallet.address.substring(0, 8)}...:`, errorMsg);
        if (error.stack) {
          console.error(`[Monitor] Stack trace:`, error.stack);
        }
        // Don't throw - continue with other wallets
      }
    }
    
    console.log(`[Monitor] ✓ Completed trade check cycle for all wallets`);
  }

  /**
   * Parse trade data from API into DetectedTrade format
   * FIXED: Uses correct Polymarket Data API field names
   * 
   * Polymarket /trades API returns:
   * {
   *   "asset": "12345...",        // token ID
   *   "conditionId": "0xabc...",  // market ID (condition ID)
   *   "side": "BUY" or "SELL",    // trade side
   *   "size": 123,                // trade size
   *   "price": 0.65,              // trade price
   *   "timestamp": "2024-...",    // ISO timestamp
   *   "outcome": "Yes" or "No",   // outcome name
   *   "outcomeIndex": 0 or 1,     // 0=Yes, 1=No
   *   "title": "Market Title",
   *   "transactionHash": "0x..."  // optional tx hash
   * }
   */
  private async parseTradeData(
    walletAddress: string,
    trade: any
  ): Promise<DetectedTrade | null> {
    try {
      // FIXED: Use conditionId as the market ID (this is what Polymarket API returns)
      let marketId = trade.conditionId;
      
      // Fallback: try asset (token ID) as market ID if no conditionId
      if (!marketId && trade.asset) {
        marketId = trade.asset;
      }
      
      // If still no marketId, we can't proceed
      if (!marketId || marketId === 'unknown') {
        console.warn(`[Monitor] Cannot determine marketId from trade data (no conditionId or asset), skipping trade`);
        return null;
      }

      // FIXED: Determine outcome from 'outcome' or 'outcomeIndex' fields
      let outcome: 'YES' | 'NO' = 'YES';
      if (trade.outcome) {
        // outcome field contains "Yes" or "No" as strings
        outcome = trade.outcome.toUpperCase() === 'NO' ? 'NO' : 'YES';
      } else if (trade.outcomeIndex !== undefined) {
        // outcomeIndex: 0 = Yes, 1 = No
        outcome = trade.outcomeIndex === 1 ? 'NO' : 'YES';
      }

      // FIXED: Use 'side' field directly from Polymarket API
      let side: 'BUY' | 'SELL' = 'BUY';
      if (trade.side) {
        const tradeSide = trade.side.toUpperCase();
        side = (tradeSide === 'SELL' || tradeSide === 'S') ? 'SELL' : 'BUY';
      }

      // FIXED: Use 'price' and 'size' fields from Polymarket API
      let price = trade.price;
      let amount = trade.size;
      
      // Validate price
      const priceNum = parseFloat(price || '0');
      if (!price || isNaN(priceNum) || priceNum <= 0 || priceNum > 1) {
        console.warn(`[Monitor] Invalid or missing price (${price}) for trade on market ${marketId}, skipping`);
        return null;
      }
      
      // Validate amount
      const amountNum = parseFloat(amount || '0');
      if (!amount || isNaN(amountNum) || amountNum <= 0) {
        console.warn(`[Monitor] Invalid or missing amount (${amount}) for trade on market ${marketId}, skipping`);
        return null;
      }

      // Look up wallet settings to get trade config
      const wallets = await Storage.getActiveWallets();
      const walletSettings = wallets.find(w => w.address.toLowerCase() === walletAddress.toLowerCase());
      
      // FIXED: Handle Unix seconds timestamp from API
      let tradeTimestamp: Date;
      if (trade.timestamp) {
        if (typeof trade.timestamp === 'number') {
          // Unix timestamp - convert seconds to milliseconds if needed
          tradeTimestamp = new Date(trade.timestamp < 1e12 ? trade.timestamp * 1000 : trade.timestamp);
        } else {
          tradeTimestamp = new Date(trade.timestamp);
        }
      } else {
        tradeTimestamp = new Date();
      }
      
      return {
        walletAddress: walletAddress.toLowerCase(),
        marketId,
        outcome,
        amount: amount.toString(),
        price: price.toString(),
        side,
        timestamp: tradeTimestamp,
        transactionHash: trade.transactionHash || trade.id || `trade-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        tokenId: trade.asset,
        negRisk: false,
        // Per-wallet trade config (ALL settings, not just sizing)
        tradeSizingMode: walletSettings?.tradeSizingMode,
        fixedTradeSize: walletSettings?.fixedTradeSize,
        thresholdEnabled: walletSettings?.thresholdEnabled,
        thresholdPercent: walletSettings?.thresholdPercent,
        tradeSideFilter: walletSettings?.tradeSideFilter,
        noRepeatEnabled: walletSettings?.noRepeatEnabled,
        noRepeatPeriodHours: walletSettings?.noRepeatPeriodHours,
        priceLimitsMin: walletSettings?.priceLimitsMin,
        priceLimitsMax: walletSettings?.priceLimitsMax,
        rateLimitEnabled: walletSettings?.rateLimitEnabled,
        rateLimitPerHour: walletSettings?.rateLimitPerHour,
        rateLimitPerDay: walletSettings?.rateLimitPerDay,
        valueFilterEnabled: walletSettings?.valueFilterEnabled,
        valueFilterMin: walletSettings?.valueFilterMin,
        valueFilterMax: walletSettings?.valueFilterMax,
        slippagePercent: walletSettings?.slippagePercent,
      };
    } catch (error: any) {
      console.error('[Monitor] Failed to parse trade data:', error);
      return null;
    }
  }

  /**
   * Reload wallets (called when a wallet is added or removed).
   * Trade history polling uses Storage.getActiveWallets() each cycle, so no state to sync.
   */
  async reloadWallets(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }
    const wallets = await Storage.getActiveWallets();
    console.log(`[Monitor] Wallets reloaded: ${wallets.length} tracked`);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    this.isMonitoring = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    console.log('Stopped wallet monitoring');
  }

  /**
   * Get the Polymarket API instance
   */
  getApi(): PolymarketApi {
    return this.api;
  }
}
