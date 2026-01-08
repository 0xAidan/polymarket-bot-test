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
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-DUPLICATE_CHECK',message:'Duplicate trade check',data:{tradeKey,lastProcessed:lastProcessed||null,now,timeSinceLastProcessed:lastProcessed?(now-lastProcessed):null,isDuplicate:lastProcessed&&(now-lastProcessed)<5*60*1000,processedTradesCount:this.processedTrades.size},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H4'})}).catch(()=>{});
    // #endregion
    
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
    
    // ============================================================
    // POLYMARKET PRICE LIMITS: 0.01 to 0.99
    // ============================================================
    // Skip trades where price is too low or too high to execute
    // These are typically "long shot" bets or nearly-resolved markets
    const MIN_EXECUTABLE_PRICE = 0.01;
    const MAX_EXECUTABLE_PRICE = 0.99;
    
    if (priceNum < MIN_EXECUTABLE_PRICE) {
      console.log(`\n⏭️  [CopyTrader] SKIPPING TRADE - Price too low`);
      console.log(`   Price: $${trade.price} (minimum executable: $${MIN_EXECUTABLE_PRICE})`);
      console.log(`   Market: ${trade.marketId}`);
      console.log(`   Outcome: ${trade.outcome}`);
      console.log(`   💡 This is a "long shot" bet with price below 1 cent. Cannot copy via API.\n`);
      // Don't log as error - this is expected behavior for cheap bets
      return;
    }
    
    if (priceNum > MAX_EXECUTABLE_PRICE) {
      console.log(`\n⏭️  [CopyTrader] SKIPPING TRADE - Price too high`);
      console.log(`   Price: $${trade.price} (maximum executable: $${MAX_EXECUTABLE_PRICE})`);
      console.log(`   Market: ${trade.marketId}`);
      console.log(`   Outcome: ${trade.outcome}`);
      console.log(`   💡 This market is nearly resolved. Cannot copy via API.\n`);
      // Don't log as error - this is expected behavior for nearly-resolved markets
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
      // Get configured trade size in USDC and calculate shares based on price
      const configuredTradeSizeUsdc = await Storage.getTradeSize();
      const tradeSizeUsdcNum = parseFloat(configuredTradeSizeUsdc || '0');
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-TRADE_SIZE',message:'Trade size calculation',data:{configuredTradeSizeUsdc,tradeSizeUsdcNum,priceNum,calculatedShares:tradeSizeUsdcNum/priceNum,minSharesRequired:5,willSkip:(tradeSizeUsdcNum/priceNum)<5},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
      // #endregion
      
      if (isNaN(tradeSizeUsdcNum) || tradeSizeUsdcNum <= 0) {
        console.error(`❌ Invalid configured trade size (${configuredTradeSizeUsdc} USDC), cannot execute trade`);
        await this.performanceTracker.logIssue(
          'error',
          'trade_execution',
          `Invalid configured trade size: ${configuredTradeSizeUsdc} USDC`,
          { trade }
        );
        return;
      }
      
      // Calculate number of shares based on USDC amount and price
      // shares = USDC amount / price per share
      const sharesAmount = tradeSizeUsdcNum / priceNum;
      const sharesAmountRounded = parseFloat(sharesAmount.toFixed(2)); // Round to 2 decimal places
      
      console.log(`[Trade] Configured trade size: $${configuredTradeSizeUsdc} USDC`);
      console.log(`[Trade] Price per share: $${trade.price}`);
      console.log(`[Trade] Calculated shares: ${sharesAmountRounded} shares (${tradeSizeUsdcNum} / ${priceNum})`);
      
      // ============================================================
      // POLYMARKET MINIMUM ORDER REQUIREMENTS
      // ============================================================
      // Polymarket requires:
      // - Minimum 5 shares per order
      // - Minimum $1 order value
      const MIN_SHARES = 5;
      const MIN_ORDER_VALUE_USDC = 1;
      
      // Check minimum shares requirement
      if (sharesAmountRounded < MIN_SHARES) {
        const minUsdcNeeded = (MIN_SHARES * priceNum).toFixed(2);
        console.log(`\n⏭️  [CopyTrader] SKIPPING ORDER - BELOW MINIMUM SHARES`);
        console.log(`   Calculated shares: ${sharesAmountRounded} (minimum required: ${MIN_SHARES})`);
        console.log(`   Your trade size: $${configuredTradeSizeUsdc} USDC`);
        console.log(`   Price per share: $${trade.price}`);
        console.log(`   Minimum USDC needed at this price: $${minUsdcNeeded}`);
        console.log(`   💡 Increase your trade size to at least $${minUsdcNeeded} USDC to copy this trade\n`);
        await this.performanceTracker.logIssue(
          'warning',
          'trade_execution',
          `Order skipped: ${sharesAmountRounded} shares below minimum ${MIN_SHARES}. Need $${minUsdcNeeded} USDC at price $${trade.price}`,
          { trade, calculatedShares: sharesAmountRounded, minShares: MIN_SHARES }
        );
        return;
      }
      
      // Check minimum order value requirement
      const orderValueUsdc = sharesAmountRounded * priceNum;
      if (orderValueUsdc < MIN_ORDER_VALUE_USDC) {
        console.log(`\n⏭️  [CopyTrader] SKIPPING ORDER - BELOW MINIMUM VALUE`);
        console.log(`   Order value: $${orderValueUsdc.toFixed(2)} USDC (minimum required: $${MIN_ORDER_VALUE_USDC})`);
        console.log(`   💡 Increase your trade size to meet the $${MIN_ORDER_VALUE_USDC} minimum\n`);
        await this.performanceTracker.logIssue(
          'warning',
          'trade_execution',
          `Order skipped: $${orderValueUsdc.toFixed(2)} below minimum $${MIN_ORDER_VALUE_USDC}`,
          { trade, orderValue: orderValueUsdc }
        );
        return;
      }
      
      // ============================================================
      // SELL ORDER - CHECK IF WE OWN SHARES
      // ============================================================
      let finalSharesAmount = sharesAmountRounded;
      
      if (trade.side === 'SELL') {
        console.log(`\n🔍 [CopyTrader] SELL ORDER - Checking if we own shares...`);
        
        // Get user's positions to check if we own this token
        const userWallet = this.getWalletAddress();
        if (!userWallet) {
          console.log(`⏭️  [CopyTrader] SKIPPING SELL - Cannot determine user wallet`);
          return;
        }
        
        // Get proxy wallet for positions lookup
        const proxyWallet = await this.getProxyWalletAddress();
        const walletToCheck = proxyWallet || userWallet;
        
        try {
          const userPositions = await this.monitor.getApi().getUserPositions(walletToCheck);
          
          // Find position matching this tokenId
          const matchingPosition = userPositions.find((pos: any) => {
            // Match by asset (tokenId) - this is the unique identifier
            return pos.asset === trade.tokenId;
          });
          
          if (!matchingPosition || parseFloat(matchingPosition.size || '0') <= 0) {
            console.log(`\n⏭️  [CopyTrader] SKIPPING SELL ORDER - No shares owned`);
            console.log(`   Token ID: ${trade.tokenId?.substring(0, 20)}...`);
            console.log(`   Market: ${trade.marketId}`);
            console.log(`   Outcome: ${trade.outcome}`);
            console.log(`   You don't own any shares of this position to sell.\n`);
            // Don't log as error - this is expected behavior
            return;
          }
          
          const ownedShares = parseFloat(matchingPosition.size);
          console.log(`   ✓ Found position! You own ${ownedShares.toFixed(2)} shares`);
          
          // Limit sell to owned shares (can't sell more than we have)
          if (finalSharesAmount > ownedShares) {
            console.log(`   ⚠️  Adjusting sell amount: ${finalSharesAmount} → ${ownedShares.toFixed(2)} (can't sell more than owned)`);
            finalSharesAmount = parseFloat(ownedShares.toFixed(2));
            
            // Re-check minimum after adjustment
            if (finalSharesAmount < MIN_SHARES) {
              console.log(`\n⏭️  [CopyTrader] SKIPPING SELL - Owned shares (${finalSharesAmount}) below minimum (${MIN_SHARES})`);
              return;
            }
          }
          
          console.log(`   ✓ Proceeding to sell ${finalSharesAmount} shares\n`);
          
        } catch (positionError: any) {
          console.error(`❌ [CopyTrader] Failed to check positions:`, positionError.message);
          console.log(`⏭️  [CopyTrader] SKIPPING SELL - Cannot verify share ownership\n`);
          return;
        }
      }
      
      const sharesAmountStr = finalSharesAmount.toFixed(2);
      
      // Convert detected trade to trade order
      const order: TradeOrder = {
        marketId: trade.marketId,
        outcome: trade.outcome,
        amount: sharesAmountStr, // Calculated shares from USDC trade size
        price: trade.price,
        side: trade.side, // Use the side detected from the tracked wallet's trade
        tokenId: trade.tokenId,    // Pass token ID for direct CLOB execution (bypasses Gamma API)
        negRisk: trade.negRisk,    // Pass negative risk flag
      };

      console.log(`\n🚀 [Execute] EXECUTING TRADE:`);
      console.log(`   Action: ${order.side}`);
      console.log(`   Amount: $${configuredTradeSizeUsdc} USDC (${order.amount} shares)`);
      console.log(`   Market: ${order.marketId}`);
      console.log(`   Outcome: ${order.outcome}`);
      console.log(`   Price: ${order.price}`);
      console.log(`   Time: ${new Date().toISOString()}`);
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-EXECUTE',message:'About to execute trade via executor',data:{order,configuredTradeSizeUsdc,originalTrade:{walletAddress:trade.walletAddress,marketId:trade.marketId,outcome:trade.outcome,amount:trade.amount,price:trade.price,side:trade.side}},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1-H4'})}).catch(()=>{});
      // #endregion
      
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

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-RESULT',message:'Trade execution result received',data:{success:result.success,orderId:result.orderId,transactionHash:result.transactionHash,error:result.error,executionTimeMs:result.executionTimeMs},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1-H4'})}).catch(()=>{});
      // #endregion

      if (result.success) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`✅ [Execute] TRADE EXECUTED SUCCESSFULLY!`);
        console.log(`${'='.repeat(60)}`);
        console.log(`   Order ID: ${result.orderId}`);
        console.log(`   TX Hash: ${result.transactionHash || 'Pending'}`);
        console.log(`   Execution Time: ${executionTime}ms`);
        console.log(`   Market: ${order.marketId}`);
        console.log(`   Outcome: ${order.outcome}`);
        console.log(`   Side: ${order.side} $${configuredTradeSizeUsdc} USDC (${order.amount} shares) @ ${order.price}`);
        console.log(`${'='.repeat(60)}\n`);
        this.executedTrades.add(trade.transactionHash);
      } else {
        console.error(`\n${'='.repeat(60)}`);
        console.error(`❌ [Execute] TRADE EXECUTION FAILED`);
        console.error(`${'='.repeat(60)}`);
        console.error(`   Error: ${result.error}`);
        console.error(`   Market: ${order.marketId}`);
        console.error(`   Side: ${order.side} $${configuredTradeSizeUsdc} USDC (${order.amount} shares) @ ${order.price}`);
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
