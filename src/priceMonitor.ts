import { PolymarketApi } from './polymarketApi.js';
import { LadderExitManager } from './ladderExitManager.js';
import { SmartStopLossManager } from './smartStopLoss.js';
import { EventEmitter } from 'events';
import { createComponentLogger } from './logger.js';
import { isHostedMultiTenantMode } from './hostedMode.js';
import { DEFAULT_TENANT_ID, runWithTenant } from './tenantContext.js';
import { listTenantIdsWithLadderOrStopLossActivity } from './database.js';

const log = createComponentLogger('PriceMonitor');

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
    log.info(`[PriceMonitor] Started (interval: ${this.config.pollIntervalMs}ms)`);

    this.interval = setInterval(() => {
      this.tick().catch(err => log.error('[PriceMonitor] Tick error:', err.message));
    }, this.config.pollIntervalMs);

    // Initial tick
    this.tick().catch(err => log.error('[PriceMonitor] Initial tick error:', err.message));
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    log.info('[PriceMonitor] Stopped');
  }

  private async tick(): Promise<void> {
    if (isHostedMultiTenantMode()) {
      await this.tickHostedMultiTenant();
      return;
    }
    await runWithTenant(DEFAULT_TENANT_ID, () => this.tickSingleTenant());
  }

  /** Legacy / single-tenant: one AsyncLocalStorage tenant (default). */
  private async tickSingleTenant(): Promise<void> {
    await this.ladderManager.syncFromCurrentTenant();
    await this.stopLossManager.syncFromCurrentTenant();

    const tokenIds = new Set<string>();
    for (const ladder of this.ladderManager.getLadders(true)) {
      tokenIds.add(ladder.tokenId);
    }
    for (const order of this.stopLossManager.getOrders(true)) {
      tokenIds.add(order.tokenId);
    }

    if (tokenIds.size === 0) return;

    const priceMap = await this.fetchPricesForTokens(tokenIds);
    this.lastCheck = Date.now();

    const ladderTriggers = this.ladderManager.checkLadders(priceMap);
    for (const trigger of ladderTriggers) {
      const stepIndex = trigger.ladder.steps.indexOf(trigger.step);
      log.info(
        `[PriceMonitor] Ladder step triggered: ${trigger.ladder.marketTitle} ` +
        `step ${stepIndex + 1} — sell ${trigger.sharesToSell.toFixed(2)} shares`
      );
      this.emit('ladder-trigger', {
        tenantId: DEFAULT_TENANT_ID,
        ladder: trigger.ladder,
        step: trigger.step,
        stepIndex,
        sharesToSell: trigger.sharesToSell,
        currentPrice: priceMap.get(trigger.ladder.tokenId),
      });
    }

    const stopLossTriggers = this.stopLossManager.updatePrices(priceMap);
    for (const order of stopLossTriggers) {
      log.info(
        `[PriceMonitor] Stop-loss triggered: ${order.marketTitle} ${order.outcome} ` +
        `@ ${order.triggeredPrice?.toFixed(4)} — sell ${order.shares} shares`
      );
      this.emit('stoploss-trigger', {
        tenantId: DEFAULT_TENANT_ID,
        order,
        currentPrice: order.triggeredPrice,
      });
    }
  }

  /**
   * Hosted: each tenant has isolated ladder/stop-loss rows in SQLite; tick each tenant under runWithTenant.
   */
  private async tickHostedMultiTenant(): Promise<void> {
    const tenantIds = listTenantIdsWithLadderOrStopLossActivity();
    if (tenantIds.length === 0) return;

    const allTokenIds = new Set<string>();
    for (const tid of tenantIds) {
      await runWithTenant(tid, async () => {
        await this.ladderManager.syncFromCurrentTenant();
        await this.stopLossManager.syncFromCurrentTenant();
        for (const ladder of this.ladderManager.getLadders(true)) {
          allTokenIds.add(ladder.tokenId);
        }
        for (const order of this.stopLossManager.getOrders(true)) {
          allTokenIds.add(order.tokenId);
        }
      });
    }

    if (allTokenIds.size === 0) return;

    const priceMap = await this.fetchPricesForTokens(allTokenIds);
    this.lastCheck = Date.now();

    for (const tid of tenantIds) {
      await runWithTenant(tid, async () => {
        await this.ladderManager.syncFromCurrentTenant();
        await this.stopLossManager.syncFromCurrentTenant();

        const ladderTriggers = this.ladderManager.checkLadders(priceMap);
        for (const trigger of ladderTriggers) {
          const stepIndex = trigger.ladder.steps.indexOf(trigger.step);
          log.info(
            `[PriceMonitor] Ladder step triggered: ${trigger.ladder.marketTitle} ` +
            `step ${stepIndex + 1} — sell ${trigger.sharesToSell.toFixed(2)} shares`
          );
          this.emit('ladder-trigger', {
            tenantId: tid,
            ladder: trigger.ladder,
            step: trigger.step,
            stepIndex,
            sharesToSell: trigger.sharesToSell,
            currentPrice: priceMap.get(trigger.ladder.tokenId),
          });
        }

        const stopLossTriggers = this.stopLossManager.updatePrices(priceMap);
        for (const order of stopLossTriggers) {
          log.info(
            `[PriceMonitor] Stop-loss triggered: ${order.marketTitle} ${order.outcome} ` +
            `@ ${order.triggeredPrice?.toFixed(4)} — sell ${order.shares} shares`
          );
          this.emit('stoploss-trigger', {
            tenantId: tid,
            order,
            currentPrice: order.triggeredPrice,
          });
        }
      });
    }
  }

  private async fetchPricesForTokens(tokenIds: Set<string>): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();
    for (const tokenId of tokenIds) {
      try {
        let price: number | null = null;
        const bookData = await this.api.getOrderBook(tokenId);
        if (bookData?.market?.tokens) {
          const token = bookData.market.tokens.find((t: any) => t.token_id === tokenId);
          if (token) price = parseFloat(token.price);
        }
        if (price !== null) {
          priceMap.set(tokenId, price);
        }
      } catch (err: any) {
        log.error({ detail: err.message }, `[PriceMonitor] Failed to fetch price for ${tokenId}`)
      }
    }
    return priceMap;
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
