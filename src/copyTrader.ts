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
  private processedTrades = new Map<string, number>(); // Track processed trades by tx hash to prevent duplicates
  private processedCompoundKeys = new Map<string, number>(); // Track by compound key (wallet-market-outcome-side-timeWindow) to catch same trade with different hashes

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
      
      // Record initial balance for user wallet only (not tracked wallets to reduce RPC calls)
      const userWallet = this.getWalletAddress();
      if (userWallet) {
        try {
          await this.balanceTracker.recordBalance(userWallet);
        } catch (error: any) {
          console.warn(`Failed to record initial balance for ${userWallet}:`, error.message);
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

    // Start balance tracking for user wallet only (reduces RPC calls significantly)
    const userWallet = this.getWalletAddress();
    if (userWallet) {
      await this.balanceTracker.startTracking([userWallet]);
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
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade',message:'handleDetectedTrade entry',data:{walletAddress:trade.walletAddress.substring(0,8),marketId:trade.marketId?.substring(0,20),price:trade.price,amount:trade.amount,side:trade.side,txHash:trade.transactionHash?.substring(0,20)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔔 [CopyTrader] HANDLE_DETECTED_TRADE CALLED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`   Trade object:`, JSON.stringify(trade, null, 2));
    console.log(`${'='.repeat(60)}\n`);
    
    // CRITICAL: Verify the wallet is actually in the active tracked wallets list
    // This prevents executing trades from wallets that were removed or never tracked
    const activeWallets = await Storage.getActiveWallets();
    const tradeWalletLower = trade.walletAddress.toLowerCase();
    const isWalletTracked = activeWallets.some(w => w.address.toLowerCase() === tradeWalletLower);
    
    if (!isWalletTracked) {
      console.error(`\n❌ [CopyTrader] SECURITY: Trade from wallet ${trade.walletAddress.substring(0, 8)}... is NOT in active tracked wallets!`);
      console.error(`   Active tracked wallets: ${activeWallets.map(w => w.address.substring(0, 8) + '...').join(', ')}`);
      console.error(`   This trade will NOT be executed for security reasons.`);
      await this.performanceTracker.logIssue(
        'error',
        'other',
        `Trade detected from untracked wallet: ${trade.walletAddress.substring(0, 8)}...`,
        { trade, activeWallets: activeWallets.map(w => w.address) }
      );
      return;
    }
    
    // Also check if this is the user's own wallet (should not be tracked)
    const userWallet = this.getWalletAddress();
    if (userWallet && userWallet.toLowerCase() === tradeWalletLower) {
      console.error(`\n❌ [CopyTrader] SECURITY: Trade detected from YOUR OWN wallet!`);
      console.error(`   Your wallet should not be in the tracked wallets list.`);
      console.error(`   This trade will NOT be executed.`);
      await this.performanceTracker.logIssue(
        'error',
        'other',
        `Trade detected from user's own wallet (should not be tracked): ${userWallet.substring(0, 8)}...`,
        { trade }
      );
      return;
    }
    
    // #region agent log
    const isSyntheticHash = trade.transactionHash?.startsWith('pos-') || trade.transactionHash?.startsWith('trade-') || trade.transactionHash?.startsWith('ws-');
    const executedTradesSize = this.executedTrades.size;
    const processedTradesSize = this.processedTrades.size;
    fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:dedupeCheck',message:'DEDUP CHECK - incoming trade',data:{txHash:trade.transactionHash?.substring(0,40),isSyntheticHash,alreadyInExecutedTrades:this.executedTrades.has(trade.transactionHash),executedTradesSize,processedTradesSize,walletAddress:trade.walletAddress.substring(0,8),marketId:trade.marketId?.substring(0,20)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2-H5'})}).catch(()=>{});
    // #endregion
    
    // Prevent duplicate execution using transaction hash
    if (this.executedTrades.has(trade.transactionHash)) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade',message:'Duplicate trade skipped',data:{txHash:trade.transactionHash?.substring(0,20)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      console.log(`[CopyTrader] ⏭️  Trade ${trade.transactionHash} already executed, skipping`);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-dupeTx',message:'Skipping - duplicate txHash',data:{txHash:trade.transactionHash?.substring(0,30)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
      // #endregion
      return;
    }
    
    // CRITICAL FIX: Use a COMPOUND KEY for deduplication
    // Problem: Position monitoring generates synthetic hashes (pos-...) while trade history has real hashes
    // This caused the SAME underlying trade to be detected twice and executed twice
    // Solution: Create a compound key based on market + outcome + price + rough timestamp
    // This catches duplicates even when transaction hashes differ
    const tradeTimestamp = trade.timestamp instanceof Date ? trade.timestamp.getTime() : Date.now();
    // Round timestamp to 5-minute windows to catch trades detected slightly apart
    const timeWindow = Math.floor(tradeTimestamp / (5 * 60 * 1000));
    const compoundKey = `${trade.walletAddress.toLowerCase()}-${trade.marketId}-${trade.outcome}-${trade.side}-${timeWindow}`;
    
    // Also track by transaction hash for exact duplicates
    const tradeKey = trade.transactionHash;
    
    // Clean up old entries (older than 1 hour)
    const now = Date.now();
    for (const [key, timestamp] of this.processedTrades.entries()) {
      if (now - timestamp > 60 * 60 * 1000) {
        this.processedTrades.delete(key);
      }
    }
    for (const [key, timestamp] of this.processedCompoundKeys.entries()) {
      if (now - timestamp > 60 * 60 * 1000) {
        this.processedCompoundKeys.delete(key);
      }
    }
    
    // #region agent log
    const alreadyProcessedByTxHash = this.processedTrades.has(tradeKey);
    const alreadyProcessedByCompoundKey = this.processedCompoundKeys.has(compoundKey);
    fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:dedupeCheck',message:'DEDUP CHECK - compound key',data:{txHash:tradeKey?.substring(0,40),compoundKey,alreadyProcessedByTxHash,alreadyProcessedByCompoundKey,isSyntheticHash:tradeKey?.startsWith('pos-')||tradeKey?.startsWith('trade-')},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'FIX'})}).catch(()=>{});
    // #endregion
    
    // CHECK 1: By transaction hash (exact duplicate)
    if (this.processedTrades.has(tradeKey)) {
      console.log(`[CopyTrader] ⏭️  Trade already processed (txHash: ${tradeKey?.substring(0,20)}...), skipping duplicate`);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-dupeKey',message:'Skipping - trade already processed (txHash)',data:{txHash:tradeKey?.substring(0,30)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
      // #endregion
      return;
    }
    
    // CHECK 2: By compound key (same trade detected with different hash - e.g., position vs trade history)
    if (this.processedCompoundKeys.has(compoundKey)) {
      console.log(`[CopyTrader] ⏭️  Trade already processed (compound key: ${compoundKey.substring(0, 30)}...), skipping duplicate detection`);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-dupeCompound',message:'Skipping - trade already processed (compound key)',data:{compoundKey,txHash:tradeKey?.substring(0,30)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'FIX'})}).catch(()=>{});
      // #endregion
      return;
    }
    
    // Mark as processed using both keys
    this.processedTrades.set(tradeKey, now);
    this.processedCompoundKeys.set(compoundKey, now);

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
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade',message:'Validation start',data:{marketId:trade.marketId,price:trade.price,priceNum,amount:trade.amount,amountNum,side:trade.side},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'G'})}).catch(()=>{});
    // #endregion
    
    if (!trade.marketId || trade.marketId === 'unknown') {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade',message:'Validation failed: marketId',data:{marketId:trade.marketId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'G'})}).catch(()=>{});
      // #endregion
      console.error(`❌ Invalid marketId (${trade.marketId}), cannot execute trade`);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-invalidMarket',message:'Skipping - invalid marketId',data:{marketId:trade.marketId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
      // #endregion
      await this.performanceTracker.logIssue(
        'error',
        'trade_execution',
        `Invalid marketId: ${trade.marketId}`,
        { trade }
      );
      return;
    }
    
    if (!trade.price || trade.price === '0' || isNaN(priceNum) || priceNum <= 0 || priceNum > 1) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade',message:'Validation failed: price',data:{price:trade.price,priceNum},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'G'})}).catch(()=>{});
      // #endregion
      console.error(`❌ Invalid price (${trade.price}), cannot execute trade`);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-invalidPrice',message:'Skipping - invalid price',data:{price:trade.price,priceNum:priceNum},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
      // #endregion
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
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade',message:'Validation failed: side',data:{side:trade.side},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'G'})}).catch(()=>{});
      // #endregion
      console.error(`❌ Invalid side (${trade.side}), cannot execute trade`);
      await this.performanceTracker.logIssue(
        'error',
        'trade_execution',
        `Invalid side: ${trade.side}`,
        { trade }
      );
      return;
    }
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade',message:'Validation passed',data:{marketId:trade.marketId,price:trade.price,side:trade.side},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'G'})}).catch(()=>{});
    // #endregion

    // ============================================================
    // POSITION THRESHOLD FILTER
    // ============================================================
    // Only copy trades that are above a % threshold of the tracked wallet's USDC balance
    // This filters out small "noise" trades like arbitrage or test trades
    try {
      const thresholdConfig = await Storage.getPositionThreshold();
      if (thresholdConfig.enabled) {
        // Get tracked wallet's USDC balance
        let walletBalance = 0;
        try {
          walletBalance = await this.balanceTracker.getBalance(trade.walletAddress);
        } catch (balanceError: any) {
          console.warn(`[CopyTrader] Could not fetch wallet balance for threshold check: ${balanceError.message}`);
          console.warn(`[CopyTrader] Proceeding with trade (threshold check skipped)`);
          // Continue with trade - don't block if balance fetch fails
        }
        
        if (walletBalance > 0) {
          // Calculate trade value in USD (amount * price)
          const tradeValueUsd = amountNum * priceNum;
          
          // Calculate percentage of wallet balance
          const tradePercent = (tradeValueUsd / walletBalance) * 100;
          
          if (tradePercent < thresholdConfig.percent) {
            console.log(`\n⏭️  [CopyTrader] FILTERED - Trade below position threshold`);
            console.log(`   Trade value: $${tradeValueUsd.toFixed(2)} (${tradePercent.toFixed(2)}% of wallet)`);
            console.log(`   Wallet USDC balance: $${walletBalance.toFixed(2)}`);
            console.log(`   Threshold: ${thresholdConfig.percent}%`);
            console.log(`   💡 This trade is likely noise/arbitrage. Skipping.\n`);
            
            // Record the filtered trade so it appears in the trade history
            await this.performanceTracker.recordTrade({
              timestamp: new Date(),
              walletAddress: trade.walletAddress,
              marketId: trade.marketId,
              outcome: trade.outcome,
              amount: trade.amount,
              price: trade.price,
              success: false,
              status: 'rejected',
              executionTimeMs: 0,
              error: `Filtered: Trade is ${tradePercent.toFixed(2)}% of wallet ($${tradeValueUsd.toFixed(2)}/$${walletBalance.toFixed(2)}), below ${thresholdConfig.percent}% threshold`,
              detectedTxHash: trade.transactionHash,
              tokenId: trade.tokenId
            });
            
            return; // Skip this trade
          } else {
            console.log(`[CopyTrader] ✓ Trade passes threshold: $${tradeValueUsd.toFixed(2)} (${tradePercent.toFixed(2)}%) >= ${thresholdConfig.percent}%`);
          }
        }
      }
    } catch (thresholdError: any) {
      // Don't block trade if threshold check fails
      console.warn(`[CopyTrader] Threshold check error (proceeding with trade): ${thresholdError.message}`);
    }

    const executionStart = Date.now();

    try {
      // Get configured trade size in USDC and calculate shares based on price
      const configuredTradeSizeUsdc = await Storage.getTradeSize();
      const tradeSizeUsdcNum = parseFloat(configuredTradeSizeUsdc || '0');
      
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
      console.log(`[Trade] Auto-bump to minimum: ${trade.autoBumpToMinimum ? 'ENABLED (high-value wallet)' : 'DISABLED'}`);
      
      // ============================================================
      // POLYMARKET MINIMUM ORDER SIZE CHECK
      // ============================================================
      // Fetch the market's actual minimum order size (usually 5 shares but varies by market)
      let marketMinShares = 5; // Default fallback
      if (trade.tokenId) {
        try {
          // Use the CLOB client to get the market's actual minimum
          const clobClient = this.executor['clobClient'] as any;
          if (clobClient && typeof clobClient.getMinOrderSize === 'function') {
            marketMinShares = await clobClient.getMinOrderSize(trade.tokenId);
          }
        } catch (minSizeError: any) {
          console.warn(`[Trade] Could not fetch market min_order_size, using default of 5:`, minSizeError.message);
        }
      }
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:sharesCalc',message:'SHARES CALCULATION - CHECKING MINIMUM',data:{tradeSizeUsdc:tradeSizeUsdcNum,pricePerShare:priceNum,rawShares:sharesAmount,roundedShares:sharesAmountRounded,marketMinShares:marketMinShares,isBelowMinimum:sharesAmountRounded<marketMinShares,autoBumpEnabled:trade.autoBumpToMinimum,suggestedMinUsdc:(marketMinShares*priceNum).toFixed(2)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H5'})}).catch(()=>{});
      // #endregion
      
      // Check if calculated shares are below market minimum
      let finalCalculatedShares = sharesAmountRounded;
      if (sharesAmountRounded < marketMinShares) {
        const minUsdcRequired = marketMinShares * priceNum;
        
        if (trade.autoBumpToMinimum) {
          // HIGH-VALUE WALLET: Auto-bump to minimum for 100% success rate
          console.log(`\n🔼 [CopyTrader] AUTO-BUMPING ORDER SIZE (high-value wallet setting)`);
          console.log(`   Original shares: ${sharesAmountRounded} (below market minimum of ${marketMinShares})`);
          console.log(`   Bumped to: ${marketMinShares} shares`);
          console.log(`   Original cost: $${configuredTradeSizeUsdc} USDC`);
          console.log(`   Actual cost: $${minUsdcRequired.toFixed(2)} USDC`);
          console.log(`   💡 This wallet has "Auto-bump to minimum" enabled for guaranteed execution\n`);
          finalCalculatedShares = marketMinShares;
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:autoBump',message:'AUTO-BUMPED to market minimum',data:{originalShares:sharesAmountRounded,bumpedShares:marketMinShares,originalUsdc:tradeSizeUsdcNum,actualUsdc:minUsdcRequired,marketId:trade.marketId,walletAddress:trade.walletAddress.substring(0,8)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
          // #endregion
        } else {
          // NORMAL WALLET: Reject trade - order size below minimum
          console.log(`\n❌ [CopyTrader] ORDER SIZE BELOW MARKET MINIMUM`);
          console.log(`   Calculated shares: ${sharesAmountRounded} (market minimum: ${marketMinShares})`);
          console.log(`   Your configured trade size: $${configuredTradeSizeUsdc} USDC`);
          console.log(`   Minimum USDC needed at this price: $${minUsdcRequired.toFixed(2)}`);
          console.log(`   💡 Options:`);
          console.log(`      1. Increase trade size to at least $${Math.ceil(minUsdcRequired)} USDC in settings`);
          console.log(`      2. Enable "Auto-bump to minimum" for this wallet (high-value mode)\n`);
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:minSizeReject',message:'ORDER REJECTED - BELOW MINIMUM (auto-bump disabled)',data:{calculatedShares:sharesAmountRounded,marketMinShares:marketMinShares,configuredUsdc:tradeSizeUsdcNum,minUsdcNeeded:minUsdcRequired,pricePerShare:priceNum,marketId:trade.marketId,autoBumpEnabled:false},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
          // #endregion
          await this.performanceTracker.recordTrade({
            timestamp: new Date(),
            walletAddress: trade.walletAddress,
            marketId: trade.marketId,
            outcome: trade.outcome,
            amount: trade.amount,
            price: trade.price,
            success: false,
            status: 'rejected',
            executionTimeMs: Date.now() - executionStart,
            error: `Order size too small: ${sharesAmountRounded} shares (market min: ${marketMinShares}). Need $${minUsdcRequired.toFixed(2)} USDC at this price, or enable "Auto-bump to minimum" for this wallet.`,
            detectedTxHash: trade.transactionHash,
            tokenId: trade.tokenId
          });
          return;
        }
      }
      
      // ============================================================
      // SELL ORDER - CHECK IF WE OWN SHARES
      // ============================================================
      let finalSharesAmount = finalCalculatedShares;
      
      if (trade.side === 'SELL') {
        console.log(`\n🔍 [CopyTrader] SELL ORDER - Checking if we own shares...`);
        
        // Get user's positions to check if we own this token
        const sellUserWallet = this.getWalletAddress();
        if (!sellUserWallet) {
          console.log(`⏭️  [CopyTrader] SKIPPING SELL - Cannot determine user wallet`);
          return;
        }
        
        // Get proxy wallet for positions lookup
        const proxyWallet = await this.getProxyWalletAddress();
        const walletToCheck = proxyWallet || sellUserWallet;
        
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
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-execute',message:'EXECUTING TRADE NOW',data:{side:order.side,amount:order.amount,price:order.price,marketId:order.marketId?.substring(0,30),tokenId:order.tokenId?.substring(0,30),outcome:order.outcome},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
      // #endregion
      
      // Execute the trade
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade',message:'About to execute trade',data:{marketId:order.marketId,price:order.price,amount:order.amount,side:order.side,tokenId:order.tokenId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      const result: TradeResult = await this.executor.executeTrade(order);
      const executionTime = Date.now() - executionStart;
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade',message:'Trade execution result',data:{success:result.success,error:result.error,orderId:result.orderId,executionTime},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
      // #endregion

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade',message:'Recording trade result',data:{success:result.success,orderId:result.orderId,txHash:result.transactionHash?.substring(0,20),error:result.error?.substring(0,100),marketId:order.marketId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      
      // Record metrics
      // NOTE: result.success is now only true if order was actually executed (not just placed)
      await this.performanceTracker.recordTrade({
        timestamp: new Date(),
        walletAddress: trade.walletAddress,
        marketId: trade.marketId,
        outcome: trade.outcome,
        amount: trade.amount, // Original detected amount
        price: trade.price,
        success: result.success, // True only if order was actually executed
        status: result.status || (result.success ? 'executed' : 'failed'), // Use status field
        executionTimeMs: executionTime,
        error: result.error, // Will contain message if order was placed but not executed
        orderId: result.orderId,
        transactionHash: result.transactionHash,
        detectedTxHash: trade.transactionHash,
        tokenId: order.tokenId, // Store token ID used
        executedAmount: order.amount, // Store actual executed amount (configured trade size)
        executedPrice: order.price // Store price used
      });

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:handleDetectedTrade-result',message:'Trade execution result',data:{success:result.success,orderId:result.orderId,error:result.error,executionTimeMs:executionTime},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
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
        // Check if this is a "market closed" error (expected behavior, not a failure)
        const isMarketClosed = result.error?.includes('MARKET_CLOSED') || 
                               result.error?.includes('orderbook') && result.error?.includes('does not exist');
        
        if (isMarketClosed) {
          // Market is resolved/closed - this is expected, log as info not error
          console.log(`\n${'='.repeat(60)}`);
          console.log(`⏭️  [CopyTrader] SKIPPING TRADE - Market Closed/Resolved`);
          console.log(`${'='.repeat(60)}`);
          console.log(`   Market: ${order.marketId}`);
          console.log(`   Outcome: ${order.outcome}`);
          console.log(`   Side: ${order.side} $${configuredTradeSizeUsdc} USDC (${order.amount} shares) @ ${order.price}`);
          console.log(`   💡 The tracked wallet traded on a market that has since been resolved.`);
          console.log(`   💡 This is normal - markets close when events conclude.`);
          console.log(`${'='.repeat(60)}\n`);
          // Don't log as error - this is expected behavior
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
      
      // Balance tracking only for user wallet (not tracked wallets)
      // This reduces RPC calls significantly
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

  /**
   * Update the monitoring interval (takes effect immediately if bot is running)
   */
  async updateMonitoringInterval(intervalMs: number): Promise<void> {
    await this.monitor.updateMonitoringInterval(intervalMs);
    // Also update config for persistence
    config.monitoringIntervalMs = intervalMs;
  }
}
