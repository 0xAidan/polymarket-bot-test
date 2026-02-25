import { WalletMonitor } from './walletMonitor.js';
import { DomeWebSocketMonitor } from './domeWebSocket.js';
import { isDomeConfigured } from './domeClient.js';
import { TradeExecutor } from './tradeExecutor.js';
import { PerformanceTracker } from './performanceTracker.js';
import { BalanceTracker } from './balanceTracker.js';
import { PositionMirror } from './positionMirror.js';
import { DetectedTrade, TradeOrder, TradeResult, RateLimitState, TradeSideFilter, PerWalletRateLimitStates } from './types.js';
import { Storage } from './storage.js';
import { config } from './config.js';
import { initWalletManager } from './walletManager.js';

/**
 * Main copy trading engine that coordinates monitoring and execution
 * Handles trade detection, execution, and performance tracking
 */
export class CopyTrader {
  private monitor: WalletMonitor;
  private domeWsMonitor: DomeWebSocketMonitor | null = null;
  private executor: TradeExecutor;
  private performanceTracker: PerformanceTracker;
  private balanceTracker: BalanceTracker;
  private isRunning = false;
  private monitoringMode: 'polling' | 'websocket' = 'polling';
  private processedTrades = new Map<string, number>(); // Track processed trades by tx hash to prevent duplicates
  private executedTradesCount = 0; // Number of trades successfully executed this session
  private processedCompoundKeys = new Map<string, number>(); // Track by compound key (wallet-market-outcome-side-timeWindow) to catch same trade with different hashes
  private inFlightTrades = new Set<string>(); // Prevent concurrent processing of the same trade
  
  // Per-wallet rate limiting state (in-memory, keyed by wallet address)
  private perWalletRateLimits: PerWalletRateLimitStates = new Map();

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
      
      // Initialize multi-wallet manager
      await initWalletManager();
      
      // Initialize Dome WebSocket if API key is configured
      if (isDomeConfigured()) {
        this.domeWsMonitor = new DomeWebSocketMonitor();
        console.log('[CopyTrader] Dome API key detected — WebSocket monitoring available');
      }
      
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
      // Find the shortest non-zero block period from all wallets to determine cleanup threshold
      try {
        const wallets = await Storage.loadTrackedWallets();
        const blockPeriods = wallets
          .filter(w => w.noRepeatEnabled && w.noRepeatPeriodHours !== 0) // Skip 'forever' (0)
          .map(w => w.noRepeatPeriodHours ?? 24);
        
        if (blockPeriods.length > 0) {
          // Use the longest block period to avoid removing positions that are still valid
          const maxBlockPeriod = Math.max(...blockPeriods);
          const removed = await Storage.cleanupExpiredPositions(maxBlockPeriod);
          if (removed > 0) {
            console.log(`[CopyTrader] Cleaned up ${removed} expired no-repeat-trades entries (older than ${maxBlockPeriod}h)`);
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

    // Start Dome WebSocket monitoring if available (primary for tracked wallets)
    if (this.domeWsMonitor) {
      console.log('📡 Starting Dome WebSocket monitoring (PRIMARY)...');
      try {
        // Wire up Dome WS events
        // NOTE: Polling is NO LONGER paused when Dome WS connects.
        // Both run in parallel because:
        // 1. Dome WS identifies users by EOA, but some tracked wallets use proxy addresses
        // 2. This caused wallets like 432 to silently stop being monitored
        // 3. The dedup logic in handleDetectedTrade prevents double execution
        // 4. Polling is reliable for ALL wallets; Dome WS adds speed for matching ones
        this.domeWsMonitor.on('connected', () => {
          this.monitoringMode = 'websocket';
          console.log('[DomeWS] Connected — running alongside polling for maximum coverage');
        });

        this.domeWsMonitor.on('disconnected', () => {
          this.monitoringMode = 'polling';
          console.log('[DomeWS] Disconnected — polling continues as usual');
        });

        this.domeWsMonitor.on('reconnected', () => {
          this.monitoringMode = 'websocket';
          console.log('[DomeWS] Reconnected — running alongside polling');
        });

        this.domeWsMonitor.on('trade', async (trade: DetectedTrade) => {
          console.log(`[CopyTrader] 📥 Dome WS trade detected:`, JSON.stringify({
            wallet: trade.walletAddress,
            market: trade.marketId,
            side: trade.side,
            price: trade.price,
          }));
          await this.handleDetectedTrade(trade);
        });

        this.domeWsMonitor.on('error', (err: any) => {
          console.error('[DomeWS] Error:', err?.message || err);
        });

        await this.domeWsMonitor.start();
      } catch (error: any) {
        console.error('[DomeWS] Failed to start Dome WebSocket:', error.message);
        console.log('⚠️ Continuing with polling-based monitoring');
      }
    }

    // Start balance tracking for user wallet only (reduces RPC calls significantly)
    const userWallet = this.getWalletAddress();
    if (userWallet) {
      await this.balanceTracker.startTracking([userWallet]);
    }

    const domeWsStatus = this.domeWsMonitor?.getStatus();
    console.log('\n' + '='.repeat(60));
    console.log('✅ COPY TRADING BOT IS RUNNING');
    console.log('='.repeat(60));
    console.log(`📊 Monitoring Methods:`);
    if (domeWsStatus) {
      console.log(`   🌐 Dome WebSocket: ${domeWsStatus.connected ? '✅ CONNECTED (PRIMARY)' : '⏳ CONNECTING...'} — ${domeWsStatus.trackedWallets} wallets`);
    }
    console.log(`   🔄 Polling: ✅ ACTIVE — every ${config.monitoringIntervalMs / 1000}s`);
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
    
    // Stop Dome WebSocket if running
    if (this.domeWsMonitor) {
      this.domeWsMonitor.stop().catch(err => 
        console.error('[DomeWS] Error during stop:', err)
      );
    }
    
    this.monitor.stopMonitoring();
    this.balanceTracker.stopTracking();
    console.log('Copy trading bot stopped');
  }

  /**
   * Reinitialize all components after credentials change
   * This reloads the private key and reinitializes all clients
   */
  async reinitializeCredentials(): Promise<{ success: boolean; walletAddress: string | null; error?: string }> {
    console.log('[CopyTrader] Reinitializing with new credentials...');
    
    const wasRunning = this.isRunning;
    
    // Stop the bot if running
    if (wasRunning) {
      this.stop();
    }
    
    try {
      // Reload environment variables to get the new private key
      const dotenv = await import('dotenv');
      dotenv.config({ override: true });
      
      // Update config with new private key
      config.privateKey = process.env.PRIVATE_KEY || '';
      
      if (!config.privateKey) {
        return { success: false, walletAddress: null, error: 'Private key not found in environment' };
      }
      
      // Recreate executor with new credentials (this reinitializes the CLOB client)
      this.executor = new TradeExecutor();
      await this.executor.authenticate();
      
      // Reinitialize monitor (this reinitializes the PolymarketApi)
      this.monitor = new WalletMonitor();
      await this.monitor.initialize();
      
      // Reinitialize balance tracker
      this.balanceTracker = new BalanceTracker();
      await this.balanceTracker.initialize();
      
      const walletAddress = this.getWalletAddress();
      console.log(`[CopyTrader] ✓ Reinitialized with wallet: ${walletAddress}`);
      
      // Restart the bot if it was running
      if (wasRunning) {
        await this.start();
      }
      
      return { success: true, walletAddress };
    } catch (error: any) {
      console.error('[CopyTrader] Reinitialization failed:', error.message);
      return { success: false, walletAddress: null, error: error.message };
    }
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
    // 5-minute compound-key window for same-market dedup (trade history vs Dome can have different hashes)
    const timeWindow = Math.floor(tradeTimestamp / (5 * 60 * 1000));
    const compoundKey = `${trade.walletAddress.toLowerCase()}-${trade.marketId}-${trade.outcome}-${trade.side}-${timeWindow}`;
    
    // Also track by transaction hash for exact duplicates
    const tradeKey = trade.transactionHash;
    
    // Clean up old entries (older than 5 minutes for compound keys; 1 hour for tx hashes)
    const now = Date.now();
    for (const [key, timestamp] of this.processedTrades.entries()) {
      if (now - timestamp > 60 * 60 * 1000) {
        this.processedTrades.delete(key);
      }
    }
    for (const [key, timestamp] of this.processedCompoundKeys.entries()) {
      if (now - timestamp > 5 * 60 * 1000) {
        this.processedCompoundKeys.delete(key);
      }
    }
    
    // CHECK 1: By transaction hash (exact duplicate)
    if (this.processedTrades.has(tradeKey)) {
      console.log(`[CopyTrader] ⏭️  Trade already processed (txHash: ${tradeKey?.substring(0,20)}...), skipping duplicate`);
      return;
    }
    
    // CHECK 2: By compound key (same trade detected with different hash - e.g., position vs trade history)
    if (this.processedCompoundKeys.has(compoundKey)) {
      console.log(`[CopyTrader] ⏭️  Trade already processed (compound key: ${compoundKey.substring(0, 30)}...), skipping duplicate detection`);
      return;
    }
    
    // CHECK 3: Currently in-flight (being executed right now, not yet finished)
    if (this.inFlightTrades.has(tradeKey) || this.inFlightTrades.has(compoundKey)) {
      console.log(`[CopyTrader] ⏭️  Trade currently in-flight, skipping concurrent processing`);
      return;
    }

    // CRITICAL: Mark as in-flight IMMEDIATELY after the check, BEFORE any async code.
    // This closes the race window where concurrent Dome WS events could all pass the
    // check above before any of them reached the old add() location 300 lines below.
    this.inFlightTrades.add(tradeKey);
    this.inFlightTrades.add(compoundKey);

    // Mark tx hash as processed IMMEDIATELY so the next polling cycle won't re-detect
    // this exact trade. Previously, filtered/rejected trades were never added here,
    // causing the same trades to be re-detected and re-recorded as "rejected" every cycle.
    // NOTE: Only set processedTrades (tx hash) here, NOT processedCompoundKeys.
    // The compound key groups ALL trades on the same market+outcome+side within 5 minutes,
    // so setting it up front would block legitimate different trades from the same whale
    // on the same market (e.g. 7x $960 buys on Timberwolves spread within minutes).
    this.processedTrades.set(tradeKey, Date.now());

    try {
    // === Everything below is wrapped in try/finally to guarantee inFlightTrades cleanup ===
    
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
    let amountNum = parseFloat(trade.amount || '0');
    
    // SANITY CHECK: Detect values that appear to be in USDC base units (6 decimals)
    // If amount * price > $10M, the amount is almost certainly in base units and needs conversion
    // This guards against Dome WebSocket or API returning raw values instead of normalized ones
    if (amountNum > 0 && priceNum > 0) {
      const rawUsdValue = amountNum * priceNum;
      if (rawUsdValue > 10_000_000) {
        const correctedAmount = amountNum / 1_000_000;
        console.warn(`[CopyTrader] ⚠️ AMOUNT SANITY CHECK: Detected amount ${amountNum} appears to be in base units (USD value would be $${rawUsdValue.toLocaleString()})`);
        console.warn(`[CopyTrader]    Correcting: ${amountNum} → ${correctedAmount} (divided by 1e6 for USDC decimals)`);
        amountNum = correctedAmount;
        trade.amount = correctedAmount.toString();
      }
    }
    
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
    // TRADE SIDE FILTER (Per-Wallet)
    // ============================================================
    // Check if we should copy this trade based on wallet's side filter
    const walletSideFilter: TradeSideFilter = trade.tradeSideFilter || 'all';
    
    if (walletSideFilter === 'buy_only' && trade.side === 'SELL') {
      console.log(`\n⏭️  [CopyTrader] FILTERED - Trade side filter (BUY only mode)`);
      console.log(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
      console.log(`   Trade: ${trade.side} ${trade.outcome}`);
      console.log(`   💡 This SELL trade is blocked by this wallet's side filter settings.\n`);
      await this.performanceTracker.recordTrade({
        timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId,
        outcome: trade.outcome, amount: trade.amount, price: trade.price, success: false,
        status: 'rejected', executionTimeMs: 0,
        error: `Side filter: Only BUY trades allowed for this wallet`,
        detectedTxHash: trade.transactionHash, tokenId: trade.tokenId
      });
      return;
    }
    
    if (walletSideFilter === 'sell_only' && trade.side === 'BUY') {
      console.log(`\n⏭️  [CopyTrader] FILTERED - Trade side filter (SELL only mode)`);
      console.log(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
      console.log(`   Trade: ${trade.side} ${trade.outcome}`);
      console.log(`   💡 This BUY trade is blocked by this wallet's side filter settings.\n`);
      await this.performanceTracker.recordTrade({
        timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId,
        outcome: trade.outcome, amount: trade.amount, price: trade.price, success: false,
        status: 'rejected', executionTimeMs: 0,
        error: `Side filter: Only SELL trades allowed for this wallet`,
        detectedTxHash: trade.transactionHash, tokenId: trade.tokenId
      });
      return;
    }

    // ============================================================
    // PRICE LIMITS (Per-Wallet)
    // ============================================================
    // Skip trades where price is outside wallet's configured limits
    const minPrice = trade.priceLimitsMin ?? 0.01;  // Default: 0.01
    const maxPrice = trade.priceLimitsMax ?? 0.99;  // Default: 0.99
    
    if (priceNum < minPrice) {
      console.log(`\n⏭️  [CopyTrader] FILTERED - Price below wallet minimum`);
      console.log(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
      console.log(`   Price: $${trade.price} (wallet minimum: $${minPrice})`);
      console.log(`   Market: ${trade.marketId}`);
      console.log(`   💡 Adjust this wallet's price limits to copy low-price trades.\n`);
      await this.performanceTracker.recordTrade({
        timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId,
        outcome: trade.outcome, amount: trade.amount, price: trade.price, success: false,
        status: 'rejected', executionTimeMs: 0,
        error: `Price filter: $${trade.price} below minimum $${minPrice}`,
        detectedTxHash: trade.transactionHash, tokenId: trade.tokenId
      });
      return;
    }
    
    if (priceNum > maxPrice) {
      console.log(`\n⏭️  [CopyTrader] FILTERED - Price above wallet maximum`);
      console.log(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
      console.log(`   Price: $${trade.price} (wallet maximum: $${maxPrice})`);
      console.log(`   Market: ${trade.marketId}`);
      console.log(`   💡 Adjust this wallet's price limits to copy high-price trades.\n`);
      await this.performanceTracker.recordTrade({
        timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId,
        outcome: trade.outcome, amount: trade.amount, price: trade.price, success: false,
        status: 'rejected', executionTimeMs: 0,
        error: `Price filter: $${trade.price} above maximum $${maxPrice}`,
        detectedTxHash: trade.transactionHash, tokenId: trade.tokenId
      });
      return;
    }

    // ============================================================
    // NO-REPEAT-TRADES FILTER (ALWAYS ACTIVE)
    // ============================================================
    // ALWAYS check if we've already traded this market+outcome, regardless of per-wallet
    // noRepeatEnabled setting. This provides two levels of protection:
    //  - noRepeatEnabled=true: Uses configured blockPeriod (forever, 24h, etc.)
    //  - noRepeatEnabled=false/undefined: Uses 5-minute safety minimum to catch
    //    rapid-fire duplicates from bot restarts and concurrent Dome WS events.
    // FAIL-SAFE: If the storage read fails, BLOCK the trade rather than allowing it.
    {
      const SAFETY_MINIMUM_HOURS = 5 / 60; // 5 minutes
      const blockPeriod = trade.noRepeatEnabled
        ? (trade.noRepeatPeriodHours ?? 24)
        : SAFETY_MINIMUM_HOURS;
      try {
        const isBlocked = await Storage.isPositionBlocked(
          trade.marketId,
          trade.outcome,
          blockPeriod
        );
        
        if (isBlocked) {
          const periodLabel = blockPeriod === 0 ? 'forever' : blockPeriod < 1 ? `${Math.round(blockPeriod * 60)}min` : `${blockPeriod}h`;
          console.log(`\n⏭️  [CopyTrader] FILTERED - No-repeat-trades (already have position)`);
          console.log(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
          console.log(`   Market: ${trade.marketId}`);
          console.log(`   Side: ${trade.side} | Outcome: ${trade.outcome}`);
          console.log(`   Block period: ${periodLabel}${!trade.noRepeatEnabled ? ' (global safety minimum)' : ''}`);
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
            error: `No-repeat-trades: Already have ${trade.outcome} position in this market (blocked ${periodLabel})`,
            detectedTxHash: trade.transactionHash,
            tokenId: trade.tokenId
          });
          
          return;
        }
      } catch (noRepeatError: any) {
        console.error(`[CopyTrader] No-repeat check FAILED — BLOCKING trade for safety: ${noRepeatError.message}`);
        return;
      }
    }

    // ============================================================
    // TRADE VALUE FILTER (Per-Wallet)
    // ============================================================
    // Check if the detected trade value is within wallet's configured limits
    if (trade.valueFilterEnabled) {
      const detectedTradeValue = amountNum * priceNum;
      
      if (trade.valueFilterMin !== null && trade.valueFilterMin !== undefined && detectedTradeValue < trade.valueFilterMin) {
        console.log(`\n⏭️  [CopyTrader] FILTERED - Trade value below wallet minimum`);
        console.log(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
        console.log(`   Detected trade value: $${detectedTradeValue.toFixed(2)}`);
        console.log(`   Wallet minimum: $${trade.valueFilterMin}`);
        console.log(`   💡 This trade is too small based on this wallet's value filter.\n`);
        await this.performanceTracker.recordTrade({
          timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId,
          outcome: trade.outcome, amount: trade.amount, price: trade.price, success: false,
          status: 'rejected', executionTimeMs: 0,
          error: `Value filter: $${detectedTradeValue.toFixed(2)} below minimum $${trade.valueFilterMin}`,
          detectedTxHash: trade.transactionHash, tokenId: trade.tokenId
        });
        return;
      }
      
      if (trade.valueFilterMax !== null && trade.valueFilterMax !== undefined && detectedTradeValue > trade.valueFilterMax) {
        console.log(`\n⏭️  [CopyTrader] FILTERED - Trade value above wallet maximum`);
        console.log(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
        console.log(`   Detected trade value: $${detectedTradeValue.toFixed(2)}`);
        console.log(`   Wallet maximum: $${trade.valueFilterMax}`);
        console.log(`   💡 This trade is too large based on this wallet's value filter.\n`);
        await this.performanceTracker.recordTrade({
          timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId,
          outcome: trade.outcome, amount: trade.amount, price: trade.price, success: false,
          status: 'rejected', executionTimeMs: 0,
          error: `Value filter: $${detectedTradeValue.toFixed(2)} above maximum $${trade.valueFilterMax}`,
          detectedTxHash: trade.transactionHash, tokenId: trade.tokenId
        });
        return;
      }
    }

    // ============================================================
    // RATE LIMITING CHECK (Per-Wallet)
    // ============================================================
    // Check if we've exceeded the wallet's configured rate limits
    if (trade.rateLimitEnabled) {
      const walletAddress = trade.walletAddress.toLowerCase();
      const maxPerHour = trade.rateLimitPerHour ?? 10;   // Default: 10
      const maxPerDay = trade.rateLimitPerDay ?? 50;     // Default: 50
      
      // Get or create rate limit state for this wallet
      let walletRateState = this.perWalletRateLimits.get(walletAddress);
      if (!walletRateState) {
        walletRateState = {
          tradesThisHour: 0,
          tradesThisDay: 0,
          hourStartTime: Date.now(),
          dayStartTime: Date.now()
        };
        this.perWalletRateLimits.set(walletAddress, walletRateState);
      }
      
      // Update rate limit state (reset counters if window has passed)
      const now = Date.now();
      const hourMs = 60 * 60 * 1000;
      const dayMs = 24 * 60 * 60 * 1000;
      
      if (now - walletRateState.hourStartTime > hourMs) {
        walletRateState.tradesThisHour = 0;
        walletRateState.hourStartTime = now;
      }
      
      if (now - walletRateState.dayStartTime > dayMs) {
        walletRateState.tradesThisDay = 0;
        walletRateState.dayStartTime = now;
      }
      
      // Check limits
      if (walletRateState.tradesThisHour >= maxPerHour) {
        console.log(`\n⏭️  [CopyTrader] RATE LIMITED - Max trades per hour for wallet`);
        console.log(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
        console.log(`   Trades this hour: ${walletRateState.tradesThisHour}/${maxPerHour}`);
        console.log(`   💡 Adjust this wallet's rate limit or wait for the next hour.\n`);
        
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
          error: `Rate limited: ${walletRateState.tradesThisHour}/${maxPerHour} trades this hour for this wallet`,
          detectedTxHash: trade.transactionHash,
          tokenId: trade.tokenId
        });
        
        return;
      }
      
      if (walletRateState.tradesThisDay >= maxPerDay) {
        console.log(`\n⏭️  [CopyTrader] RATE LIMITED - Max trades per day for wallet`);
        console.log(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
        console.log(`   Trades today: ${walletRateState.tradesThisDay}/${maxPerDay}`);
        console.log(`   💡 Adjust this wallet's rate limit or wait until tomorrow.\n`);
        
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
          error: `Rate limited: ${walletRateState.tradesThisDay}/${maxPerDay} trades today for this wallet`,
          detectedTxHash: trade.transactionHash,
          tokenId: trade.tokenId
        });
        
        return;
      }
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
      // FAIL-SAFE: If we can't verify stop-loss status, BLOCK the trade.
      // Better to miss one trade than to overcommit capital.
      console.error(`[CopyTrader] Stop-loss check FAILED — BLOCKING trade for safety: ${stopLossError.message}`);
      return;
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
        
        // Get tracked wallet's TOTAL portfolio value (USDC balance + positions)
        // USDC is fetched from their proxy wallet on-chain via Alchemy RPC
        let theirPortfolioValue = 0;
        try {
          const polymarketApi = this.monitor.getApi();
          const portfolioData = await polymarketApi.getPortfolioValue(trade.walletAddress, this.balanceTracker);
          theirPortfolioValue = portfolioData.totalValue;
          console.log(`[Trade] Their Polymarket portfolio: $${theirPortfolioValue.toFixed(2)} (USDC: $${portfolioData.usdcBalance.toFixed(2)} + ${portfolioData.positionCount} positions: $${portfolioData.positionsValue.toFixed(2)})`);
        } catch (balanceError: any) {
          console.warn(`[CopyTrader] Could not fetch tracked wallet portfolio: ${balanceError.message}`);
        }
        
        // Get OUR USDC balance from Polymarket CLOB API (our tradable funds)
        let ourBalance = 0;
        try {
          const clobClient = this.executor.getClobClient();
          ourBalance = await clobClient.getUsdcBalance();
          console.log(`[Trade] Our Polymarket USDC balance: $${ourBalance.toFixed(2)}`);
        } catch (balanceError: any) {
          console.warn(`[CopyTrader] Could not fetch our USDC balance: ${balanceError.message}`);
        }
        
        if (theirPortfolioValue > 0 && ourBalance > 0) {
          // Calculate what % of their portfolio this trade represents
          const tradeValueUsd = amountNum * priceNum;
          const theirTradePercent = (tradeValueUsd / theirPortfolioValue) * 100;
          
          // Apply the same % to our tradable balance
          tradeSizeUsdcNum = (theirTradePercent / 100) * ourBalance;
          tradeSizeSource = `proportional (${theirTradePercent.toFixed(2)}% of their $${theirPortfolioValue.toFixed(2)} portfolio = ${theirTradePercent.toFixed(2)}% of our $${ourBalance.toFixed(2)})`;
          
          console.log(`[Trade] Their trade: $${tradeValueUsd.toFixed(2)} (${theirTradePercent.toFixed(2)}% of their $${theirPortfolioValue.toFixed(2)} portfolio)`);
          console.log(`[Trade] Our trade: $${tradeSizeUsdcNum.toFixed(2)} (${theirTradePercent.toFixed(2)}% of our $${ourBalance.toFixed(2)} USDC)`);
        } else {
          // Fallback to wallet's fixed trade size if set, otherwise global
          if (trade.fixedTradeSize && trade.fixedTradeSize > 0) {
            tradeSizeUsdcNum = trade.fixedTradeSize;
            tradeSizeSource = `wallet fixed fallback (portfolio fetch failed)`;
          } else {
            const globalTradeSize = await Storage.getTradeSize();
            tradeSizeUsdcNum = parseFloat(globalTradeSize || '2');
            tradeSizeSource = `global fallback (portfolio fetch failed)`;
          }
          console.warn(`[Trade] Proportional mode failed (their portfolio: $${theirPortfolioValue}, our balance: $${ourBalance}), using ${tradeSizeSource}: $${tradeSizeUsdcNum}`);
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
          // Get tracked wallet's TOTAL portfolio value (USDC + positions)
          let walletPortfolioValue = 0;
          try {
            const polymarketApi = this.monitor.getApi();
            const portfolioData = await polymarketApi.getPortfolioValue(trade.walletAddress, this.balanceTracker);
            walletPortfolioValue = portfolioData.totalValue;
            console.log(`[Trade] Threshold check - Their portfolio: $${walletPortfolioValue.toFixed(2)} (USDC: $${portfolioData.usdcBalance.toFixed(2)} + ${portfolioData.positionCount} positions: $${portfolioData.positionsValue.toFixed(2)})`);
          } catch (balanceError: any) {
            console.warn(`[CopyTrader] Could not fetch wallet portfolio for threshold check: ${balanceError.message}`);
          }
          
          if (walletPortfolioValue > 0) {
            const tradeValueUsd = amountNum * priceNum;
            const tradePercent = (tradeValueUsd / walletPortfolioValue) * 100;
            
            if (tradePercent < trade.thresholdPercent) {
              console.log(`\n⏭️  [CopyTrader] FILTERED - Trade below wallet threshold`);
              console.log(`   Trade value: $${tradeValueUsd.toFixed(2)} (${tradePercent.toFixed(2)}% of portfolio)`);
              console.log(`   Wallet portfolio value: $${walletPortfolioValue.toFixed(2)}`);
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
                error: `Filtered: Trade is ${tradePercent.toFixed(2)}% of portfolio ($${tradeValueUsd.toFixed(2)}/$${walletPortfolioValue.toFixed(2)}), below ${trade.thresholdPercent}% threshold`,
                detectedTxHash: trade.transactionHash,
                tokenId: trade.tokenId
              });
              
              return; // Skip this trade
            } else {
              console.log(`[CopyTrader] ✓ Trade passes wallet threshold: $${tradeValueUsd.toFixed(2)} (${tradePercent.toFixed(2)}% of $${walletPortfolioValue.toFixed(2)}) >= ${trade.thresholdPercent}%`);
            }
          } else {
            console.warn(`[CopyTrader] ⚠️ Could not get portfolio value for threshold check - proceeding with trade`);
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

      // SAFETY CAP: Reject any order that exceeds a reasonable maximum.
      // Proportional mode: cap at 2x calculated size with a floor of $500. Fixed/global: 2x configured size.
      const configuredSize = trade.fixedTradeSize ?? parseFloat(await Storage.getTradeSize() || '50');
      const maxAllowedUsd = trade.tradeSizingMode === 'proportional'
        ? Math.max(tradeSizeUsdcNum * 2, 500)
        : configuredSize * 2;
      if (tradeSizeUsdcNum > maxAllowedUsd) {
        console.error(`\n❌ [CopyTrader] SAFETY CAP: Order $${tradeSizeUsdcNum.toFixed(2)} exceeds max $${maxAllowedUsd.toFixed(2)} (${trade.tradeSizingMode === 'proportional' ? 'proportional 2x / $500 floor' : `2x configured $${configuredSize}`})`);
        console.error(`   Mode: ${tradeSizeSource}`);
        console.error(`   This likely indicates a bug in trade sizing. Trade BLOCKED.\n`);
        await this.performanceTracker.logIssue(
          'error',
          'trade_execution',
          `Safety cap: Order $${tradeSizeUsdcNum.toFixed(2)} exceeds max $${maxAllowedUsd.toFixed(2)}`,
          { trade, tradeSizeSource, tradeSizeUsdcNum, maxAllowedUsd }
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
          const clobClient = this.executor.getClobClient();
          if (clobClient && typeof clobClient.getMinOrderSize === 'function') {
            marketMinShares = await clobClient.getMinOrderSize(trade.tokenId);
          }
        } catch (minSizeError: any) {
          console.warn(`[Trade] Could not fetch market min_order_size, using default of 5:`, minSizeError.message);
        }
      }
      
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
        slippagePercent: trade.slippagePercent,  // Per-wallet slippage (executor falls back to storage)
      };

      console.log(`\n🚀 [Execute] EXECUTING TRADE:`);
      console.log(`   Action: ${order.side}`);
      console.log(`   Amount: $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares)`);
      console.log(`   Market: ${order.marketId}`);
      console.log(`   Outcome: ${order.outcome}`);
      console.log(`   Price: ${order.price}`);
      console.log(`   Time: ${new Date().toISOString()}`);
      
      // Execute the trade
      const result: TradeResult = await this.executor.executeTrade(order);
      const executionTime = Date.now() - executionStart;
      
      // Record metrics
      // NOTE: result.success is now only true if order was actually executed (not just placed)
      await this.performanceTracker.recordTrade({
        timestamp: trade.timestamp instanceof Date ? trade.timestamp : new Date(trade.timestamp),
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
        this.executedTradesCount++;

        // Mark as processed now that execution succeeded (enables retry on failure)
        this.processedTrades.set(tradeKey, Date.now());
        this.processedCompoundKeys.set(compoundKey, Date.now());
        
        // Increment per-wallet rate limit counters (if rate limiting was enabled for this wallet)
        if (trade.rateLimitEnabled) {
          const walletRateState = this.perWalletRateLimits.get(trade.walletAddress.toLowerCase());
          if (walletRateState) {
            walletRateState.tradesThisHour++;
            walletRateState.tradesThisDay++;
          }
        }
        
        // ALWAYS record executed position for cross-restart dedup.
        // Not gated on noRepeatEnabled — every successful trade is persisted so the
        // no-repeat safety check (5-min minimum for all trades) has data to work with.
        try {
          await Storage.addExecutedPosition(trade.marketId, trade.outcome, trade.walletAddress);
          console.log(`[CopyTrader] Recorded position for no-repeat-trades: ${trade.marketId} ${trade.outcome}`);
        } catch (recordError: any) {
          console.error(`[CopyTrader] CRITICAL: Failed to record executed position: ${recordError.message}`);
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
          // Still mark as processed so we don't keep retrying a closed market
          this.processedTrades.set(tradeKey, Date.now());
          this.processedCompoundKeys.set(compoundKey, Date.now());
        } else {
          console.error(`\n${'='.repeat(60)}`);
          console.error(`❌ [Execute] TRADE EXECUTION FAILED`);
          console.error(`${'='.repeat(60)}`);
          console.error(`   Error: ${result.error}`);
          console.error(`   Market: ${order.marketId}`);
          console.error(`   Side: ${order.side} $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares) @ ${order.price}`);
          console.error(`${'='.repeat(60)}\n`);
          this.processedTrades.set(tradeKey, Date.now());
          this.processedCompoundKeys.set(compoundKey, Date.now());
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
    } finally {
      // Always clear in-flight status so the trade can be retried on failure.
      // This finally block covers the ENTIRE function after the inFlightTrades.add()
      // at the top, ensuring cleanup on ANY return path (filters, errors, success).
      this.inFlightTrades.delete(tradeKey);
      this.inFlightTrades.delete(compoundKey);
    }
  }

  /**
   * Get status of the copy trader
   */
  getStatus(): {
    running: boolean;
    executedTradesCount: number;
    monitoringMode: 'polling' | 'websocket';
    domeWs: { connected: boolean; subscriptionId: string | null; trackedWallets: number } | null;
  } {
    return {
      running: this.isRunning,
      executedTradesCount: this.executedTradesCount,
      monitoringMode: this.monitoringMode,
      domeWs: this.domeWsMonitor?.getStatus() ?? null,
    };
  }

  /**
   * Get the Dome WebSocket monitor (for API routes).
   */
  getDomeWsMonitor(): DomeWebSocketMonitor | null {
    return this.domeWsMonitor;
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
    }
  }

  /**
   * Get the balance tracker instance
   */
  getBalanceTracker(): BalanceTracker {
    return this.balanceTracker;
  }

  /**
   * Get the trade executor for direct trade execution (e.g. ladder exits)
   */
  getTradeExecutor(): TradeExecutor {
    return this.executor;
  }

  /**
   * Get the CLOB client instance for direct API access
   */
  getClobClient(): import('./clobClient.js').PolymarketClobClient {
    return this.executor.getClobClient();
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
    const status = await this.getUsageStopLossStatus();
    return status.active;
  }

  /**
   * Get detailed stop-loss runtime status for diagnostics/API visibility.
   */
  async getUsageStopLossStatus(): Promise<{
    enabled: boolean;
    maxCommitmentPercent: number;
    commitmentPercent: number | null;
    active: boolean;
    error?: string;
  }> {
    try {
      const stopLossConfig = await Storage.getUsageStopLoss();
      if (!stopLossConfig.enabled) {
        return {
          enabled: false,
          maxCommitmentPercent: stopLossConfig.maxCommitmentPercent,
          commitmentPercent: null,
          active: false
        };
      }

      // Get our wallet address
      const userWallet = this.getWalletAddress();
      const proxyWallet = await this.getProxyWalletAddress();
      const walletToCheck = proxyWallet || userWallet;
      
      if (!walletToCheck) {
        console.warn(`[CopyTrader] Cannot check stop-loss: wallet address not available`);
        return {
          enabled: true,
          maxCommitmentPercent: stopLossConfig.maxCommitmentPercent,
          commitmentPercent: null,
          active: false,
          error: 'Wallet address not available'
        };
      }

      // Get our current USDC balance from Polymarket CLOB API (free USDC for trading)
      let freeUsdc = 0;
      try {
        const clobClient = this.executor.getClobClient();
        freeUsdc = await clobClient.getUsdcBalance();
      } catch (error: any) {
        console.error(`[CopyTrader] Cannot fetch USDC balance for stop-loss check — BLOCKING trades for safety: ${error.message}`);
        return {
          enabled: true,
          maxCommitmentPercent: stopLossConfig.maxCommitmentPercent,
          commitmentPercent: null,
          active: true,
          error: `Cannot fetch USDC balance: ${error.message}`
        };
      }

      // Get our open positions and calculate their total value
      let positionsValue = 0;
      try {
        const positions = await this.monitor.getApi().getUserPositions(walletToCheck);
        for (const position of positions) {
          const size = parseFloat(position.size || '0');
          const price = parseFloat(position.curPrice || position.avgPrice || '0.5');
          positionsValue += size * price;
        }
      } catch (error: any) {
        console.error(`[CopyTrader] Cannot fetch positions for stop-loss check — BLOCKING trades for safety: ${error.message}`);
        return {
          enabled: true,
          maxCommitmentPercent: stopLossConfig.maxCommitmentPercent,
          commitmentPercent: null,
          active: true,
          error: `Cannot fetch positions: ${error.message}`
        };
      }

      // Calculate commitment percentage
      const totalValue = freeUsdc + positionsValue;
      if (totalValue <= 0) {
        return {
          enabled: true,
          maxCommitmentPercent: stopLossConfig.maxCommitmentPercent,
          commitmentPercent: 0,
          active: false
        };
      }

      const commitmentPercent = (positionsValue / totalValue) * 100;
      
      console.log(`[CopyTrader] Stop-loss check: ${commitmentPercent.toFixed(2)}% committed ($${positionsValue.toFixed(2)} in positions / $${totalValue.toFixed(2)} total), limit: ${stopLossConfig.maxCommitmentPercent}%`);

      const active = commitmentPercent >= stopLossConfig.maxCommitmentPercent;
      if (active) {
        console.log(`[CopyTrader] ⚠️ STOP-LOSS ACTIVE: ${commitmentPercent.toFixed(2)}% >= ${stopLossConfig.maxCommitmentPercent}%`);
      }

      return {
        enabled: true,
        maxCommitmentPercent: stopLossConfig.maxCommitmentPercent,
        commitmentPercent,
        active
      };
    } catch (error: any) {
      console.error(`[CopyTrader] Stop-loss check error — BLOCKING trades for safety: ${error.message}`);
      return {
        enabled: true,
        maxCommitmentPercent: 0,
        commitmentPercent: null,
        active: true,
        error: error.message
      };
    }
  }

  /**
   * Get current rate limit status (for API)
   * @param walletAddress - Optional wallet address for per-wallet status. If omitted, returns aggregated status.
   */
  getRateLimitStatus(walletAddress?: string): RateLimitState | Map<string, RateLimitState> {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    const dayMs = 24 * 60 * 60 * 1000;
    
    // If specific wallet requested
    if (walletAddress) {
      const walletRateState = this.perWalletRateLimits.get(walletAddress.toLowerCase());
      if (!walletRateState) {
        // No rate limit state exists for this wallet (never had rate limiting enabled or no trades)
        return {
          tradesThisHour: 0,
          tradesThisDay: 0,
          hourStartTime: now,
          dayStartTime: now
        };
      }
      
      // Update state first (reset counters if window has passed)
      if (now - walletRateState.hourStartTime > hourMs) {
        walletRateState.tradesThisHour = 0;
        walletRateState.hourStartTime = now;
      }
      if (now - walletRateState.dayStartTime > dayMs) {
        walletRateState.tradesThisDay = 0;
        walletRateState.dayStartTime = now;
      }
      
      return { ...walletRateState };
    }
    
    // Return all wallets' rate limit states (for aggregated view)
    // Update all states and return a copy
    const result = new Map<string, RateLimitState>();
    for (const [addr, state] of this.perWalletRateLimits) {
      if (now - state.hourStartTime > hourMs) {
        state.tradesThisHour = 0;
        state.hourStartTime = now;
      }
      if (now - state.dayStartTime > dayMs) {
        state.tradesThisDay = 0;
        state.dayStartTime = now;
      }
      result.set(addr, { ...state });
    }
    return result;
  }

  /**
   * Get Position Mirror instance for mirroring tracked wallet positions
   * Creates a new instance each time (stateless operation)
   */
  getPositionMirror(): PositionMirror {
    return new PositionMirror(
      this.getPolymarketApi(),
      this.getClobClient()
    );
  }
}
