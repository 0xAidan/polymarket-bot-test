import { WalletMonitor } from './walletMonitor.js';
import { DomeWebSocketMonitor } from './domeWebSocket.js';
import { isDomeConfigured } from './domeClient.js';
import { TradeExecutor } from './tradeExecutor.js';
import { PerformanceTracker } from './performanceTracker.js';
import { BalanceTracker } from './balanceTracker.js';
import { PositionMirror } from './positionMirror.js';
import { DetectedTrade, TradeOrder, TradeResult, RateLimitState, TradeSideFilter, PerWalletRateLimitStates } from './types.js';
import { decidePendingOrderReconciliation } from './noRepeatReconciliation.js';
import { Storage } from './storage.js';
import { config } from './config.js';
import { initWalletManager } from './walletManager.js';
import { assertTradeCanExecuteForWallet } from './walletConfigSafety.js';
import { buildPositionKey, normalizeOutcomeLabel } from './tradeIdentity.js';
import {
  logTradeRegressionDebug,
  summarizeDetectedTradeForDebug,
} from './tradeDiagnostics.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('CopyTrader');

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
  private monitoringMode: 'polling' | 'websocket' | 'stopped' = 'stopped';
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
        log.info('[CopyTrader] Dome API key detected — WebSocket monitoring available');
      }
      
      // Record initial balance for user wallet only (not tracked wallets to reduce RPC calls)
      const userWallet = this.getWalletAddress();
      if (userWallet) {
        try {
          await this.balanceTracker.recordBalance(userWallet);
        } catch (error: any) {
          log.warn({ detail: error.message }, `Failed to record initial balance for ${userWallet}`)
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
            log.info(`[CopyTrader] Cleaned up ${removed} expired no-repeat-trades entries (older than ${maxBlockPeriod}h)`);
          }
        }
      } catch (cleanupError: any) {
        log.warn(`[CopyTrader] Failed to cleanup expired positions: ${cleanupError.message}`);
      }
      
      log.info('Copy trader initialized');
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
      log.info('Copy trader is already running');
      return;
    }

    log.info('Starting copy trading bot...');
    this.isRunning = true;

    // Start polling monitoring (PRIMARY METHOD - most reliable for monitoring other wallets)
    // WebSocket API only monitors YOUR OWN trades, not other wallets
    log.info('🔄 Starting polling monitoring (PRIMARY METHOD)...');
    await this.monitor.startMonitoring(async (trade: DetectedTrade) => {
      log.info({ detail: JSON.stringify(trade, null, 2) }, `[CopyTrader] 📥 Polling callback triggered with trade`)
      await this.handleDetectedTrade(trade);
    });
    log.info('✅ Polling monitoring active');

    // Start Dome WebSocket monitoring if available (primary for tracked wallets)
    if (this.domeWsMonitor) {
      log.info('📡 Starting Dome WebSocket monitoring (PRIMARY)...');
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
          log.info('[DomeWS] Connected — running alongside polling for maximum coverage');
        });

        this.domeWsMonitor.on('disconnected', () => {
          this.monitoringMode = 'polling';
          log.info('[DomeWS] Disconnected — polling continues as usual');
        });

        this.domeWsMonitor.on('reconnected', () => {
          this.monitoringMode = 'websocket';
          log.info('[DomeWS] Reconnected — running alongside polling');
        });

        this.domeWsMonitor.on('trade', async (trade: DetectedTrade) => {
          log.info({
            wallet: trade.walletAddress,
            market: trade.marketId,
            side: trade.side,
            price: trade.price,
          }, 'Dome WS trade detected');
          await this.handleDetectedTrade(trade);
        });

        this.domeWsMonitor.on('error', (err: any) => {
          log.error('[DomeWS] Error:', err?.message || err);
        });

        await this.domeWsMonitor.start();
      } catch (error: any) {
        log.error({ detail: error.message }, '[DomeWS] Failed to start Dome WebSocket')
        log.info('⚠️ Continuing with polling-based monitoring');
      }
    }

    // Start balance tracking for user wallet only (reduces RPC calls significantly)
    const userWallet = this.getWalletAddress();
    if (userWallet) {
      await this.balanceTracker.startTracking([userWallet]);
    }

    const domeWsStatus = this.domeWsMonitor?.getStatus();
    log.info('\n' + '='.repeat(60));
    log.info('✅ COPY TRADING BOT IS RUNNING');
    log.info('='.repeat(60));
    log.info(`📊 Monitoring Methods:`);
    if (domeWsStatus) {
      log.info(`   🌐 Dome WebSocket: ${domeWsStatus.connected ? '✅ CONNECTED (PRIMARY)' : '⏳ CONNECTING...'} — ${domeWsStatus.trackedWallets} wallets`);
    }
    log.info(`   🔄 Polling: ✅ ACTIVE — every ${config.monitoringIntervalMs / 1000}s`);
    log.info(`\n💡 The bot will automatically detect and copy trades from tracked wallets.`);
    log.info(`   Check the logs above for trade detection and execution.`);
    log.info('='.repeat(60) + '\n');
  }

  /**
   * Stop the copy trading bot
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    log.info('Stopping copy trading bot...');
    this.isRunning = false;
    this.monitoringMode = 'stopped';
    
    // Stop Dome WebSocket if running
    if (this.domeWsMonitor) {
      this.domeWsMonitor.stop().catch(err => 
        log.error({ err: err }, '[DomeWS] Error during stop')
      );
    }
    
    this.monitor.stopMonitoring();
    this.balanceTracker.stopTracking();
    log.info('Copy trading bot stopped');
  }

  /**
   * Reinitialize all components after credentials change
   * This reloads the private key and reinitializes all clients
   */
  async reinitializeCredentials(): Promise<{ success: boolean; walletAddress: string | null; error?: string }> {
    log.info('[CopyTrader] Reinitializing with new credentials...');
    
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
      log.info(`[CopyTrader] ✓ Reinitialized with wallet: ${walletAddress}`);
      
      // Restart the bot if it was running
      if (wasRunning) {
        await this.start();
      }
      
      return { success: true, walletAddress };
    } catch (error: any) {
      log.error({ detail: error.message }, '[CopyTrader] Reinitialization failed')
      return { success: false, walletAddress: null, error: error.message };
    }
  }

  /**
   * Handle a detected trade from a tracked wallet
   */
  private async handleDetectedTrade(trade: DetectedTrade): Promise<void> {
    if (!this.isRunning) {
      log.info('[CopyTrader] Ignoring detected trade because the bot is stopped');
      return;
    }

    log.info(`\n${'='.repeat(60)}`);
    log.info(`🔔 [CopyTrader] HANDLE_DETECTED_TRADE CALLED`);
    log.info(`${'='.repeat(60)}`);
    log.info({ detail: JSON.stringify(trade, null, 2) }, '   Trade object');
    log.info(`${'='.repeat(60)}\n`);
    
    // CRITICAL: Verify the wallet is actually in the active tracked wallets list
    // This prevents executing trades from wallets that were removed or never tracked
    const activeWallets = await Storage.getActiveWallets();
    const tradeWalletLower = trade.walletAddress.toLowerCase();
    const isWalletTracked = activeWallets.some(w => w.address.toLowerCase() === tradeWalletLower);
    
    if (!isWalletTracked) {
      log.error(`\n❌ [CopyTrader] SECURITY: Trade from wallet ${trade.walletAddress.substring(0, 8)}... is NOT in active tracked wallets!`);
      log.error(`   Active tracked wallets: ${activeWallets.map(w => w.address.substring(0, 8) + '...').join(', ')}`);
      log.error(`   This trade will NOT be executed for security reasons.`);
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
      log.error(`\n❌ [CopyTrader] SECURITY: Trade detected from YOUR OWN wallet!`);
      log.error(`   Your wallet should not be in the tracked wallets list.`);
      log.error(`   This trade will NOT be executed.`);
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
    const positionKey = trade.positionKey || buildPositionKey({
      marketId: trade.marketId,
      tokenId: trade.tokenId,
      outcome: trade.outcome,
    });
    const compoundKey = `${trade.walletAddress.toLowerCase()}-${positionKey}-${trade.side}-${timeWindow}`;
    
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
      log.info(`[CopyTrader] ⏭️  Trade already processed (txHash: ${tradeKey?.substring(0,20)}...), skipping duplicate`);
      return;
    }
    
    // CHECK 2: By compound key (same trade detected with different hash - e.g., position vs trade history)
    if (this.processedCompoundKeys.has(compoundKey)) {
      log.info(`[CopyTrader] ⏭️  Trade already processed (compound key: ${compoundKey.substring(0, 30)}...), skipping duplicate detection`);
      return;
    }
    
    // CHECK 3: Currently in-flight (being executed right now, not yet finished)
    if (this.inFlightTrades.has(tradeKey) || this.inFlightTrades.has(compoundKey)) {
      log.info(`[CopyTrader] ⏭️  Trade currently in-flight, skipping concurrent processing`);
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

    try {
      assertTradeCanExecuteForWallet(trade);
    } catch (error: any) {
      // Mark the compound key too so a legacy unsafe wallet does not keep re-logging
      // the same underlying trade across polling and websocket sources.
      this.processedCompoundKeys.set(compoundKey, Date.now());

      console.error(`\n❌ [CopyTrader] SAFETY: Refusing to trade unconfigured wallet ${trade.walletAddress.substring(0, 8)}...`);
      console.error(`   ${error.message}`);
      await this.performanceTracker.recordTrade({
        timestamp: new Date(),
        walletAddress: trade.walletAddress,
        marketId: trade.marketId,
        marketTitle: trade.marketTitle,
        outcome: trade.outcome,
        amount: trade.amount,
        price: trade.price,
        success: false,
        status: 'rejected',
        executionTimeMs: 0,
        error: error.message,
        detectedTxHash: trade.transactionHash,
        tokenId: trade.tokenId
      });
      await this.performanceTracker.logIssue(
        'error',
        'trade_execution',
        error.message,
        { trade }
      );
      return;
    }
    
    log.info(`\n${'='.repeat(60)}`);
    log.info(`🔔 TRADE DETECTED`);
    log.info(`${'='.repeat(60)}`);
    log.info(`   Wallet: ${trade.walletAddress}`);
    log.info(`   Market: ${trade.marketId}`);
    log.info(`   Outcome: ${trade.outcome}`);
    log.info(`   Amount: ${trade.amount} shares`);
    log.info(`   Price: ${trade.price}`);
    log.info(`   Side: ${trade.side}`);
    log.info(`   TX: ${trade.transactionHash}`);
    log.info(`${'='.repeat(60)}`);

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
        log.warn(`[CopyTrader] ⚠️ AMOUNT SANITY CHECK: Detected amount ${amountNum} appears to be in base units (USD value would be $${rawUsdValue.toLocaleString()})`);
        log.warn(`[CopyTrader]    Correcting: ${amountNum} → ${correctedAmount} (divided by 1e6 for USDC decimals)`);
        amountNum = correctedAmount;
        trade.amount = correctedAmount.toString();
      }
    }
    
    if (!trade.marketId || trade.marketId === 'unknown') {
      log.error(`❌ Invalid marketId (${trade.marketId}), cannot execute trade`);
      await this.performanceTracker.logIssue(
        'error',
        'trade_execution',
        `Invalid marketId: ${trade.marketId}`,
        { trade }
      );
      return;
    }
    
    if (!trade.price || trade.price === '0' || isNaN(priceNum) || priceNum <= 0 || priceNum > 1) {
      log.error(`❌ Invalid price (${trade.price}), cannot execute trade`);
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
      log.info(`\n⏭️  [CopyTrader] FILTERED - Trade side filter (BUY only mode)`);
      log.info(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
      log.info(`   Trade: ${trade.side} ${trade.outcome}`);
      log.info(`   💡 This SELL trade is blocked by this wallet's side filter settings.\n`);
      await this.performanceTracker.recordTrade({
        timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId, marketTitle: trade.marketTitle,
        outcome: trade.outcome, amount: trade.amount, price: trade.price, success: false,
        status: 'rejected', executionTimeMs: 0,
        error: `Side filter: Only BUY trades allowed for this wallet`,
        detectedTxHash: trade.transactionHash, tokenId: trade.tokenId
      });
      return;
    }
    
    if (walletSideFilter === 'sell_only' && trade.side === 'BUY') {
      log.info(`\n⏭️  [CopyTrader] FILTERED - Trade side filter (SELL only mode)`);
      log.info(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
      log.info(`   Trade: ${trade.side} ${trade.outcome}`);
      log.info(`   💡 This BUY trade is blocked by this wallet's side filter settings.\n`);
      await this.performanceTracker.recordTrade({
        timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId, marketTitle: trade.marketTitle,
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
      log.info(`\n⏭️  [CopyTrader] FILTERED - Price below wallet minimum`);
      log.info(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
      log.info(`   Price: $${trade.price} (wallet minimum: $${minPrice})`);
      log.info(`   Market: ${trade.marketId}`);
      log.info(`   💡 Adjust this wallet's price limits to copy low-price trades.\n`);
      await this.performanceTracker.recordTrade({
        timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId, marketTitle: trade.marketTitle,
        outcome: trade.outcome, amount: trade.amount, price: trade.price, success: false,
        status: 'rejected', executionTimeMs: 0,
        error: `Price filter: $${trade.price} below minimum $${minPrice}`,
        detectedTxHash: trade.transactionHash, tokenId: trade.tokenId
      });
      return;
    }
    
    if (priceNum > maxPrice) {
      log.info(`\n⏭️  [CopyTrader] FILTERED - Price above wallet maximum`);
      log.info(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
      log.info(`   Price: $${trade.price} (wallet maximum: $${maxPrice})`);
      log.info(`   Market: ${trade.marketId}`);
      log.info(`   💡 Adjust this wallet's price limits to copy high-price trades.\n`);
      await this.performanceTracker.recordTrade({
        timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId, marketTitle: trade.marketTitle,
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
        await this.reconcilePendingNoRepeatBlock(trade);

        const isBlocked = await Storage.isPositionBlocked(
          trade.marketId,
          trade.outcome,
          blockPeriod,
          positionKey,
        );
        
        if (isBlocked) {
          const periodLabel = blockPeriod === 0 ? 'forever' : blockPeriod < 1 ? `${Math.round(blockPeriod * 60)}min` : `${blockPeriod}h`;
          log.info(`\n⏭️  [CopyTrader] FILTERED - No-repeat-trades (already have position)`);
          log.info(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
          log.info(`   Market: ${trade.marketId}`);
          log.info(`   Side: ${trade.side} | Outcome: ${trade.outcome}`);
          log.info(`   Block period: ${periodLabel}${!trade.noRepeatEnabled ? ' (global safety minimum)' : ''}`);
          log.info(`   💡 You already have a ${trade.outcome} position in this market. Skipping repeat trade.\n`);
          
          await this.performanceTracker.recordTrade({
            timestamp: new Date(),
            walletAddress: trade.walletAddress,
            marketId: trade.marketId,
            marketTitle: trade.marketTitle,
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
        log.error(`[CopyTrader] No-repeat check FAILED — BLOCKING trade for safety: ${noRepeatError.message}`);
        await this.performanceTracker.recordTrade({
          timestamp: new Date(),
          walletAddress: trade.walletAddress,
          marketId: trade.marketId,
          marketTitle: trade.marketTitle,
          outcome: trade.outcome,
          amount: trade.amount,
          price: trade.price,
          success: false,
          status: 'rejected',
          executionTimeMs: 0,
          error: `[NO_REPEAT_CHECK_FAILED] ${noRepeatError.message}`,
          detectedTxHash: trade.transactionHash,
          tokenId: trade.tokenId,
        });
        await this.performanceTracker.logIssue(
          'warning',
          'trade_execution',
          `[NO_REPEAT_CHECK_FAILED] Trade blocked for safety`,
          {
            walletAddress: trade.walletAddress,
            marketId: trade.marketId,
            outcome: trade.outcome,
            side: trade.side,
            error: noRepeatError.message,
          }
        );
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
        log.info(`\n⏭️  [CopyTrader] FILTERED - Trade value below wallet minimum`);
        log.info(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
        log.info(`   Detected trade value: $${detectedTradeValue.toFixed(2)}`);
        log.info(`   Wallet minimum: $${trade.valueFilterMin}`);
        log.info(`   💡 This trade is too small based on this wallet's value filter.\n`);
        await this.performanceTracker.recordTrade({
          timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId, marketTitle: trade.marketTitle,
          outcome: trade.outcome, amount: trade.amount, price: trade.price, success: false,
          status: 'rejected', executionTimeMs: 0,
          error: `Value filter: $${detectedTradeValue.toFixed(2)} below minimum $${trade.valueFilterMin}`,
          detectedTxHash: trade.transactionHash, tokenId: trade.tokenId
        });
        return;
      }
      
      if (trade.valueFilterMax !== null && trade.valueFilterMax !== undefined && detectedTradeValue > trade.valueFilterMax) {
        log.info(`\n⏭️  [CopyTrader] FILTERED - Trade value above wallet maximum`);
        log.info(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
        log.info(`   Detected trade value: $${detectedTradeValue.toFixed(2)}`);
        log.info(`   Wallet maximum: $${trade.valueFilterMax}`);
        log.info(`   💡 This trade is too large based on this wallet's value filter.\n`);
        await this.performanceTracker.recordTrade({
          timestamp: new Date(), walletAddress: trade.walletAddress, marketId: trade.marketId, marketTitle: trade.marketTitle,
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
        log.info(`\n⏭️  [CopyTrader] RATE LIMITED - Max trades per hour for wallet`);
        log.info(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
        log.info(`   Trades this hour: ${walletRateState.tradesThisHour}/${maxPerHour}`);
        log.info(`   💡 Adjust this wallet's rate limit or wait for the next hour.\n`);
        
        await this.performanceTracker.recordTrade({
          timestamp: new Date(),
          walletAddress: trade.walletAddress,
          marketId: trade.marketId,
          marketTitle: trade.marketTitle,
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
        log.info(`\n⏭️  [CopyTrader] RATE LIMITED - Max trades per day for wallet`);
        log.info(`   Wallet: ${trade.walletAddress.slice(0, 10)}...`);
        log.info(`   Trades today: ${walletRateState.tradesThisDay}/${maxPerDay}`);
        log.info(`   💡 Adjust this wallet's rate limit or wait until tomorrow.\n`);
        
        await this.performanceTracker.recordTrade({
          timestamp: new Date(),
          walletAddress: trade.walletAddress,
          marketId: trade.marketId,
          marketTitle: trade.marketTitle,
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
      log.error(`❌ Invalid side (${trade.side}), cannot execute trade`);
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
        log.info(`\n⏭️  [CopyTrader] STOP-LOSS ACTIVE - Too much USDC committed to positions`);
        log.info(`   💡 Close some positions to resume copy trading.\n`);
        
        await this.performanceTracker.recordTrade({
          timestamp: new Date(),
          walletAddress: trade.walletAddress,
          marketId: trade.marketId,
          marketTitle: trade.marketTitle,
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
      log.error(`[CopyTrader] Stop-loss check FAILED — BLOCKING trade for safety: ${stopLossError.message}`);
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
        log.info(`[Trade] Mode: PROPORTIONAL (matching their % of portfolio)`);
        
        // Get tracked wallet's TOTAL portfolio value (USDC balance + positions)
        // USDC is fetched from their proxy wallet on-chain via Alchemy RPC
        let theirPortfolioValue = 0;
        try {
          const polymarketApi = this.monitor.getApi();
          const portfolioData = await polymarketApi.getPortfolioValue(trade.walletAddress, this.balanceTracker);
          theirPortfolioValue = portfolioData.totalValue;
          log.info(`[Trade] Their Polymarket portfolio: $${theirPortfolioValue.toFixed(2)} (USDC: $${portfolioData.usdcBalance.toFixed(2)} + ${portfolioData.positionCount} positions: $${portfolioData.positionsValue.toFixed(2)})`);
        } catch (balanceError: any) {
          log.warn(`[CopyTrader] Could not fetch tracked wallet portfolio: ${balanceError.message}`);
        }
        
        // Get OUR USDC balance from Polymarket CLOB API (our tradable funds)
        let ourBalance = 0;
        try {
          const clobClient = this.executor.getClobClient();
          ourBalance = await clobClient.getUsdcBalance();
          log.info(`[Trade] Our Polymarket USDC balance: $${ourBalance.toFixed(2)}`);
        } catch (balanceError: any) {
          log.warn(`[CopyTrader] Could not fetch our USDC balance: ${balanceError.message}`);
        }
        
        if (theirPortfolioValue > 0 && ourBalance > 0) {
          // Calculate what % of their portfolio this trade represents
          const tradeValueUsd = amountNum * priceNum;
          const theirTradePercent = (tradeValueUsd / theirPortfolioValue) * 100;
          
          // Apply the same % to our tradable balance
          tradeSizeUsdcNum = (theirTradePercent / 100) * ourBalance;
          tradeSizeSource = `proportional (${theirTradePercent.toFixed(2)}% of their $${theirPortfolioValue.toFixed(2)} portfolio = ${theirTradePercent.toFixed(2)}% of our $${ourBalance.toFixed(2)})`;
          
          log.info(`[Trade] Their trade: $${tradeValueUsd.toFixed(2)} (${theirTradePercent.toFixed(2)}% of their $${theirPortfolioValue.toFixed(2)} portfolio)`);
          log.info(`[Trade] Our trade: $${tradeSizeUsdcNum.toFixed(2)} (${theirTradePercent.toFixed(2)}% of our $${ourBalance.toFixed(2)} USDC)`);
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
          log.warn(`[Trade] Proportional mode failed (their portfolio: $${theirPortfolioValue}, our balance: $${ourBalance}), using ${tradeSizeSource}: $${tradeSizeUsdcNum}`);
        }
        
      } else if (trade.tradeSizingMode === 'fixed') {
        // FIXED MODE: Use wallet-specific USDC amount + optional threshold filter
        log.info(`[Trade] Mode: FIXED (wallet-specific settings)`);
        
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
            log.info(`[Trade] Threshold check - Their portfolio: $${walletPortfolioValue.toFixed(2)} (USDC: $${portfolioData.usdcBalance.toFixed(2)} + ${portfolioData.positionCount} positions: $${portfolioData.positionsValue.toFixed(2)})`);
          } catch (balanceError: any) {
            log.warn(`[CopyTrader] Could not fetch wallet portfolio for threshold check: ${balanceError.message}`);
          }
          
          if (walletPortfolioValue > 0) {
            const tradeValueUsd = amountNum * priceNum;
            const tradePercent = (tradeValueUsd / walletPortfolioValue) * 100;
            
            if (tradePercent < trade.thresholdPercent) {
              log.info(`\n⏭️  [CopyTrader] FILTERED - Trade below wallet threshold`);
              log.info(`   Trade value: $${tradeValueUsd.toFixed(2)} (${tradePercent.toFixed(2)}% of portfolio)`);
              log.info(`   Wallet portfolio value: $${walletPortfolioValue.toFixed(2)}`);
              log.info(`   Wallet threshold: ${trade.thresholdPercent}%`);
              log.info(`   💡 This trade is below the configured threshold for this wallet. Skipping.\n`);
              
              await this.performanceTracker.recordTrade({
                timestamp: new Date(),
                walletAddress: trade.walletAddress,
                marketId: trade.marketId,
                marketTitle: trade.marketTitle,
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
              log.info(`[CopyTrader] ✓ Trade passes wallet threshold: $${tradeValueUsd.toFixed(2)} (${tradePercent.toFixed(2)}% of $${walletPortfolioValue.toFixed(2)}) >= ${trade.thresholdPercent}%`);
            }
          } else {
            log.warn(`[CopyTrader] ⚠️ Could not get portfolio value for threshold check - proceeding with trade`);
          }
        }
        
      } else {
        // DEFAULT MODE: Use global trade size, NO filtering - copy ALL trades
        log.info(`[Trade] Mode: DEFAULT (global size, no filtering)`);
        const globalTradeSize = await Storage.getTradeSize();
        tradeSizeUsdcNum = parseFloat(globalTradeSize || '2');
        tradeSizeSource = `global ($${globalTradeSize})`;
      }
      
      // Validate final trade size
      if (isNaN(tradeSizeUsdcNum) || tradeSizeUsdcNum <= 0) {
        log.error(`❌ Invalid calculated trade size ($${tradeSizeUsdcNum} USDC), cannot execute trade`);
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
        log.error(`\n❌ [CopyTrader] SAFETY CAP: Order $${tradeSizeUsdcNum.toFixed(2)} exceeds max $${maxAllowedUsd.toFixed(2)} (${trade.tradeSizingMode === 'proportional' ? 'proportional 2x / $500 floor' : `2x configured $${configuredSize}`})`);
        log.error(`   Mode: ${tradeSizeSource}`);
        log.error(`   This likely indicates a bug in trade sizing. Trade BLOCKED.\n`);
        await this.performanceTracker.logIssue(
          'error',
          'trade_execution',
          `Safety cap: Order $${tradeSizeUsdcNum.toFixed(2)} exceeds max $${maxAllowedUsd.toFixed(2)}`,
          { trade, tradeSizeSource, tradeSizeUsdcNum, maxAllowedUsd }
        );
        return;
      }

      // Pre-flight affordability guard for BUY orders.
      // We cap order size to spendable collateral to avoid avoidable CLOB 400 failures.
      if (trade.side === 'BUY') {
        try {
          const clobClient = this.executor.getClobClient();
          const collateral = await clobClient.getCollateralStatus();
          const reserveUsdc = 0.5; // Keep a tiny reserve to avoid edge-case precision rejections.
          const maxSpendableUsdc = Math.max(0, collateral.spendableUsdc - reserveUsdc);

          if (maxSpendableUsdc <= 0) {
            console.error(`\n❌ [CopyTrader] BUY BLOCKED — spendable collateral is $0.00`);
            console.error(`   Balance: $${collateral.balanceUsdc.toFixed(2)}`);
            console.error(`   Allowance: ${collateral.allowanceUsdc === null ? 'unknown' : '$' + collateral.allowanceUsdc.toFixed(2)}`);
            console.error(`   Required before reserve: $${tradeSizeUsdcNum.toFixed(2)}\n`);
            await this.performanceTracker.recordTrade({
              timestamp: new Date(),
              walletAddress: trade.walletAddress,
              marketId: trade.marketId,
              marketTitle: trade.marketTitle,
              outcome: trade.outcome,
              amount: trade.amount,
              price: trade.price,
              success: false,
              status: 'rejected',
              executionTimeMs: Date.now() - executionStart,
              error: `Insufficient spendable collateral (balance/allowance): $${collateral.spendableUsdc.toFixed(2)} available`,
              detectedTxHash: trade.transactionHash,
              tokenId: trade.tokenId,
            });
            return;
          }

          if (tradeSizeUsdcNum > maxSpendableUsdc) {
            const originalTradeSize = tradeSizeUsdcNum;
            tradeSizeUsdcNum = parseFloat(maxSpendableUsdc.toFixed(2));
            tradeSizeSource = `${tradeSizeSource}, clamped to spendable collateral`;
            console.log(
              `[Trade] Clamped BUY size from $${originalTradeSize.toFixed(2)} to ` +
              `$${tradeSizeUsdcNum.toFixed(2)} based on spendable collateral ` +
              `($${collateral.spendableUsdc.toFixed(2)} before reserve)`
            );
          }
        } catch (collateralError: any) {
          console.warn(`[CopyTrader] Could not run collateral pre-flight check: ${collateralError.message}`);
        }
      }
      
      // Calculate number of shares based on USDC amount and price
      // shares = USDC amount / price per share
      const sharesAmount = tradeSizeUsdcNum / priceNum;
      const sharesAmountRounded = parseFloat(sharesAmount.toFixed(2)); // Round to 2 decimal places
      
      log.info(`[Trade] Trade size: $${tradeSizeUsdcNum.toFixed(2)} USDC (${tradeSizeSource})`);
      log.info(`[Trade] Price per share: $${trade.price}`);
      log.info(`[Trade] Calculated shares: ${sharesAmountRounded} shares ($${tradeSizeUsdcNum.toFixed(2)} / $${priceNum})`);
      
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
          log.warn({ err: minSizeError.message }, `[Trade] Could not fetch market min_order_size, using default of 5`);
        }
      }
      
      // Check if calculated shares are below market minimum
      let finalCalculatedShares = sharesAmountRounded;
      if (sharesAmountRounded < marketMinShares) {
        const minUsdcRequired = marketMinShares * priceNum;
        
        // Reject trade - order size below minimum
        log.info(`\n❌ [CopyTrader] ORDER SIZE BELOW MARKET MINIMUM`);
        log.info(`   Calculated shares: ${sharesAmountRounded} (market minimum: ${marketMinShares})`);
        log.info(`   Your configured trade size: $${tradeSizeUsdcNum.toFixed(2)} USDC`);
        log.info(`   Minimum USDC needed at this price: $${minUsdcRequired.toFixed(2)}`);
        log.info(`   💡 Increase trade size to at least $${Math.ceil(minUsdcRequired)} USDC in settings\n`);
        await this.performanceTracker.recordTrade({
          timestamp: new Date(),
          walletAddress: trade.walletAddress,
          marketId: trade.marketId,
          marketTitle: trade.marketTitle,
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
        log.info(`\n🔍 [CopyTrader] SELL ORDER - Checking if we own shares...`);
        
        // Get user's positions to check if we own this token
        const sellUserWallet = this.getWalletAddress();
        if (!sellUserWallet) {
          log.info(`⏭️  [CopyTrader] SKIPPING SELL - Cannot determine user wallet`);
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
            log.info(`\n⏭️  [CopyTrader] SKIPPING SELL ORDER - No shares owned`);
            log.info(`   Token ID: ${trade.tokenId?.substring(0, 20)}...`);
            log.info(`   Market: ${trade.marketId}`);
            log.info(`   Outcome: ${trade.outcome}`);
            log.info(`   You don't own any shares of this position to sell.\n`);
            // Don't log as error - this is expected behavior
            return;
          }
          
          const ownedShares = parseFloat(matchingPosition.size);
          log.info(`   ✓ Found position! You own ${ownedShares.toFixed(2)} shares`);
          
          // Limit sell to owned shares (can't sell more than we have)
          if (finalSharesAmount > ownedShares) {
            log.info(`   ⚠️  Adjusting sell amount: ${finalSharesAmount} → ${ownedShares.toFixed(2)} (can't sell more than owned)`);
            finalSharesAmount = parseFloat(ownedShares.toFixed(2));
          }
          
          log.info(`   ✓ Proceeding to sell ${finalSharesAmount} shares\n`);
          
        } catch (positionError: any) {
          log.error({ err: positionError.message }, `❌ [CopyTrader] Failed to check positions`);
          log.info(`⏭️  [CopyTrader] SKIPPING SELL - Cannot verify share ownership\n`);
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
        positionKey,
        slippagePercent: trade.slippagePercent,  // Per-wallet slippage (executor falls back to storage)
      };

      logTradeRegressionDebug('copy-trader.execution-input', {
        source: 'copy-trader',
        detectedTrade: summarizeDetectedTradeForDebug(trade),
        order: {
          marketId: order.marketId,
          outcome: order.outcome,
          amount: order.amount,
          price: order.price,
          side: order.side,
          tokenId: order.tokenId,
          negRisk: order.negRisk,
          slippagePercent: order.slippagePercent,
        },
      });

      log.info(`\n🚀 [Execute] EXECUTING TRADE:`);
      log.info(`   Action: ${order.side}`);
      log.info(`   Amount: $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares)`);
      log.info(`   Market: ${order.marketId}`);
      log.info(`   Outcome: ${order.outcome}`);
      log.info(`   Price: ${order.price}`);
      log.info(`   Time: ${new Date().toISOString()}`);

      const baselinePositionSize = await this.getCurrentPositionSize(trade);

      if (!this.isRunning) {
        log.info('[CopyTrader] Trade execution aborted because the bot was stopped during pre-flight checks');
        return;
      }
      
      // Execute the trade
      const result: TradeResult = await this.executor.executeTrade(order);
      const executionTime = Date.now() - executionStart;
      
      // Record metrics
      // NOTE: result.success is now only true if order was actually executed (not just placed)
      await this.performanceTracker.recordTrade({
        timestamp: trade.timestamp instanceof Date ? trade.timestamp : new Date(trade.timestamp),
        walletAddress: trade.walletAddress,
        marketId: trade.marketId,
        marketTitle: trade.marketTitle,
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
        log.info(`\n${'='.repeat(60)}`);
        log.info(`✅ [Execute] TRADE EXECUTED SUCCESSFULLY!`);
        log.info(`${'='.repeat(60)}`);
        log.info(`   Order ID: ${result.orderId}`);
        log.info(`   TX Hash: ${result.transactionHash || 'Pending'}`);
        log.info(`   Execution Time: ${executionTime}ms`);
        log.info(`   Market: ${order.marketId}`);
        log.info(`   Outcome: ${order.outcome}`);
        log.info(`   Side: ${order.side} $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares) @ ${order.price}`);
        log.info(`${'='.repeat(60)}\n`);
        this.executedTradesCount++;

        // ALWAYS record executed position for cross-restart dedup.
        // Not gated on noRepeatEnabled — every successful trade is persisted so the
        // no-repeat safety check (5-min minimum for all trades) has data to work with.
        try {
          await Storage.addExecutedPosition(trade.marketId, trade.outcome, trade.walletAddress, {
            orderId: result.orderId,
            tokenId: order.tokenId,
            positionKey,
          });
          console.log(`[CopyTrader] Recorded position for no-repeat-trades: ${trade.marketId} ${trade.outcome}`);
        } catch (recordError: any) {
          await this.handleCriticalNoRepeatPersistenceFailure(
            `Failed to record executed position after live trade fill: ${recordError.message}`,
            { trade, result, order }
          );
          return;
        }

        // Mark as processed now that execution and persistence both succeeded
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
      } else if (result.status === 'pending' && result.orderId) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`⏳ [Execute] TRADE PENDING ON ORDER BOOK`);
        console.log(`${'='.repeat(60)}`);
        console.log(`   Order ID: ${result.orderId}`);
        console.log(`   Market: ${order.marketId}`);
        console.log(`   Outcome: ${order.outcome}`);
        console.log(`   Side: ${order.side} $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares) @ ${order.price}`);
        console.log(`   💡 A temporary no-repeat block has been recorded until this order is reconciled.`);
        console.log(`${'='.repeat(60)}\n`);

        try {
          await Storage.addPendingPosition(
            trade.marketId,
            trade.outcome,
            trade.walletAddress,
            result.orderId,
            order.tokenId,
            baselinePositionSize,
            trade.side,
            positionKey,
          );
          log.info(`[CopyTrader] Recorded pending no-repeat block: ${trade.marketId} ${trade.outcome} (order ${result.orderId})`);
        } catch (recordError: any) {
          await this.handleCriticalNoRepeatPersistenceFailure(
            `Failed to record pending no-repeat block for live order ${result.orderId}: ${recordError.message}`,
            { trade, result, order }
          );
          return;
        }

        this.processedTrades.set(tradeKey, Date.now());
        this.processedCompoundKeys.set(compoundKey, Date.now());
      } else {
        // Check if this is a "market closed" error (expected behavior, not a failure)
        const isMarketClosed = result.error?.includes('MARKET_CLOSED') || 
                               result.error?.includes('orderbook') && result.error?.includes('does not exist');
        
        if (isMarketClosed) {
          // Market is resolved/closed - this is expected, log as info not error
          log.info(`\n${'='.repeat(60)}`);
          log.info(`⏭️  [CopyTrader] SKIPPING TRADE - Market Closed/Resolved`);
          log.info(`${'='.repeat(60)}`);
          log.info(`   Market: ${order.marketId}`);
          log.info(`   Outcome: ${order.outcome}`);
          log.info(`   Side: ${order.side} $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares) @ ${order.price}`);
          log.info(`   💡 The tracked wallet traded on a market that has since been resolved.`);
          log.info(`   💡 This is normal - markets close when events conclude.`);
          log.info(`${'='.repeat(60)}\n`);
          // Don't log as error - this is expected behavior
          // Still mark as processed so we don't keep retrying a closed market
          this.processedTrades.set(tradeKey, Date.now());
          this.processedCompoundKeys.set(compoundKey, Date.now());
        } else {
          log.error(`\n${'='.repeat(60)}`);
          log.error(`❌ [Execute] TRADE EXECUTION FAILED`);
          log.error(`${'='.repeat(60)}`);
          log.error(`   Error: ${result.error}`);
          log.error(`   Market: ${order.marketId}`);
          log.error(`   Side: ${order.side} $${tradeSizeUsdcNum.toFixed(2)} USDC (${order.amount} shares) @ ${order.price}`);
          log.error(`${'='.repeat(60)}\n`);
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
      log.error(`Error handling trade: ${error.message}`);

      // Record failed trade
      await this.performanceTracker.recordTrade({
        timestamp: new Date(),
        walletAddress: trade.walletAddress,
        marketId: trade.marketId,
        marketTitle: trade.marketTitle,
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
    monitoringMode: 'polling' | 'websocket' | 'stopped';
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

  private async reconcilePendingNoRepeatBlock(trade: DetectedTrade): Promise<void> {
    const positionKey = trade.positionKey || buildPositionKey({
      marketId: trade.marketId,
      tokenId: trade.tokenId,
      outcome: trade.outcome,
    });
    const pendingBlocks = (await Storage.getExecutedPositions()).filter(
      position =>
        (
          position.positionKey === positionKey ||
          (position.tokenId && positionKey === `token:${position.tokenId}`) ||
          (position.marketId === trade.marketId && position.side === trade.outcome)
        ) &&
        (position.status ?? 'executed') === 'pending'
    );

    if (pendingBlocks.length === 0) {
      return;
    }

    const openOrders = await this.executor.getClobClient().getOpenOrders();
    const openOrderIds = new Set(
      openOrders
        .map(order => order?.orderID ?? order?.orderId ?? order?.id)
        .filter((orderId): orderId is string => typeof orderId === 'string' && orderId.length > 0)
    );

    const currentPositionSize = await this.getCurrentPositionSize(trade);

    let promotedPendingBlock = false;
    let clearedPendingBlock = false;

    for (const pendingBlock of pendingBlocks) {
      const decision = decidePendingOrderReconciliation({
        pendingOrderId: pendingBlock.orderId,
        openOrderIds,
        currentPositionSize,
        baselinePositionSize: pendingBlock.baselinePositionSize,
        missingOrderChecks: pendingBlock.missingOrderChecks,
        tradeSide: pendingBlock.tradeSideAction ?? 'BUY',
      });

      if (decision === 'still_open') {
        if (pendingBlock.orderId) {
          await Storage.resetPendingPositionMissingOrderChecks(pendingBlock.orderId);
        }
        console.log(`[CopyTrader] Pending no-repeat block still active for ${trade.marketId} ${trade.outcome} (open order remains on book)`);
        return;
      }

      if (decision === 'executed' && pendingBlock.orderId) {
        await Storage.markPendingPositionExecuted(pendingBlock.orderId);
        promotedPendingBlock = true;
        continue;
      }

      if (decision === 'await_more_evidence' && pendingBlock.orderId) {
        const missingChecks = await Storage.incrementPendingPositionMissingOrderChecks(pendingBlock.orderId);
        console.log(`[CopyTrader] Pending no-repeat block missing from open orders for ${trade.marketId} ${trade.outcome}; confirming with a fresh snapshot`);

        const confirmedOpenOrders = await this.executor.getClobClient().getOpenOrders();
        const confirmedOpenOrderIds = new Set(
          confirmedOpenOrders
            .map(order => order?.orderID ?? order?.orderId ?? order?.id)
            .filter((orderId): orderId is string => typeof orderId === 'string' && orderId.length > 0)
        );
        const confirmedPositionSize = await this.getCurrentPositionSize(trade);
        const confirmationDecision = decidePendingOrderReconciliation({
          pendingOrderId: pendingBlock.orderId,
          openOrderIds: confirmedOpenOrderIds,
          currentPositionSize: confirmedPositionSize,
          baselinePositionSize: pendingBlock.baselinePositionSize,
          missingOrderChecks: missingChecks ?? pendingBlock.missingOrderChecks,
          tradeSide: pendingBlock.tradeSideAction ?? 'BUY',
        });

        if (confirmationDecision === 'still_open') {
          await Storage.resetPendingPositionMissingOrderChecks(pendingBlock.orderId);
          console.log(`[CopyTrader] Pending no-repeat block confirmed as still open for ${trade.marketId} ${trade.outcome}`);
          return;
        }

        if (confirmationDecision === 'executed') {
          await Storage.markPendingPositionExecuted(pendingBlock.orderId);
          promotedPendingBlock = true;
          continue;
        }

        if (confirmationDecision === 'clear_pending') {
          await Storage.removePendingPosition(pendingBlock.orderId);
          clearedPendingBlock = true;
          continue;
        }

        console.log(
          `[CopyTrader] Pending no-repeat block remains in safety hold for ${trade.marketId} ${trade.outcome}` +
          (missingChecks ? ` (${missingChecks}/2)` : '')
        );
        return;
      }

      if (decision === 'clear_pending' && pendingBlock.orderId) {
        await Storage.removePendingPosition(pendingBlock.orderId);
        clearedPendingBlock = true;
      }
    }

    if (promotedPendingBlock) {
      console.log(`[CopyTrader] Promoted pending no-repeat block to executed position: ${trade.marketId} ${trade.outcome}`);
    }

    if (clearedPendingBlock) {
      console.log(`[CopyTrader] Cleared stale pending no-repeat block: ${trade.marketId} ${trade.outcome}`);
    }
  }

  private async getCurrentPositionSize(trade: DetectedTrade): Promise<number> {
    const positionsWallet =
      this.executor.getFunderAddress() ||
      (await this.getProxyWalletAddress()) ||
      this.getWalletAddress();

    if (!positionsWallet) {
      throw new Error('Could not determine trading wallet for position reconciliation');
    }

    const livePositions = await this.monitor.getApi().getUserPositions(positionsWallet);
    const matchingPosition = livePositions.find((position: any) => {
      const positionTokenId = String(position.asset || position.tokenId || '').trim();
      if (trade.tokenId && positionTokenId) {
        return positionTokenId === trade.tokenId;
      }

      const positionMarketId = String(position.conditionId || position.marketId || '').trim();
      const positionOutcome = normalizeOutcomeLabel(
        typeof position.outcome === 'string' ? position.outcome : undefined,
        typeof position.outcomeIndex === 'number' ? position.outcomeIndex : undefined,
      );

      return positionMarketId === trade.marketId && positionOutcome === normalizeOutcomeLabel(trade.outcome);
    });

    return Number(matchingPosition?.size ?? 0);
  }

  private async handleCriticalNoRepeatPersistenceFailure(message: string, details: Record<string, unknown>): Promise<void> {
    console.error(`[CopyTrader] CRITICAL NO-REPEAT FAILURE: ${message}`);
    this.stop();
    try {
      await this.performanceTracker.logIssue(
        'error',
        'trade_execution',
        message,
        details
      );
    } catch (logError: any) {
      console.error(`[CopyTrader] Failed to persist critical issue log after stopping bot: ${logError.message}`);
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
        log.warn(`[CopyTrader] Cannot check stop-loss: wallet address not available`);
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
        log.error(`[CopyTrader] Cannot fetch USDC balance for stop-loss check — BLOCKING trades for safety: ${error.message}`);
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
        log.error(`[CopyTrader] Cannot fetch positions for stop-loss check — BLOCKING trades for safety: ${error.message}`);
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
      
      log.info(`[CopyTrader] Stop-loss check: ${commitmentPercent.toFixed(2)}% committed ($${positionsValue.toFixed(2)} in positions / $${totalValue.toFixed(2)} total), limit: ${stopLossConfig.maxCommitmentPercent}%`);

      const active = commitmentPercent >= stopLossConfig.maxCommitmentPercent;
      if (active) {
        log.info(`[CopyTrader] ⚠️ STOP-LOSS ACTIVE: ${commitmentPercent.toFixed(2)}% >= ${stopLossConfig.maxCommitmentPercent}%`);
      }

      return {
        enabled: true,
        maxCommitmentPercent: stopLossConfig.maxCommitmentPercent,
        commitmentPercent,
        active
      };
    } catch (error: any) {
      log.error(`[CopyTrader] Stop-loss check error — BLOCKING trades for safety: ${error.message}`);
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
