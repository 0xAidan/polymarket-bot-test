import * as ethers from 'ethers';
import { config } from './config.js';
import { Storage } from './storage.js';
import { PolymarketApi } from './polymarketApi.js';
import { DetectedTrade } from './types.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('WalletMonitor');

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
      log.info('Connected to Polygon network and Polymarket API');
    } catch (error) {
      log.error({ err: error }, 'Failed to initialize monitor');
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
    log.info('Starting wallet monitoring');

    // Start polling for trade history
    // Run immediately on start, then at intervals
    log.info('Running initial trade check');
    await this.checkWalletsForTrades(onTradeDetected);

    this.startPolling();

    const wallets = await Storage.getActiveWallets();
    log.info({
      intervalMs: this.currentIntervalMs,
      intervalSec: this.currentIntervalMs / 1000,
      activeWallets: wallets.length,
    }, 'Polling-based monitoring started');

    if (wallets.length === 0) {
      log.warn({ uiUrl: `http://localhost:${config.port || 3000}` }, 'No wallets are being tracked — add wallets via the web UI or API to start copy trading');
    } else {
      for (const wallet of wallets) {
        log.info({
          address: wallet.address,
          active: wallet.active,
        }, 'Tracked wallet');
      }
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
        log.error({ err: error }, 'Error in polling cycle');
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
      log.info({ intervalMs, intervalSec: intervalMs / 1000 }, 'Updating monitoring interval');
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

    log.info({ walletCount: wallets.length }, 'Checking wallets for trades');

    for (const wallet of wallets) {
      try {
        const eoaAddress = wallet.address.toLowerCase();
        const shortAddr = eoaAddress.substring(0, 8) + '...';

        // Check for recent trades from trade history API
        try {
          let recentTrades: any[] = [];
          try {
            recentTrades = await this.api.getUserTrades(eoaAddress, 50);
            log.info({ wallet: shortAddr, tradeCount: recentTrades.length }, 'Fetched trade history');
          } catch (tradesError: any) {
            log.warn({ wallet: shortAddr, err: tradesError }, 'Failed to fetch trade history');
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
              log.info({ wallet: shortAddr, tradeTime: new Date(tradeTime).toISOString() }, 'Processing recent trade');
              const detectedTrade = await this.parseTradeData(eoaAddress, trade);
              if (detectedTrade) {
                // Validate the detected trade before triggering
                const priceNum = parseFloat(detectedTrade.price || '0');
                const amountNum = parseFloat(detectedTrade.amount || '0');

                if (detectedTrade.marketId && detectedTrade.marketId !== 'unknown' &&
                  priceNum > 0 && priceNum <= 1 && amountNum > 0) {
                  log.info({
                    side: detectedTrade.side,
                    amount: detectedTrade.amount,
                    price: detectedTrade.price,
                    marketId: detectedTrade.marketId,
                    outcome: detectedTrade.outcome,
                    tradeTime: new Date(tradeTime).toISOString(),
                  }, 'Trade detected from history');
                  try {
                    await onTradeDetected(detectedTrade);
                    log.info('Trade callback completed successfully');
                  } catch (callbackError: any) {
                    log.error({ err: callbackError }, 'Trade callback failed');
                  }
                } else {
                  log.warn({
                    marketId: detectedTrade.marketId,
                    price: detectedTrade.price,
                    amount: detectedTrade.amount,
                  }, 'Skipping invalid trade from history');
                }
              } else {
                log.warn({ wallet: shortAddr }, 'Failed to parse trade data');
              }
            }
          }
          log.info({ wallet: shortAddr, processedCount: processedTradeCount }, 'Completed trade history check');
        } catch (error: any) {
          if (error.response?.status !== 404) {
            log.warn({ wallet: wallet.address.substring(0, 8) + '...', err: error }, 'Trade history not available');
          }
        }
      } catch (error: any) {
        // Log error but continue monitoring other wallets
        const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
        log.error({ wallet: wallet.address.substring(0, 8) + '...', error: errorMsg }, 'Error monitoring wallet');
        // Don't throw - continue with other wallets
      }
    }

    log.info('Completed trade check cycle for all wallets');
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
        log.warn('Cannot determine marketId from trade data (no conditionId or asset), skipping trade');
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
        log.warn({ price, marketId }, 'Invalid or missing price, skipping trade');
        return null;
      }

      // Validate amount
      const amountNum = parseFloat(amount || '0');
      if (!amount || isNaN(amountNum) || amountNum <= 0) {
        log.warn({ amount, marketId }, 'Invalid or missing amount, skipping trade');
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
        marketTitle: trade.title || trade.slug || undefined,
        outcome,
        amount: amount.toString(),
        price: price.toString(),
        side,
        timestamp: tradeTimestamp,
        transactionHash: trade.transactionHash || trade.id || `trade-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        tokenId: trade.asset,
        negRisk: (trade as any).negativeRisk ?? undefined, // CLOB client looks up when undefined
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
      log.error({ err: error }, 'Failed to parse trade data');
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
    log.info({ walletCount: wallets.length }, 'Wallets reloaded');
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
    log.info('Stopped wallet monitoring');
  }

  /**
   * Get the Polymarket API instance
   */
  getApi(): PolymarketApi {
    return this.api;
  }
}
