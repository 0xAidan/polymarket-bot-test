import { WalletMonitor } from './walletMonitor.js';
import { TradeExecutor } from './tradeExecutor.js';
import { PerformanceTracker } from './performanceTracker.js';
import { BalanceTracker } from './balanceTracker.js';
import { DetectedTrade, TradeOrder, TradeResult } from './types.js';
import { Storage } from './storage.js';

/**
 * Main copy trading engine that coordinates monitoring and execution
 * Handles trade detection, execution, and performance tracking
 */
export class CopyTrader {
  private monitor: WalletMonitor;
  private executor: TradeExecutor;
  private performanceTracker: PerformanceTracker;
  private balanceTracker: BalanceTracker;
  private isRunning = false;
  private executedTrades = new Set<string>(); // Track executed trades by tx hash

  constructor() {
    this.monitor = new WalletMonitor();
    this.executor = new TradeExecutor();
    this.performanceTracker = new PerformanceTracker();
    this.balanceTracker = new BalanceTracker();
  }

  /**
   * Initialize the copy trader
   */
  async initialize(): Promise<void> {
    try {
      await this.performanceTracker.initialize();
      await this.monitor.initialize();
      await this.executor.authenticate();
      await this.balanceTracker.initialize();
      
      // Record initial balances for all wallets (user + tracked)
      const userWallet = this.getWalletAddress();
      const trackedWallets = await Storage.getActiveWallets();
      const allWallets = userWallet 
        ? [userWallet, ...trackedWallets.map(w => w.address)]
        : trackedWallets.map(w => w.address);
      
      // Record initial balances
      for (const address of allWallets) {
        try {
          await this.balanceTracker.recordBalance(address);
        } catch (error: any) {
          console.warn(`Failed to record initial balance for ${address}:`, error.message);
        }
      }
      
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

    // Start balance tracking
    const userWallet = this.getWalletAddress();
    const trackedWallets = await Storage.getActiveWallets();
    const allWallets = userWallet 
      ? [userWallet, ...trackedWallets.map(w => w.address)]
      : trackedWallets.map(w => w.address);
    
    if (allWallets.length > 0) {
      await this.balanceTracker.startTracking(allWallets);
    }

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
    this.balanceTracker.stopTracking();
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
    console.log(`Side: ${trade.side}`);
    console.log(`TX: ${trade.transactionHash}`);

    // Validate trade data before attempting execution
    const priceNum = parseFloat(trade.price || '0');
    const amountNum = parseFloat(trade.amount || '0');
    
    if (!trade.marketId || trade.marketId === 'unknown') {
      console.error(`❌ Invalid marketId (${trade.marketId}), cannot execute trade`);
      await this.performanceTracker.logIssue(
        'error',
        'trade_execution',
        `Invalid marketId: ${trade.marketId}`,
        { trade }
      );
      return;
    }
    
    if (!trade.price || trade.price === '0' || isNaN(priceNum) || priceNum <= 0 || priceNum > 1) {
      console.error(`❌ Invalid price (${trade.price}), cannot execute trade`);
      await this.performanceTracker.logIssue(
        'error',
        'trade_execution',
        `Invalid price: ${trade.price}`,
        { trade }
      );
      return;
    }
    
    if (!trade.side || (trade.side !== 'BUY' && trade.side !== 'SELL')) {
      console.error(`❌ Invalid side (${trade.side}), cannot execute trade`);
      await this.performanceTracker.logIssue(
        'error',
        'trade_execution',
        `Invalid side: ${trade.side}`,
        { trade }
      );
      return;
    }

    const executionStart = Date.now();

    try {
      // Get configured trade size instead of using the detected trade amount
      const configuredTradeSize = await Storage.getTradeSize();
      const tradeSizeNum = parseFloat(configuredTradeSize || '0');
      
      if (isNaN(tradeSizeNum) || tradeSizeNum <= 0) {
        console.error(`❌ Invalid configured trade size (${configuredTradeSize}), cannot execute trade`);
        await this.performanceTracker.logIssue(
          'error',
          'trade_execution',
          `Invalid configured trade size: ${configuredTradeSize}`,
          { trade }
        );
        return;
      }
      
      console.log(`Using configured trade size: ${configuredTradeSize} shares`);
      
      // Convert detected trade to trade order
      const order: TradeOrder = {
        marketId: trade.marketId,
        outcome: trade.outcome,
        amount: configuredTradeSize, // Use configured trade size instead of detected amount
        price: trade.price,
        side: trade.side // Use the side detected from the tracked wallet's trade
      };

      console.log(`Attempting to execute: ${order.side} ${order.amount} shares of ${order.marketId} (${order.outcome}) at ${order.price}`);
      
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

  /**
   * Get the proxy wallet address (where funds are actually held on Polymarket)
   */
  async getProxyWalletAddress(): Promise<string | null> {
    try {
      const eoaAddress = this.getWalletAddress();
      if (!eoaAddress) {
        return null;
      }
      return await this.monitor.getApi().getProxyWalletAddress(eoaAddress);
    } catch {
      return null;
    }
  }

  /**
   * Reload tracked wallets in the monitor
   * Should be called when wallets are added or removed
   */
  async reloadWallets(): Promise<void> {
    if (this.isRunning) {
      await this.monitor.reloadWallets();
      
      // Update balance tracking
      const userWallet = this.getWalletAddress();
      const trackedWallets = await Storage.getActiveWallets();
      const allWallets = userWallet 
        ? [userWallet, ...trackedWallets.map(w => w.address)]
        : trackedWallets.map(w => w.address);
      
      await this.balanceTracker.updateTrackedWallets(allWallets);
    }
  }

  /**
   * Get the wallet monitor instance (for direct access if needed)
   */
  getMonitor(): WalletMonitor {
    return this.monitor;
  }

  /**
   * Get the balance tracker instance
   */
  getBalanceTracker(): BalanceTracker {
    return this.balanceTracker;
  }

  /**
   * Get Polymarket API instance (via monitor)
   */
  getPolymarketApi(): import('./polymarketApi.js').PolymarketApi {
    return this.monitor.getApi();
  }
}
