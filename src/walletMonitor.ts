import * as ethers from 'ethers';
import { config } from './config.js';
import { Storage } from './storage.js';
import { PolymarketApi } from './polymarketApi.js';
import { buildPositionKey, normalizeOutcomeLabel, resolveTradeMarketId } from './tradeIdentity.js';
import {
  logTradeRegressionDebug,
  summarizeActivityTradeForDebug,
  summarizeDetectedTradeForDebug,
} from './tradeDiagnostics.js';
import { DetectedTrade, TrackedWallet } from './types.js';
import { createComponentLogger } from './logger.js';
import { DEFAULT_TENANT_ID, runWithTenant } from './tenantContext.js';

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
  private pollCycleInProgress = false;

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
    onTradeDetected: (trade: DetectedTrade) => Promise<void> | void
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
    log.info('[Monitor] Running initial trade check...');
    await this.runPollingCycle(onTradeDetected);

    this.startPolling();

    const wallets = await Storage.loadAllActiveTrackedWalletsForMonitoring();
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
      await this.runPollingCycle(this.onTradeDetectedCallback);
    }, this.currentIntervalMs);
  }

  private async runPollingCycle(onTradeDetected: (trade: DetectedTrade) => void): Promise<void> {
    if (this.pollCycleInProgress) {
      log.warn('[Monitor] Skipping poll cycle because previous cycle is still running');
      return;
    }
    this.pollCycleInProgress = true;
    try {
      await this.checkWalletsForTrades(onTradeDetected);
    } catch (error: any) {
      log.error({ err: error.message, stack: error.stack }, '[Monitor] Error in polling cycle');
    } finally {
      this.pollCycleInProgress = false;
    }
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
    onTradeDetected: (trade: DetectedTrade) => Promise<void> | void
  ): Promise<void> {
    const wallets = await Storage.loadAllActiveTrackedWalletsForMonitoring();

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
          const fallbackWindowMs = 5 * 60 * 1000;
          const cursorMs = wallet.lastSeen instanceof Date
            ? wallet.lastSeen.getTime()
            : now - fallbackWindowMs;
          let maxSeenTradeTime = cursorMs;

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

            if (!Number.isFinite(tradeTime) || tradeTime <= 0) {
              continue;
            }
            if (tradeTime <= cursorMs) {
              continue;
            }
            if (tradeTime > maxSeenTradeTime) {
              maxSeenTradeTime = tradeTime;
            }

            {
              processedTradeCount++;
              log.info({ tradeTime: new Date(tradeTime).toISOString(), preview: JSON.stringify(trade).substring(0, 500) }, '[Monitor] Processing recent trade');
              logTradeRegressionDebug('wallet-monitor.raw-activity-trade', summarizeActivityTradeForDebug(trade as Record<string, unknown>));
              const detectedTrade = await this.parseTradeData(wallet, trade);
              if (detectedTrade) {
                logTradeRegressionDebug('wallet-monitor.detected-trade', summarizeDetectedTradeForDebug(detectedTrade));
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
                    await runWithTenant(detectedTrade.tenantId || DEFAULT_TENANT_ID, () => onTradeDetected(detectedTrade));
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
          log.info(`[Monitor] Processed ${processedTradeCount} trade(s) from history for ${eoaAddress.substring(0, 8)}...`);
          if (maxSeenTradeTime > cursorMs) {
            await runWithTenant(wallet.tenantId || DEFAULT_TENANT_ID, () => (
              Storage.updateWalletLastSeen(eoaAddress, new Date(maxSeenTradeTime))
            ));
          }
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
    wallet: TrackedWallet,
    trade: any
  ): Promise<DetectedTrade | null> {
    try {
      const walletAddress = wallet.address.toLowerCase();
      // Only use the condition id as the market identity.
      // Falling back to the asset token id corrupts dedupe and no-repeat matching.
      const marketId = resolveTradeMarketId({
        conditionId: typeof trade.conditionId === 'string' ? trade.conditionId : undefined,
        asset: typeof trade.asset === 'string' ? trade.asset : undefined,
      });

      // If still no marketId, we can't proceed
      if (!marketId || marketId === 'unknown') {
        log.warn('[Monitor] Cannot determine marketId from trade data (missing conditionId), skipping trade');
        return null;
      }

      const outcome = normalizeOutcomeLabel(
        typeof trade.outcome === 'string' ? trade.outcome : undefined,
        typeof trade.outcomeIndex === 'number' ? trade.outcomeIndex : undefined,
      );
      const tokenId = typeof trade.asset === 'string' ? trade.asset : undefined;
      if (outcome === 'UNKNOWN') {
        log.warn('[Monitor] Cannot determine binary outcome from trade data, skipping trade');
        return null;
      }

      // FIXED: Use 'side' field directly from Polymarket API
      let side: 'BUY' | 'SELL' | null = null;
      if (trade.side) {
        const tradeSide = trade.side.toUpperCase();
        if (tradeSide === 'SELL' || tradeSide === 'S') side = 'SELL';
        if (tradeSide === 'BUY' || tradeSide === 'B') side = 'BUY';
      }
      if (!side) {
        log.warn('[Monitor] Cannot determine side from trade data, skipping trade');
        return null;
      }

      // FIXED: Use 'price' and 'size' fields from Polymarket API
      const price = trade.price;
      const amount = trade.size;

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
        tenantId: wallet.tenantId,
        walletAddress: walletAddress.toLowerCase(),
        marketId,
        marketTitle: trade.title || trade.slug || undefined,
        outcome,
        amount: amount.toString(),
        price: price.toString(),
        side,
        timestamp: tradeTimestamp,
        transactionHash: trade.transactionHash || trade.id || `trade-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        tokenId,
        negRisk: (trade as any).negativeRisk ?? undefined, // CLOB client looks up when undefined
        positionKey: buildPositionKey({ marketId, tokenId, outcome }),
        // Per-wallet trade config (ALL settings, not just sizing)
        tradeSizingMode: wallet.tradeSizingMode,
        fixedTradeSize: wallet.fixedTradeSize,
        thresholdEnabled: wallet.thresholdEnabled,
        thresholdPercent: wallet.thresholdPercent,
        tradeSideFilter: wallet.tradeSideFilter,
        noRepeatEnabled: wallet.noRepeatEnabled,
        noRepeatPeriodHours: wallet.noRepeatPeriodHours,
        priceLimitsMin: wallet.priceLimitsMin,
        priceLimitsMax: wallet.priceLimitsMax,
        rateLimitEnabled: wallet.rateLimitEnabled,
        rateLimitPerHour: wallet.rateLimitPerHour,
        rateLimitPerDay: wallet.rateLimitPerDay,
        valueFilterEnabled: wallet.valueFilterEnabled,
        valueFilterMin: wallet.valueFilterMin,
        valueFilterMax: wallet.valueFilterMax,
        slippagePercent: wallet.slippagePercent,
      };
    } catch (error: any) {
      log.error({ err: error }, 'Failed to parse trade data');
      return null;
    }
  }

  /**
   * Reload wallets (called when a wallet is added or removed).
   * Trade history polling uses Storage.loadAllActiveTrackedWalletsForMonitoring() each cycle, so no state to sync.
   */
  async reloadWallets(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }
    const wallets = await Storage.loadAllActiveTrackedWalletsForMonitoring();
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
