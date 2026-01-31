import { WalletMonitor } from './walletMonitor.js';
import { WebSocketMonitor } from './websocketMonitor.js';
import { TradeExecutor } from './tradeExecutor.js';
import { PerformanceTracker } from './performanceTracker.js';
import { BalanceTracker } from './balanceTracker.js';
import { DetectedTrade, TradeOrder, TradeResult, RateLimitState, TradeSideFilter } from './types.js';
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
  
  // Rate limiting state (in-memory)
  private rateLimitState: RateLimitState = {
    tradesThisHour: 0,
    tradesThisDay: 0,
    hourStartTime: Date.now(),
    dayStartTime: Date.now()
  };

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
      
      // Cleanup expired executed positions (for no-repeat-trades feature)
      try {
        const noRepeatConfig = await Storage.getNoRepeatTrades();
        if (noRepeatConfig.enabled) {
          const removed = await Storage.cleanupExpiredPositions(noRepeatConfig.blockPeriodHours);
          if (removed > 0) {
            console.log(`[CopyTrader] Cleaned up ${removed} expired no-repeat-trades entries`);
          }
        }
      } catch (cleanupError: any) {
        console.warn(`[CopyTrader] Failed to cleanup expired positions: ${cleanupError.message}`);
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
    // Solution: Create a compound key based on market + outcome + side + rough timestamp
    // This catches duplicates even when transaction hashes differ
    // 
    // NOTE: Using 1-hour time windows to prevent re-detection of the same trade
    // when the trade appears in multiple polling cycles from the trade history API.
    // The primary deduplication is by transaction hash - this is a backup.
    const tradeTimestamp = trade.timestamp instanceof Date ? trade.timestamp.getTime() : Date.now();
    // Round timestamp to 1-hour windows (was 5-minute, but that caused issues when window rolled over)
    const timeWindow = Math.floor(tradeTimestamp / (60 * 60 * 1000));
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
    // TRADE SIDE FILTER (Global + Per-Wallet)
    // ============================================================
    // Check if we should copy this trade based on side filter
    try {
      const globalSideFilter = await Storage.getTradeSideFilter();
      // Per-wallet setting overrides global (if set)
      const effectiveSideFilter: TradeSideFilter = trade.tradeSideFilter || globalSideFilter;
      
      if (effectiveSideFilter === 'buy_only' && trade.side === 'SELL') {
        console.log(`\n⏭️  [CopyTrader] FILTERED - Trade side filter (BUY only mode)`);
        console.log(`   Trade: ${trade.side} ${trade.outcome}`);
        console.log(`   Filter: ${trade.tradeSideFilter ? 'Per-wallet' : 'Global'} = ${effectiveSideFilter}`);
        console.log(`   💡 This SELL trade is blocked by your side filter settings.\n`);
        return;
      }
      
      if (effectiveSideFilter === 'sell_only' && trade.side === 'BUY') {
        console.log(`\n⏭️  [CopyTrader] FILTERED - Trade side filter (SELL only mode)`);
        console.log(`   Trade: ${trade.side} ${trade.outcome}`);
        console.log(`   Filter: ${trade.tradeSideFilter ? 'Per-wallet' : 'Global'} = ${effectiveSideFilter}`);
        console.log(`   💡 This BUY trade is blocked by your side filter settings.\n`);
        return;
      }
    } catch (sideFilterError: any) {
      console.warn(`[CopyTrader] Side filter check error (proceeding with trade): ${sideFilterError.message}`);
    }

    // ============================================================
    // CONFIGURABLE PRICE LIMITS (replaces hard-coded 0.01-0.99)
    // ============================================================
    // Skip trades where price is outside configured limits
    let priceLimits = { minPrice: 0.01, maxPrice: 0.99 }; // Defaults
    try {
      priceLimits = await Storage.getPriceLimits();
    } catch (priceLimitsError: any) {
      console.warn(`[CopyTrader] Could not load price limits (using defaults): ${priceLimitsError.message}`);
    }
    
    if (priceNum < priceLimits.minPrice) {
      console.log(`\n⏭️  [CopyTrader] FILTERED - Price below minimum`);
      console.log(`   Price: $${trade.price} (configured minimum: $${priceLimits.minPrice})`);
      console.log(`   Market: ${trade.marketId}`);
      console.log(`   Outcome: ${trade.outcome}`);
      console.log(`   💡 Adjust price limits in settings if you want to copy low-price trades.\n`);
      return;
    }
    
    if (priceNum > priceLimits.maxPrice) {
      console.log(`\n⏭️  [CopyTrader] FILTERED - Price above maximum`);
      console.log(`   Price: $${trade.price} (configured maximum: $${priceLimits.maxPrice})`);
      console.log(`   Market: ${trade.marketId}`);
      console.log(`   Outcome: ${trade.outcome}`);
      console.log(`   💡 Adjust price limits in settings if you want to copy high-price trades.\n`);
      return;
    }

    // ============================================================
    // NO-REPEAT-TRADES FILTER
    // ============================================================
    // Check if we've already traded this market+side within the block period
    try {
      const noRepeatConfig = await Storage.getNoRepeatTrades();
      if (noRepeatConfig.enabled) {
        const isBlocked = await Storage.isPositionBlocked(
          trade.marketId,
          trade.outcome,
          noRepeatConfig.blockPeriodHours
        );
        
        if (isBlocked) {
          console.log(`\n⏭️  [CopyTrader] FILTERED - No-repeat-trades (already have position)`);
          console.log(`   Market: ${trade.marketId}`);
          console.log(`   Side: ${trade.outcome}`);
          console.log(`   Block period: ${noRepeatConfig.blockPeriodHours} hours`);
          console.log(`   💡 You already have a ${trade.outcome} position in this market. Skipping repeat trade.\n`);
          
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
            error: `No-repeat-trades: Already have ${trade.outcome} position in this market (blocked for ${noRepeatConfig.blockPeriodHours}h)`,
            detectedTxHash: trade.transactionHash,
            tokenId: trade.tokenId
          });
          
          return;
        }
      }
    } catch (noRepeatError: any) {
      console.warn(`[CopyTrader] No-repeat check error (proceeding with trade): ${noRepeatError.message}`);
    }

    // ============================================================
    // TRADE VALUE FILTER
    // ============================================================
    // Check if the detected trade value is within configured limits
    try {
      const valueFilters = await Storage.getTradeValueFilters();
      if (valueFilters.enabled) {
        const detectedTradeValue = amountNum * priceNum;
        
        if (valueFilters.minTradeValueUSD !== null && detectedTradeValue < valueFilters.minTradeValueUSD) {
          console.log(`\n⏭️  [CopyTrader] FILTERED - Trade value below minimum`);
          console.log(`   Detected trade value: $${detectedTradeValue.toFixed(2)}`);
          console.log(`   Configured minimum: $${valueFilters.minTradeValueUSD}`);
          console.log(`   💡 This trade is too small based on your value filter settings.\n`);
          return;
        }
        
        if (valueFilters.maxTradeValueUSD !== null && detectedTradeValue > valueFilters.maxTradeValueUSD) {
          console.log(`\n⏭️  [CopyTrader] FILTERED - Trade value above maximum`);
          console.log(`   Detected trade value: $${detectedTradeValue.toFixed(2)}`);
          console.log(`   Configured maximum: $${valueFilters.maxTradeValueUSD}`);
          console.log(`   💡 This trade is too large based on your value filter settings.\n`);
          return;
        }
      }
    } catch (valueFilterError: any) {
      console.warn(`[CopyTrader] Value filter check error (proceeding with trade): ${valueFilterError.message}`);
    }

    // ============================================================
    // RATE LIMITING CHECK
    // ============================================================
    // Check if we've exceeded the configured rate limits
    try {
      const rateLimitConfig = await Storage.getRateLimiting();
      if (rateLimitConfig.enabled) {
        // Update rate limit state (reset counters if window has passed)
        const now = Date.now();
        const hourMs = 60 * 60 * 1000;
        const dayMs = 24 * 60 * 60 * 1000;
        
        if (now - this.rateLimitState.hourStartTime > hourMs) {
          this.rateLimitState.tradesThisHour = 0;
          this.rateLimitState.hourStartTime = now;
        }
        
        if (now - this.rateLimitState.dayStartTime > dayMs) {
          this.rateLimitState.tradesThisDay = 0;
          this.rateLimitState.dayStartTime = now;
        }
        
        // Check limits
        if (this.rateLimitState.tradesThisHour >= rateLimitConfig.maxTradesPerHour) {
          console.log(`\n⏭️  [CopyTrader] RATE LIMITED - Max trades per hour reached`);
          console.log(`   Trades this hour: ${this.rateLimitState.tradesThisHour}/${rateLimitConfig.maxTradesPerHour}`);
          console.log(`   💡 Increase rate limit in settings or wait for the next hour.\n`);
          
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
            error: `Rate limited: ${this.rateLimitState.tradesThisHour}/${rateLimitConfig.maxTradesPerHour} trades this hour`,
            detectedTxHash: trade.transactionHash,
            tokenId: trade.tokenId
          });
          
          return;
        }
        
        if (this.rateLimitState.tradesThisDay >= rateLimitConfig.maxTradesPerDay) {
          console.log(`\n⏭️  [CopyTrader] RATE LIMITED - Max trades per day reached`);
          console.log(`   Trades today: ${this.rateLimitState.tradesThisDay}/${rateLimitConfig.maxTradesPerDay}`);
          console.log(`   💡 Increase rate limit in settings or wait until tomorrow.\n`);
          
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
            error: `Rate limited: ${this.rateLimitState.tradesThisDay}/${rateLimitConfig.maxTradesPerDay} trades today`,
            detectedTxHash: trade.transactionHash,
            tokenId: trade.tokenId
          });
          
          return;
        }
      }
    } catch (rateLimitError: any) {
      console.warn(`[CopyTrader] Rate limit check error (proceeding with trade): ${rateLimitError.message}`);
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
    // USDC COMMITMENT STOP-LOSS CHECK
    // ============================================================
    // Check if we've committed too much USDC to open positions
    try {
      const stopLossActive = await this.checkUsageStopLoss();
      if (stopLossActive) {
        console.log(`\n⏭️  [CopyTrader] STOP-LOSS ACTIVE - Too much USDC committed to positions`);
        console.log(`   💡 Close some positions to resume copy trading.\n`);
        
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
          error: `Stop-loss active: Too much USDC committed to open positions`,
          detectedTxHash: trade.transactionHash,
          tokenId: trade.tokenId
        });
        
        return; // Skip this trade
      }
    } catch (stopLossError: any) {
      // Don't block trade if stop-loss check fails
      console.warn(`[CopyTrader] Stop-loss check error (proceeding with trade): ${stopLossError.message}`);
    }

    const executionStart = Date.now();

    try {
      // ============================================================
      // PER-WALLET TRADE SIZING
      // ============================================================
      // Determine trade size based on wallet's configured sizing mode:
      // - undefined (default): Use global trade size, NO filtering - copy ALL trades
      // - 'fixed': Use wallet-specific USDC amount + optional threshold filter
      // - 'proportional': Match their portfolio % with your portfolio %
      
      let tradeSizeUsdcNum: number;
      let tradeSizeSource: string;
      
      if (trade.tradeSizingMode === 'proportional') {
        // PROPORTIONAL MODE: Match their portfolio % with our portfolio %
        console.log(`[Trade] Mode: PROPORTIONAL (matching their % of portfolio)`);
        
        // Get tracked wallet's USDC balance
        let theirBalance = 0;
        try {
          theirBalance = await this.balanceTracker.getBalance(trade.walletAddress);
        } catch (balanceError: any) {
          console.warn(`[CopyTrader] Could not fetch tracked wallet balance: ${balanceError.message}`);
        }
        
        // Get OUR USDC balance
        let ourBalance = 0;
        try {
          const userWallet = this.getWalletAddress();
          const proxyWallet = await this.getProxyWalletAddress();
          const walletToCheck = proxyWallet || userWallet;
          if (walletToCheck) {
            ourBalance = await this.balanceTracker.getBalance(walletToCheck);
          }
        } catch (balanceError: any) {
          console.warn(`[CopyTrader] Could not fetch our wallet balance: ${balanceError.message}`);
        }
        
        if (theirBalance > 0 && ourBalance > 0) {
          // Calculate what % of their portfolio this trade represents
          const tradeValueUsd = amountNum * priceNum;
          const theirTradePercent = (tradeValueUsd / theirBalance) * 100;
          
          // Apply the same % to our portfolio
          tradeSizeUsdcNum = (theirTradePercent / 100) * ourBalance;
          tradeSizeSource = `proportional (${theirTradePercent.toFixed(2)}% of their $${theirBalance.toFixed(2)} = ${theirTradePercent.toFixed(2)}% of our $${ourBalance.toFixed(2)})`;
          
          console.log(`[Trade] Their trade: $${tradeValueUsd.toFixed(2)} (${theirTradePercent.toFixed(2)}% of $${theirBalance.toFixed(2)})`);
          console.log(`[Trade] Our trade: $${tradeSizeUsdcNum.toFixed(2)} (${theirTradePercent.toFixed(2)}% of $${ourBalance.toFixed(2)})`);
        } else {
          // Fallback to global trade size if balance fetch fails
          const globalTradeSize = await Storage.getTradeSize();
          tradeSizeUsdcNum = parseFloat(globalTradeSize || '2');
          tradeSizeSource = `global fallback (balance fetch failed)`;
          console.warn(`[Trade] Proportional mode failed (balance fetch), using global trade size: $${tradeSizeUsdcNum}`);
        }
        
      } else if (trade.tradeSizingMode === 'fixed') {
        // FIXED MODE: Use wallet-specific USDC amount + optional threshold filter
        console.log(`[Trade] Mode: FIXED (wallet-specific settings)`);
        
        // Use wallet's fixed trade size, or fall back to global
        if (trade.fixedTradeSize && trade.fixedTradeSize > 0) {
          tradeSizeUsdcNum = trade.fixedTradeSize;
          tradeSizeSource = `wallet fixed ($${trade.fixedTradeSize})`;
        } else {
          const globalTradeSize = await Storage.getTradeSize();
          tradeSizeUsdcNum = parseFloat(globalTradeSize || '2');
          tradeSizeSource = `global (wallet fixed not set)`;
        }
        
        // Check threshold filter if enabled for this wallet
        if (trade.thresholdEnabled && trade.thresholdPercent && trade.thresholdPercent > 0) {
          // Get tracked wallet's USDC balance
          let walletBalance = 0;
          try {
            walletBalance = await this.balanceTracker.getBalance(trade.walletAddress);
          } catch (balanceError: any) {
            console.warn(`[CopyTrader] Could not fetch wallet balance for threshold check: ${balanceError.message}`);
          }
          
          if (walletBalance > 0) {
            const tradeValueUsd = amountNum * priceNum;
            const tradePercent = (tradeValueUsd / walletBalance) * 100;
            
            if (tradePercent < trade.thresholdPercent) {
              console.log(`\n⏭️  [CopyTrader] FILTERED - Trade below wallet threshold`);
              console.log(`   Trade value: $${tradeValueUsd.toFixed(2)} (${tradePercent.toFixed(2)}% of wallet)`);
              console.log(`   Wallet USDC balance: $${walletBalance.toFixed(2)}`);
              console.log(`   Wallet threshold: ${trade.thresholdPercent}%`);
              console.log(`   💡 This trade is below the configured threshold for this wallet. Skipping.\n`);
              
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
                error: `Filtered: Trade is ${tradePercent.toFixed(2)}% of wallet ($${tradeValueUsd.toFixed(2)}/$${walletBalance.toFixed(2)}), below ${trade.thresholdPercent}% threshold`,
                detectedTxHash: trade.transactionHash,
                tokenId: trade.tokenId
              });
              
              return; // Skip this trade
            } else {
              console.log(`[CopyTrader] ✓ Trade passes wallet threshold: $${tradeValueUsd.toFixed(2)} (${tradePercent.toFixed(2)}%) >= ${trade.thresholdPercent}%`);
            }
          }
        }
        
      } else {
        // DEFAULT MODE: Use global trade size, NO filtering - copy ALL trades
        console.log(`[Trade] Mode: DEFAULT (global size, no filtering)`);
        const globalTradeSize = await Storage.getTradeSize();
        tradeSizeUsdcNum = parseFloat(globalTradeSize || '2');
        tradeSizeSource = `global ($${globalTradeSize})`;
      }
      
      // Validate final trade size
      if (isNaN(tradeSizeUsdcNum) || tradeSizeUsdcNum <= 0) {
        console.error(`❌ Invalid calculated trade size ($${tradeSizeUsdcNum} USDC), cannot execute trade`);
        await this.performanceTracker.logIssue(
          'error',
          'trade_execution',
          `Invalid calculated trade size: $${tradeSizeUsdcNum} USDC`,
          { trade, tradeSizeSource }
        );
        return;
      }
      
      // Calculate number of shares based on USDC amount and price
      // shares = USDC amount / price per share
      const sharesAmount = tradeSizeUsdcNum / priceNum;
      const sharesAmountRounded = parseFloat(sharesAmount.toFixed(2)); // Round to 2 decimal places
      
      console.log(`[Trade] Trade size: $${tradeSizeUsdcNum.toFixed(2)} USDC (${tradeSizeSource})`);
      console.log(`[Trade] Price per share: $${trade.price}`);
      console.log(`[Trade] Calculated shares: ${sharesAmountRounded} shares ($${tradeSizeUsdcNum.toFixed(2)} / $${priceNum})`);
      
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
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:sharesCalc',message:'SHARES CALCULATION - CHECKING MINIMUM',data:{tradeSizeUsdc:tradeSizeUsdcNum,pricePerShare:priceNum,rawShares:sharesAmount,roundedShares:sharesAmountRounded,marketMinShares:marketMinShares,isBelowMinimum:sharesAmountRounded<marketMinShares,suggestedMinUsdc:(marketMinShares*priceNum).toFixed(2)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H5'})}).catch(()=>{});
      // #endregion
      
      // Check if calculated shares are below market minimum
      let finalCalculatedShares = sharesAmountRounded;
      if (sharesAmountRounded < marketMinShares) {
        const minUsdcRequired = marketMinShares * priceNum;
        
        // Reject trade - order size below minimum
        console.log(`\n❌ [CopyTrader] ORDER SIZE BELOW MARKET MINIMUM`);
        console.log(`   Calculated shares: ${sharesAmountRounded} (market minimum: ${marketMinShares})`);
        console.log(`   Your configured trade size: $${tradeSizeUsdcNum.toFixed(2)} USDC`);
        console.log(`   Minimum USDC needed at this price: $${minUsdcRequired.toFixed(2)}`);
        console.log(`   💡 Increase trade size to at least $${Math.ceil(minUsdcRequired)} USDC in settings\n`);
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'copyTrader.ts:minSizeReject',message:'ORDER REJECTED - BELOW MINIMUM',data:{calculatedShares:sharesAmountRounded,marketMinShares:marketMinShares,configuredUsdc:tradeSizeUsdcNum,minUsdcNeeded:minUsdcRequired,pricePerShare:priceNum,marketId:trade.marketId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
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
          error: `Order size too small: ${sharesAmountRounded} shares (market min: ${marketMinShares}). Need $${minUsdcRequired.toFixed(2)} USDC at this price.`,
          detectedTxHash: trade.transactionHash,
          tokenId: trade.tokenId
        });
        return;
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
      console.log(`   Amount: $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares)`);
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
        console.log(`   Side: ${order.side} $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares) @ ${order.price}`);
        console.log(`${'='.repeat(60)}\n`);
        this.executedTrades.add(trade.transactionHash);
        
        // Increment rate limit counters
        this.rateLimitState.tradesThisHour++;
        this.rateLimitState.tradesThisDay++;
        
        // Record executed position for no-repeat-trades feature
        try {
          const noRepeatConfig = await Storage.getNoRepeatTrades();
          if (noRepeatConfig.enabled) {
            await Storage.addExecutedPosition(trade.marketId, trade.outcome, trade.walletAddress);
            console.log(`[CopyTrader] Recorded position for no-repeat-trades: ${trade.marketId} ${trade.outcome}`);
          }
        } catch (recordError: any) {
          console.warn(`[CopyTrader] Failed to record executed position: ${recordError.message}`);
        }
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
          console.log(`   Side: ${order.side} $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares) @ ${order.price}`);
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
          console.error(`   Side: ${order.side} $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares) @ ${order.price}`);
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

  /**
   * Check if usage stop-loss is active (too much USDC committed to positions)
   * Returns true if stop-loss should prevent new trades
   */
  async checkUsageStopLoss(): Promise<boolean> {
    try {
      const stopLossConfig = await Storage.getUsageStopLoss();
      if (!stopLossConfig.enabled) {
        return false; // Stop-loss not enabled
      }

      // Get our wallet address
      const userWallet = this.getWalletAddress();
      const proxyWallet = await this.getProxyWalletAddress();
      const walletToCheck = proxyWallet || userWallet;
      
      if (!walletToCheck) {
        console.warn(`[CopyTrader] Cannot check stop-loss: wallet address not available`);
        return false; // Can't check, allow trade
      }

      // Get our current USDC balance (free USDC)
      let freeUsdc = 0;
      try {
        freeUsdc = await this.balanceTracker.getBalance(walletToCheck);
      } catch (error: any) {
        console.warn(`[CopyTrader] Cannot fetch USDC balance for stop-loss check: ${error.message}`);
        return false; // Can't check, allow trade
      }

      // Get our open positions and calculate their total value
      let positionsValue = 0;
      try {
        const positions = await this.monitor.getApi().getUserPositions(walletToCheck);
        for (const position of positions) {
          const size = parseFloat(position.size || '0');
          const price = parseFloat(position.avgPrice || position.curPrice || '0.5');
          positionsValue += size * price;
        }
      } catch (error: any) {
        console.warn(`[CopyTrader] Cannot fetch positions for stop-loss check: ${error.message}`);
        return false; // Can't check, allow trade
      }

      // Calculate commitment percentage
      const totalValue = freeUsdc + positionsValue;
      if (totalValue <= 0) {
        return false; // No value, allow trade
      }

      const commitmentPercent = (positionsValue / totalValue) * 100;
      
      console.log(`[CopyTrader] Stop-loss check: ${commitmentPercent.toFixed(2)}% committed ($${positionsValue.toFixed(2)} in positions / $${totalValue.toFixed(2)} total), limit: ${stopLossConfig.maxCommitmentPercent}%`);

      if (commitmentPercent >= stopLossConfig.maxCommitmentPercent) {
        console.log(`[CopyTrader] ⚠️ STOP-LOSS ACTIVE: ${commitmentPercent.toFixed(2)}% >= ${stopLossConfig.maxCommitmentPercent}%`);
        return true; // Stop-loss active, block trade
      }

      return false; // Under limit, allow trade
    } catch (error: any) {
      console.warn(`[CopyTrader] Stop-loss check error: ${error.message}`);
      return false; // Error, allow trade to proceed
    }
  }

  /**
   * Get current rate limit status (for API)
   */
  getRateLimitStatus(): RateLimitState {
    // Update state first (reset counters if window has passed)
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    const dayMs = 24 * 60 * 60 * 1000;
    
    if (now - this.rateLimitState.hourStartTime > hourMs) {
      this.rateLimitState.tradesThisHour = 0;
      this.rateLimitState.hourStartTime = now;
    }
    
    if (now - this.rateLimitState.dayStartTime > dayMs) {
      this.rateLimitState.tradesThisDay = 0;
      this.rateLimitState.dayStartTime = now;
    }
    
    return { ...this.rateLimitState };
  }
}
