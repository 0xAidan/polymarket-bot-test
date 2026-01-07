import { WalletMonitor } from './walletMonitor.js';
import { WebSocketMonitor } from './websocketMonitor.js';
import { TradeExecutor } from './tradeExecutor.js';
import { PerformanceTracker } from './performanceTracker.js';
import { BalanceTracker } from './balanceTracker.js';
import { DetectedTrade, TradeOrder, TradeResult } from './types.js';
import { Storage } from './storage.js';
import { config } from './config.js';

/**
 * Main copy trading engine that coordinates monitoring and execution
 * Handles trade detection, execution, and performance tracking
 */
export class CopyTrader {
  private monitor: WalletMonitor;
  private websocketMonitor: WebSocketMonitor;
  private executor: TradeExecutor;
  private performanceTracker: PerformanceTracker;
  private balanceTracker: BalanceTracker;
  private isRunning = false;
  private executedTrades = new Set<string>(); // Track executed trades by tx hash
  private processedTrades = new Map<string, number>(); // Track processed trades by unique key (wallet-market-outcome-side-timestamp) to prevent duplicates

  constructor() {
    this.monitor = new WalletMonitor();
    this.websocketMonitor = new WebSocketMonitor();
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
      await this.websocketMonitor.initialize();
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

    // Start polling monitoring (PRIMARY METHOD - most reliable for monitoring other wallets)
    // WebSocket API only monitors YOUR OWN trades, not other wallets
    console.log('🔄 Starting polling monitoring (PRIMARY METHOD)...');
    await this.monitor.startMonitoring(async (trade: DetectedTrade) => {
      console.log(`[CopyTrader] 📥 Polling callback triggered with trade:`, JSON.stringify(trade, null, 2));
      await this.handleDetectedTrade(trade);
    });
    console.log('✅ Polling monitoring active');

    // Start WebSocket monitoring (secondary - only works for your own trades)
    // Note: WebSocket API can only monitor the authenticated user's trades, not other wallets
    console.log('📡 Starting WebSocket monitoring (secondary - your trades only)...');
    try {
      await this.websocketMonitor.startMonitoring(async (trade: DetectedTrade) => {
        console.log(`[CopyTrader] 📥 WebSocket callback triggered with trade:`, JSON.stringify(trade, null, 2));
        await this.handleDetectedTrade(trade);
      });
      const wsStatus = this.websocketMonitor.getStatus();
      if (wsStatus.isConnected) {
        console.log('✅ WebSocket monitoring active (for your own trades only)');
      } else {
        console.log('⚠️ WebSocket not connected (this is OK - polling is primary)');
      }
    } catch (error: any) {
      console.error('❌ Failed to start WebSocket monitoring:', error.message);
      console.log('⚠️ Continuing with polling-based monitoring (this is fine)');
    }

    // Start balance tracking
    const userWallet = this.getWalletAddress();
    const trackedWallets = await Storage.getActiveWallets();
    const allWallets = userWallet 
      ? [userWallet, ...trackedWallets.map(w => w.address)]
      : trackedWallets.map(w => w.address);
    
    if (allWallets.length > 0) {
      await this.balanceTracker.startTracking(allWallets);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ COPY TRADING BOT IS RUNNING');
    console.log('='.repeat(60));
    console.log(`📊 Monitoring Methods:`);
    console.log(`   🔄 Polling: ✅ ACTIVE (Primary - checks every ${config.monitoringIntervalMs / 1000}s)`);
    const wsStatus = this.websocketMonitor.getStatus();
    console.log(`   📡 WebSocket: ${wsStatus.isConnected ? '✅ CONNECTED' : '⚠️  DISCONNECTED'} (Secondary - your trades only)`);
    console.log(`\n💡 The bot will automatically detect and copy trades from tracked wallets.`);
    console.log(`   Check the logs above for trade detection and execution.`);
    console.log('='.repeat(60) + '\n');
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
    this.websocketMonitor.stopMonitoring();
    this.monitor.stopMonitoring();
    this.balanceTracker.stopTracking();
    console.log('Copy trading bot stopped');
  }

  /**
   * Handle a detected trade from a tracked wallet
   */
  private async handleDetectedTrade(trade: DetectedTrade): Promise<void> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔔 [CopyTrader] HANDLE_DETECTED_TRADE CALLED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`   Trade object:`, JSON.stringify(trade, null, 2));
    console.log(`${'='.repeat(60)}\n`);
    
    // Prevent duplicate execution using transaction hash
    if (this.executedTrades.has(trade.transactionHash)) {
      console.log(`[CopyTrader] ⏭️  Trade ${trade.transactionHash} already executed, skipping`);
      return;
    }
    
    // Also check for duplicate trades using a composite key (wallet + market + outcome + side + timestamp within 5 min window)
    // This prevents processing the same trade multiple times if detected from different sources
    const tradeKey = `${trade.walletAddress}-${trade.marketId}-${trade.outcome}-${trade.side}-${Math.floor(trade.timestamp.getTime() / (5 * 60 * 1000))}`;
    const lastProcessed = this.processedTrades.get(tradeKey);
    const now = Date.now();
    
    // Clean up old entries (older than 1 hour)
    for (const [key, timestamp] of this.processedTrades.entries()) {
      if (now - timestamp > 60 * 60 * 1000) {
        this.processedTrades.delete(key);
      }
    }
    
    if (lastProcessed && (now - lastProcessed) < 5 * 60 * 1000) {
      console.log(`[CopyTrader] ⏭️  Similar trade already processed recently (key: ${tradeKey}), skipping duplicate`);
      return;
    }
    
    // Mark as processed
    this.processedTrades.set(tradeKey, now);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔔 TRADE DETECTED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`   Wallet: ${trade.walletAddress}`);
    console.log(`   Market: ${trade.marketId}`);
    console.log(`   Outcome: ${trade.outcome}`);
    console.log(`   Amount: ${trade.amount} shares`);
    console.log(`   Price: ${trade.price}`);
    console.log(`   Side: ${trade.side}`);
    console.log(`   TX: ${trade.transactionHash}`);
    console.log(`${'='.repeat(60)}`);

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
      
      console.log(`[Trade] Using configured trade size: ${configuredTradeSize} shares`);
      
      // Convert detected trade to trade order
      const order: TradeOrder = {
        marketId: trade.marketId,
        outcome: trade.outcome,
        amount: configuredTradeSize, // Use configured trade size instead of detected amount
        price: trade.price,
        side: trade.side // Use the side detected from the tracked wallet's trade
      };

      console.log(`\n🚀 [Execute] EXECUTING TRADE:`);
      console.log(`   Action: ${order.side}`);
      console.log(`   Amount: ${order.amount} shares`);
      console.log(`   Market: ${order.marketId}`);
      console.log(`   Outcome: ${order.outcome}`);
      console.log(`   Price: ${order.price}`);
      console.log(`   Time: ${new Date().toISOString()}`);
      
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
        console.log(`\n${'='.repeat(60)}`);
        console.log(`✅ [Execute] TRADE EXECUTED SUCCESSFULLY!`);
        console.log(`${'='.repeat(60)}`);
        console.log(`   Order ID: ${result.orderId}`);
        console.log(`   TX Hash: ${result.transactionHash || 'Pending'}`);
        console.log(`   Execution Time: ${executionTime}ms`);
        console.log(`   Market: ${order.marketId}`);
        console.log(`   Outcome: ${order.outcome}`);
        console.log(`   Side: ${order.side} ${order.amount} @ ${order.price}`);
        console.log(`${'='.repeat(60)}\n`);
        this.executedTrades.add(trade.transactionHash);
      } else {
        console.error(`\n${'='.repeat(60)}`);
        console.error(`❌ [Execute] TRADE EXECUTION FAILED`);
        console.error(`${'='.repeat(60)}`);
        console.error(`   Error: ${result.error}`);
        console.error(`   Market: ${order.marketId}`);
        console.error(`   Side: ${order.side} ${order.amount} @ ${order.price}`);
        console.error(`${'='.repeat(60)}\n`);
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
  getStatus(): { 
    running: boolean; 
    executedTradesCount: number;
    websocketStatus: ReturnType<WebSocketMonitor['getStatus']>;
  } {
    return {
      running: this.isRunning,
      executedTradesCount: this.executedTrades.size,
      websocketStatus: this.websocketMonitor.getStatus()
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
      await this.websocketMonitor.reloadWallets();
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
   * Get the WebSocket monitor instance (for direct access if needed)
   */
  getWebSocketMonitor(): WebSocketMonitor {
    return this.websocketMonitor;
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
