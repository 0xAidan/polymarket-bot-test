import { WalletMonitor } from './walletMonitor.js';
import { TradeExecutor } from './tradeExecutor.js';
import { PerformanceTracker } from './performanceTracker.js';
import { DetectedTrade, TradeOrder, TradeResult } from './types.js';

/**
 * Main copy trading engine that coordinates monitoring and execution
 */
export class CopyTrader {
  private monitor: WalletMonitor;
  private executor: TradeExecutor;
  private performanceTracker: PerformanceTracker;
  private isRunning = false;
  private executedTrades = new Set<string>(); // Track executed trades by tx hash

  constructor() {
    this.monitor = new WalletMonitor();
    this.executor = new TradeExecutor();
    this.performanceTracker = new PerformanceTracker();
  }

  /**
   * Initialize the copy trader
   */
  async initialize(): Promise<void> {
    try {
      await this.performanceTracker.initialize();
      await this.monitor.initialize();
      await this.executor.authenticate();
      console.log('Copy trader initialized');
    } catch (error: any) {
      await this.performanceTracker.logIssue(
        'error',
        'other',
        'Failed to initialize copy trader',
        { error: error.message }
      );
      throw error;
    }
  }

  /**
   * Start the copy trading bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Copy trader is already running');
      return;
    }

    console.log('Starting copy trading bot...');
    this.isRunning = true;

    // Start monitoring wallets
    await this.monitor.startMonitoring(async (trade: DetectedTrade) => {
      await this.handleDetectedTrade(trade);
    });

    console.log('Copy trading bot is running');
  }

  /**
   * Stop the copy trading bot
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    console.log('Stopping copy trading bot...');
    this.isRunning = false;
    this.monitor.stopMonitoring();
    console.log('Copy trading bot stopped');
  }

  /**
   * Handle a detected trade from a tracked wallet
   */
  private async handleDetectedTrade(trade: DetectedTrade): Promise<void> {
    // Prevent duplicate execution
    if (this.executedTrades.has(trade.transactionHash)) {
      console.log(`Trade ${trade.transactionHash} already executed, skipping`);
      return;
    }

    console.log(`\n=== Detected Trade ===`);
    console.log(`Wallet: ${trade.walletAddress}`);
    console.log(`Market: ${trade.marketId}`);
    console.log(`Outcome: ${trade.outcome}`);
    console.log(`Amount: ${trade.amount}`);
    console.log(`Price: ${trade.price}`);
    console.log(`TX: ${trade.transactionHash}`);

    const executionStart = Date.now();

    try {
      // Convert detected trade to trade order
      const order: TradeOrder = {
        marketId: trade.marketId,
        outcome: trade.outcome,
        amount: trade.amount,
        price: trade.price,
        side: 'BUY' // TODO: Determine buy/sell from trade data
      };

      // Execute the trade
      const result: TradeResult = await this.executor.executeTrade(order);
      const executionTime = Date.now() - executionStart;

      // Record metrics
      await this.performanceTracker.recordTrade({
        timestamp: new Date(),
        walletAddress: trade.walletAddress,
        marketId: trade.marketId,
        outcome: trade.outcome,
        amount: trade.amount,
        price: trade.price,
        success: result.success,
        executionTimeMs: executionTime,
        error: result.error,
        orderId: result.orderId,
        transactionHash: result.transactionHash,
        detectedTxHash: trade.transactionHash
      });

      if (result.success) {
        console.log(`✅ Trade executed successfully!`);
        console.log(`Order ID: ${result.orderId}`);
        console.log(`TX: ${result.transactionHash}`);
        console.log(`⏱️  Execution time: ${executionTime}ms`);
        this.executedTrades.add(trade.transactionHash);
      } else {
        console.error(`❌ Trade execution failed: ${result.error}`);
        await this.performanceTracker.logIssue(
          'error',
          'trade_execution',
          `Trade execution failed: ${result.error}`,
          { trade, executionTimeMs: executionTime }
        );
      }
    } catch (error: any) {
      const executionTime = Date.now() - executionStart;
      console.error(`Error handling trade: ${error.message}`);

      // Record failed trade
      await this.performanceTracker.recordTrade({
        timestamp: new Date(),
        walletAddress: trade.walletAddress,
        marketId: trade.marketId,
        outcome: trade.outcome,
        amount: trade.amount,
        price: trade.price,
        success: false,
        executionTimeMs: executionTime,
        error: error.message,
        detectedTxHash: trade.transactionHash
      });

      await this.performanceTracker.logIssue(
        'error',
        'trade_execution',
        `Error handling trade: ${error.message}`,
        { trade, error: error.stack }
      );
    }
  }

  /**
   * Get status of the copy trader
   */
  getStatus(): { running: boolean; executedTradesCount: number } {
    return {
      running: this.isRunning,
      executedTradesCount: this.executedTrades.size
    };
  }

  /**
   * Get performance tracker instance
   */
  getPerformanceTracker(): PerformanceTracker {
    return this.performanceTracker;
  }

  /**
   * Get the wallet address used for executing trades
   */
  getWalletAddress(): string | null {
    try {
      return this.executor.getWalletAddress();
    } catch {
      return null;
    }
  }
}
