import { getAdapter, isPlatformConfigured } from './platform/platformRegistry.js';
import type { Platform, NormalizedOrderResult, PlaceOrderRequest } from './platform/types.js';
import { Storage } from './storage.js';

// ============================================================================
// Cross-Platform Executor
// Handles simultaneous execution across Polymarket + Kalshi
// ============================================================================

export interface ArbPairTrade {
  id: string;
  eventTitle: string;
  buyPlatform: Platform;
  buyMarketId: string;
  buySide: 'YES' | 'NO';
  buyPrice: number;
  buySize: number;
  sellPlatform: Platform;
  sellMarketId: string;
  sellSide: 'YES' | 'NO';
  sellPrice: number;
  sellSize: number;
  expectedProfit: number;
  spreadPercent: number;
}

export interface ExecutionResult {
  arbId: string;
  timestamp: string;
  buyResult: NormalizedOrderResult;
  sellResult: NormalizedOrderResult;
  bothSucceeded: boolean;
  partialFill: boolean;
  paperMode: boolean;
}

export interface ExecutorConfig {
  paperMode: boolean;
  maxTradeSize: number;    // Max USD per leg
  minSpread: number;       // Minimum spread % to execute (e.g., 3 = 3%)
  simultaneousExecution: boolean;  // Execute both legs at same time
  autoRetry: boolean;
  maxRetries: number;
}

const DEFAULT_CONFIG: ExecutorConfig = {
  paperMode: true,
  maxTradeSize: 50,
  minSpread: 2,
  simultaneousExecution: true,
  autoRetry: false,
  maxRetries: 1,
};

export class CrossPlatformExecutor {
  private config: ExecutorConfig = { ...DEFAULT_CONFIG };
  private executionHistory: ExecutionResult[] = [];

  async init(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      if (cfg.crossPlatformExecutorConfig) {
        this.config = { ...DEFAULT_CONFIG, ...cfg.crossPlatformExecutorConfig };
      }
      this.executionHistory = cfg.crossPlatformExecutionHistory ?? [];
    } catch { /* defaults */ }
    console.log(`[CrossPlatformExecutor] Ready (paperMode=${this.config.paperMode})`);
  }

  /**
   * Execute an arbitrage pair trade: buy on one platform, sell on the other.
   */
  async executeArbPair(trade: ArbPairTrade): Promise<ExecutionResult> {
    console.log(`[CrossPlatformExecutor] Executing arb: ${trade.eventTitle}`);
    console.log(`  BUY ${trade.buySide} on ${trade.buyPlatform} @ ${trade.buyPrice} (${trade.buySize} contracts)`);
    console.log(`  SELL ${trade.sellSide} on ${trade.sellPlatform} @ ${trade.sellPrice} (${trade.sellSize} contracts)`);
    console.log(`  Expected profit: $${trade.expectedProfit.toFixed(2)} (${trade.spreadPercent.toFixed(1)}% spread)`);

    // Validate spread
    if (trade.spreadPercent < this.config.minSpread) {
      const result: ExecutionResult = {
        arbId: trade.id,
        timestamp: new Date().toISOString(),
        buyResult: { platform: trade.buyPlatform, success: false, error: `Spread ${trade.spreadPercent.toFixed(1)}% below minimum ${this.config.minSpread}%` },
        sellResult: { platform: trade.sellPlatform, success: false, error: 'Skipped due to low spread' },
        bothSucceeded: false,
        partialFill: false,
        paperMode: this.config.paperMode,
      };
      this.executionHistory.push(result);
      await this.saveHistory();
      return result;
    }

    // Validate size limits
    const buyValue = trade.buyPrice * trade.buySize;
    const sellValue = trade.sellPrice * trade.sellSize;
    if (buyValue > this.config.maxTradeSize || sellValue > this.config.maxTradeSize) {
      const result: ExecutionResult = {
        arbId: trade.id,
        timestamp: new Date().toISOString(),
        buyResult: { platform: trade.buyPlatform, success: false, error: `Buy value $${buyValue.toFixed(2)} exceeds max $${this.config.maxTradeSize}` },
        sellResult: { platform: trade.sellPlatform, success: false, error: 'Skipped due to size limit' },
        bothSucceeded: false,
        partialFill: false,
        paperMode: this.config.paperMode,
      };
      this.executionHistory.push(result);
      await this.saveHistory();
      return result;
    }

    // Paper mode simulation
    if (this.config.paperMode) {
      console.log(`[CrossPlatformExecutor] PAPER MODE: simulating execution`);
      const result: ExecutionResult = {
        arbId: trade.id,
        timestamp: new Date().toISOString(),
        buyResult: { platform: trade.buyPlatform, success: true, orderId: `paper-${Date.now()}-buy`, status: 'filled' },
        sellResult: { platform: trade.sellPlatform, success: true, orderId: `paper-${Date.now()}-sell`, status: 'filled' },
        bothSucceeded: true,
        partialFill: false,
        paperMode: true,
      };
      this.executionHistory.push(result);
      await this.saveHistory();
      return result;
    }

    // Live execution
    const buyOrder: PlaceOrderRequest = {
      platform: trade.buyPlatform,
      marketId: trade.buyMarketId,
      side: trade.buySide,
      action: 'BUY',
      size: trade.buySize,
      price: trade.buyPrice,
    };

    const sellOrder: PlaceOrderRequest = {
      platform: trade.sellPlatform,
      marketId: trade.sellMarketId,
      side: trade.sellSide,
      action: 'SELL',
      size: trade.sellSize,
      price: trade.sellPrice,
    };

    let buyResult: NormalizedOrderResult;
    let sellResult: NormalizedOrderResult;

    if (this.config.simultaneousExecution) {
      // Execute both legs simultaneously
      [buyResult, sellResult] = await Promise.all([
        getAdapter(trade.buyPlatform).placeOrder(buyOrder),
        getAdapter(trade.sellPlatform).placeOrder(sellOrder),
      ]);
    } else {
      // Sequential: buy first, then sell
      buyResult = await getAdapter(trade.buyPlatform).placeOrder(buyOrder);
      if (buyResult.success) {
        sellResult = await getAdapter(trade.sellPlatform).placeOrder(sellOrder);
      } else {
        sellResult = { platform: trade.sellPlatform, success: false, error: 'Skipped: buy leg failed' };
      }
    }

    const result: ExecutionResult = {
      arbId: trade.id,
      timestamp: new Date().toISOString(),
      buyResult,
      sellResult,
      bothSucceeded: buyResult.success && sellResult.success,
      partialFill: buyResult.success !== sellResult.success,
      paperMode: false,
    };

    if (result.partialFill) {
      console.warn(`[CrossPlatformExecutor] PARTIAL FILL on arb ${trade.id}! One leg succeeded, the other failed.`);
    }

    this.executionHistory.push(result);
    await this.saveHistory();

    return result;
  }

  /**
   * Execute a hedge recommendation: place trade on specified platform.
   */
  async executeHedge(params: {
    platform: Platform;
    marketId: string;
    side: 'YES' | 'NO';
    action: 'BUY' | 'SELL';
    size: number;
    price: number;
  }): Promise<NormalizedOrderResult> {
    if (this.config.paperMode) {
      console.log(`[CrossPlatformExecutor] PAPER HEDGE: ${params.action} ${params.side} on ${params.platform} (${params.size} @ $${params.price})`);
      return { platform: params.platform, success: true, orderId: `paper-hedge-${Date.now()}`, status: 'filled' };
    }

    return getAdapter(params.platform).placeOrder({
      platform: params.platform,
      marketId: params.marketId,
      side: params.side,
      action: params.action,
      size: params.size,
      price: params.price,
    });
  }

  // ============================================================
  // STATUS
  // ============================================================

  getStatus() {
    return {
      paperMode: this.config.paperMode,
      maxTradeSize: this.config.maxTradeSize,
      minSpread: this.config.minSpread,
      simultaneousExecution: this.config.simultaneousExecution,
      totalExecutions: this.executionHistory.length,
      successfulArbs: this.executionHistory.filter(e => e.bothSucceeded).length,
      partialFills: this.executionHistory.filter(e => e.partialFill).length,
      platformStatus: {
        polymarket: { configured: isPlatformConfigured('polymarket'), canExecute: getAdapter('polymarket').canExecute() },
        kalshi: { configured: isPlatformConfigured('kalshi'), canExecute: getAdapter('kalshi').canExecute() },
      },
    };
  }

  getHistory(): ExecutionResult[] {
    return [...this.executionHistory];
  }

  getConfig(): ExecutorConfig {
    return { ...this.config };
  }

  async updateConfig(partial: Partial<ExecutorConfig>): Promise<ExecutorConfig> {
    this.config = { ...this.config, ...partial };
    try {
      const cfg = await Storage.loadConfig();
      cfg.crossPlatformExecutorConfig = this.config;
      await Storage.saveConfig(cfg);
    } catch { /* ignore */ }
    return this.config;
  }

  private async saveHistory(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      // Keep last 200 executions
      cfg.crossPlatformExecutionHistory = this.executionHistory.slice(-200);
      await Storage.saveConfig(cfg);
    } catch { /* ignore */ }
  }
}
