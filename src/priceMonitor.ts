import { domeGetMarketPrice, isDomeConfigured } from './domeClient.js';
import { PolymarketApi } from './polymarketApi.js';
import { getAdapter } from './platform/platformRegistry.js';
import { LadderExitManager } from './ladderExitManager.js';
import { SmartStopLossManager } from './smartStopLoss.js';
import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

export interface PriceMonitorConfig {
  enabled: boolean;
  pollIntervalMs: number;  // How often to fetch prices
}

const DEFAULT_PM_CONFIG: PriceMonitorConfig = {
  enabled: false,
  pollIntervalMs: 15000,
};

// ============================================================================
// PRICE MONITOR
//
// Periodically fetches prices for all positions tracked by
// LadderExitManager and SmartStopLossManager, then calls their
// check/update methods.
// ============================================================================

export class PriceMonitor extends EventEmitter {
  private config: PriceMonitorConfig;
  private interval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastCheck = 0;
  private api: PolymarketApi;
  private ladderManager: LadderExitManager;
  private stopLossManager: SmartStopLossManager;

  constructor(
    ladderManager: LadderExitManager,
    stopLossManager: SmartStopLossManager,
    config?: Partial<PriceMonitorConfig>
  ) {
    super();
    this.config = { ...DEFAULT_PM_CONFIG, ...config };
    this.api = new PolymarketApi();
    this.ladderManager = ladderManager;
    this.stopLossManager = stopLossManager;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[PriceMonitor] Started (interval: ${this.config.pollIntervalMs}ms)`);

    this.interval = setInterval(() => {
      this.tick().catch(err => console.error('[PriceMonitor] Tick error:', err.message));
    }, this.config.pollIntervalMs);

    // Initial tick
    this.tick().catch(err => console.error('[PriceMonitor] Initial tick error:', err.message));
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    console.log('[PriceMonitor] Stopped');
  }

  private async tick(): Promise<void> {
    // Collect all token IDs we need prices for
    const tokenIds = new Set<string>();

    for (const ladder of this.ladderManager.getLadders(true)) {
      tokenIds.add(ladder.tokenId);
    }
    for (const order of this.stopLossManager.getOrders(true)) {
      tokenIds.add(order.tokenId);
    }

    if (tokenIds.size === 0) return;

    // Fetch prices
    const priceMap = new Map<string, number>();
    const useDome = isDomeConfigured();

    for (const tokenId of tokenIds) {
      try {
        let price: number | null = null;
        if (useDome) {
          const result = await domeGetMarketPrice(tokenId);
          if (result) price = result.price;
        }
        if (price === null) {
          const bookData = await this.api.getOrderBook(tokenId);
          if (bookData?.market?.tokens) {
            const token = bookData.market.tokens.find((t: any) => t.token_id === tokenId);
            if (token) price = parseFloat(token.price);
          }
        }
        if (price !== null) {
          priceMap.set(tokenId, price);
        }
      } catch (err: any) {
        console.error(`[PriceMonitor] Failed to fetch price for ${tokenId}:`, err.message);
      }
    }

    this.lastCheck = Date.now();

    // Process ladder exits
    const ladderTriggers = this.ladderManager.checkLadders(priceMap);
    for (const trigger of ladderTriggers) {
      const stepIndex = trigger.ladder.steps.indexOf(trigger.step);
      console.log(
        `[PriceMonitor] Ladder step triggered: ${trigger.ladder.marketTitle} ` +
        `step ${stepIndex + 1} — sell ${trigger.sharesToSell.toFixed(2)} shares`
      );
      this.emit('ladder-trigger', {
        ladder: trigger.ladder,
        step: trigger.step,
        stepIndex,
        sharesToSell: trigger.sharesToSell,
        currentPrice: priceMap.get(trigger.ladder.tokenId),
      });
    }

    // Process stop-losses
    const stopLossTriggers = this.stopLossManager.updatePrices(priceMap);
    for (const order of stopLossTriggers) {
      console.log(
        `[PriceMonitor] Stop-loss triggered: ${order.marketTitle} ${order.outcome} ` +
        `@ ${order.triggeredPrice?.toFixed(4)} — sell ${order.shares} shares`
      );
      this.emit('stoploss-trigger', {
        order,
        currentPrice: order.triggeredPrice,
      });
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      lastCheck: this.lastCheck ? new Date(this.lastCheck).toISOString() : null,
      trackedTokens: (() => {
        const ids = new Set<string>();
        for (const l of this.ladderManager.getLadders(true)) ids.add(l.tokenId);
        for (const o of this.stopLossManager.getOrders(true)) ids.add(o.tokenId);
        return ids.size;
      })(),
    };
  }

  updateConfig(updates: Partial<PriceMonitorConfig>): void {
    const wasRunning = this.isRunning;
    if (wasRunning) this.stop();
    Object.assign(this.config, updates);
    if (wasRunning && this.config.enabled) this.start();
  }
}
