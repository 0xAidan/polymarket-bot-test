import { Storage } from './storage.js';
import { createComponentLogger } from './logger.js';
import { getTenantId, getTenantIdStrict } from './tenantContext.js';
import { isHostedMultiTenantMode } from './hostedMode.js';

const log = createComponentLogger('SmartStopLoss');

// ============================================================================
// TYPES
// ============================================================================

/** A stop-loss configuration attached to a position */
export interface StopLossOrder {
  id: string;
  tokenId: string;
  conditionId: string;
  marketTitle: string;
  outcome: string;

  // Position data
  entryPrice: number;
  shares: number;

  // Stop-loss levels
  initialStopPrice: number;       // Hard floor: always sell if price hits this
  currentStopPrice: number;       // Trailing stop: moves up as price rises
  trailingPercent: number;        // How close the trail follows (e.g. 10 = stop at price * 0.90)

  // Profit lock-in: once profit exceeds threshold, raise stop to break-even
  profitLockEnabled: boolean;
  profitLockThreshold: number;    // Price above entry that triggers lock (e.g. 0.15 = 15 cents)
  profitLockLevel: number;        // Where to set stop when lock triggers (e.g. entryPrice)
  profitLocked: boolean;          // Has profit lock been activated?

  // State
  highWaterMark: number;          // Highest price seen since entry
  isActive: boolean;
  triggeredAt?: string;
  triggeredPrice?: number;
  cancelledAt?: string;           // Set when manually cancelled (vs triggered by price)
  createdAt: string;
}

/** Configuration for the stop-loss system */
export interface StopLossConfig {
  enabled: boolean;
  defaultTrailingPercent: number;  // Default trailing percentage
  defaultInitialStopPercent: number; // Default initial stop: entry - X%
  profitLockEnabled: boolean;
  defaultProfitLockThreshold: number;
  checkIntervalMs: number;        // How often to check prices
}

const DEFAULT_SL_CONFIG: StopLossConfig = {
  enabled: false,
  defaultTrailingPercent: 15,
  defaultInitialStopPercent: 25,
  profitLockEnabled: true,
  defaultProfitLockThreshold: 0.15,
  checkIntervalMs: 30000,
};

// ============================================================================
// SMART STOP-LOSS MANAGER
// ============================================================================

export class SmartStopLossManager {
  private orders: StopLossOrder[] = [];
  private config: StopLossConfig;
  private tenantSync: string | null = null;

  constructor() {
    this.config = { ...DEFAULT_SL_CONFIG };
  }

  async init(): Promise<void> {
    if (isHostedMultiTenantMode() && !getTenantId()) {
      log.info('[StopLoss] Hosted mode startup: deferring stop-loss preload until tenant context exists');
      return;
    }
    await this.loadState();
    this.tenantSync = getTenantIdStrict();
    log.info(`[StopLoss] Loaded ${this.orders.filter(o => o.isActive).length} active stop-loss order(s)`);
  }

  /** Reload stop-loss state from Storage for the current tenant (HTTP request isolation). */
  async syncFromCurrentTenant(): Promise<void> {
    const tid = getTenantIdStrict();
    if (this.tenantSync === tid) return;
    await this.loadState();
    this.tenantSync = tid;
  }

  /**
   * Create a stop-loss order for a position.
   */
  createStopLoss(
    tokenId: string,
    conditionId: string,
    marketTitle: string,
    outcome: string,
    entryPrice: number,
    shares: number,
    overrides?: Partial<Pick<StopLossOrder, 'initialStopPrice' | 'trailingPercent' | 'profitLockThreshold'>>
  ): StopLossOrder {
    const trailingPercent = overrides?.trailingPercent ?? this.config.defaultTrailingPercent;
    const initialStopPrice = overrides?.initialStopPrice
      ?? Math.max(0.01, entryPrice * (1 - this.config.defaultInitialStopPercent / 100));

    const order: StopLossOrder = {
      id: `sl-${tokenId}-${Date.now()}`,
      tokenId,
      conditionId,
      marketTitle,
      outcome,
      entryPrice,
      shares,
      initialStopPrice,
      currentStopPrice: initialStopPrice,
      trailingPercent,
      profitLockEnabled: this.config.profitLockEnabled,
      profitLockThreshold: overrides?.profitLockThreshold ?? this.config.defaultProfitLockThreshold,
      profitLockLevel: entryPrice, // Lock at break-even
      profitLocked: false,
      highWaterMark: entryPrice,
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    this.orders.push(order);
    this.saveState().catch(err => log.error('[StopLoss] Save failed:', err.message));
    return order;
  }

  /**
   * Update all stop-loss orders with current prices.
   * Returns orders that should be triggered (price <= stop).
   */
  updatePrices(priceMap: Map<string, number>): StopLossOrder[] {
    const triggered: StopLossOrder[] = [];

    for (const order of this.orders) {
      if (!order.isActive) continue;

      const currentPrice = priceMap.get(order.tokenId);
      if (currentPrice === undefined) continue;

      // Update high-water mark
      if (currentPrice > order.highWaterMark) {
        order.highWaterMark = currentPrice;

        // Trailing stop: move stop price up
        const newTrailingStop = currentPrice * (1 - order.trailingPercent / 100);
        if (newTrailingStop > order.currentStopPrice) {
          order.currentStopPrice = newTrailingStop;
        }
      }

      // Profit lock: once price exceeds entry + threshold, lock stop at break-even
      let justLocked = false;
      if (
        order.profitLockEnabled &&
        !order.profitLocked &&
        currentPrice >= order.entryPrice + order.profitLockThreshold
      ) {
        order.profitLocked = true;
        justLocked = true;
        // Raise stop to at least break-even
        if (order.currentStopPrice < order.profitLockLevel) {
          order.currentStopPrice = order.profitLockLevel;
        }
        log.info(
          `[StopLoss] Profit lock activated for ${order.marketTitle}: ` +
          `stop raised to ${order.currentStopPrice.toFixed(4)}`
        );
      }

      // Check if triggered (skip if profit lock just activated this tick —
      // give the position one more price check before potentially selling)
      if (!justLocked && currentPrice <= order.currentStopPrice) {
        order.isActive = false;
        order.triggeredAt = new Date().toISOString();
        order.triggeredPrice = currentPrice;
        triggered.push(order);
        log.info(
          `[StopLoss] TRIGGERED: ${order.marketTitle} ${order.outcome} ` +
          `@ ${currentPrice.toFixed(4)} (stop: ${order.currentStopPrice.toFixed(4)})`
        );
      }
    }

    if (triggered.length > 0) {
      this.saveState().catch(err => log.error('[StopLoss] Save failed:', err.message));
    }

    return triggered;
  }

  /**
   * Cancel a stop-loss order.
   */
  cancelStopLoss(orderId: string): void {
    const order = this.orders.find(o => o.id === orderId);
    if (order) {
      order.isActive = false;
      order.cancelledAt = new Date().toISOString();
      this.saveState().catch(err => log.error('[StopLoss] Save failed:', err.message));
    }
  }

  /**
   * Get all stop-loss orders.
   */
  getOrders(activeOnly = false): StopLossOrder[] {
    return activeOnly
      ? this.orders.filter(o => o.isActive)
      : [...this.orders];
  }

  /**
   * Get a single order.
   */
  getOrder(orderId: string): StopLossOrder | undefined {
    return this.orders.find(o => o.id === orderId);
  }

  /**
   * Get config.
   */
  getConfig(): StopLossConfig { return { ...this.config }; }

  /**
   * Update config.
   */
  async updateConfig(updates: Partial<StopLossConfig>): Promise<void> {
    Object.assign(this.config, updates);
    await this.saveState();
  }

  getStatus() {
    const active = this.orders.filter(o => o.isActive);
    const triggered = this.orders.filter(o => !o.isActive && o.triggeredPrice !== undefined);
    return {
      config: this.getConfig(),
      activeOrders: active.length,
      triggeredOrders: triggered.length,
      totalOrders: this.orders.length,
      profitLockedCount: active.filter(o => o.profitLocked).length,
    };
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  private async loadState(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      if (cfg.stopLossConfig) this.config = { ...DEFAULT_SL_CONFIG, ...cfg.stopLossConfig };
      if (cfg.stopLossOrders) this.orders = cfg.stopLossOrders;
    } catch { /* defaults */ }
  }

  private async saveState(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      cfg.stopLossConfig = this.config;
      cfg.stopLossOrders = this.orders;
      await Storage.saveConfig(cfg);
      this.tenantSync = getTenantIdStrict();
    } catch (err: any) {
      log.error({ detail: err.message }, '[StopLoss] Failed to save')
    }
  }
}
