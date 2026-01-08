import * as ethers from 'ethers';
import { config } from './config.js';
import { Storage } from './storage.js';
import { PolymarketApi } from './polymarketApi.js';
import { DetectedTrade } from './types.js';

/**
 * Monitors wallet addresses for Polymarket trades
 * Uses Polymarket Data API to detect trades and positions
 */
export class WalletMonitor {
  private provider: any | null = null;
  private api: PolymarketApi;
  private isMonitoring = false;
  private monitoredPositions = new Map<string, Map<string, any>>(); // wallet -> tokenId -> position
  private pollingInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.api = new PolymarketApi();
  }

  /**
   * Initialize the monitor with blockchain connection and API
   */
  async initialize(): Promise<void> {
    try {
      this.provider = new (ethers as any).providers.JsonRpcProvider(config.polygonRpcUrl);
      await this.api.initialize();
      console.log('Connected to Polygon network and Polymarket API');
    } catch (error) {
      console.error('Failed to initialize monitor:', error);
      throw error;
    }
  }

  /**
   * Start monitoring tracked wallets for trades
   * Polls Polymarket Data API for position changes
   */
  async startMonitoring(
    onTradeDetected: (trade: DetectedTrade) => void
  ): Promise<void> {
    if (!this.provider) {
      await this.initialize();
    }

    this.isMonitoring = true;
    console.log('Starting wallet monitoring...');

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'walletMonitor.ts:startMonitoring-ENTRY',message:'startMonitoring called, about to initializePositions',data:{isMonitoring:this.isMonitoring},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3-H5'})}).catch(()=>{});
    // #endregion

    // Get initial positions for all tracked wallets
    await this.initializePositions();

    // Start polling for position changes
    // Run immediately on start, then at intervals
    console.log(`[Monitor] Running initial trade check...`);
    await this.checkWalletsForTrades(onTradeDetected);
    
    this.pollingInterval = setInterval(async () => {
      if (!this.isMonitoring) return;
      try {
        await this.checkWalletsForTrades(onTradeDetected);
      } catch (error: any) {
        console.error(`[Monitor] Error in polling cycle:`, error.message);
        console.error(`[Monitor] Stack:`, error.stack);
        // Continue polling even if one cycle fails
      }
    }, config.monitoringIntervalMs);

    const wallets = await Storage.getActiveWallets();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Monitor] 📊 POLLING-BASED MONITORING STARTED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`[Monitor] Monitoring interval: ${config.monitoringIntervalMs}ms (${config.monitoringIntervalMs / 1000}s)`);
    console.log(`[Monitor] Active wallets: ${wallets.length}`);
    
    if (wallets.length === 0) {
      console.warn(`\n[Monitor] ⚠️  WARNING: No wallets are being tracked!`);
      console.warn(`[Monitor] Add wallets via the web UI or API to start copy trading`);
      console.warn(`[Monitor] Web UI: http://localhost:${config.port || 3000}\n`);
    } else {
      console.log(`[Monitor] Tracked wallet addresses:`);
      for (const wallet of wallets) {
        const status = wallet.active ? '✅ ACTIVE' : '⏸️  INACTIVE';
        console.log(`[Monitor]   • ${wallet.address.substring(0, 10)}...${wallet.address.substring(wallet.address.length - 8)} - ${status}`);
      }
      console.log(`${'='.repeat(60)}\n`);
    }
  }

  /**
   * Initialize position tracking for all wallets
   */
  private async initializePositions(): Promise<void> {
    const wallets = await Storage.getActiveWallets();
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'walletMonitor.ts:initializePositions-ENTRY',message:'initializePositions called',data:{walletCount:wallets.length,walletAddresses:wallets.map(w=>w.address.substring(0,10)+'...'),activeWallets:wallets.filter(w=>w.active).length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3-H5'})}).catch(()=>{});
    // #endregion
    
    for (const wallet of wallets) {
      try {
        const eoaAddress = wallet.address.toLowerCase();
        
        // First try to get positions directly - Polymarket Data API works with EOA addresses
        // The API response will include proxyWallet field if one exists
        let positions = await this.api.getUserPositions(eoaAddress);
        let monitoringAddress = eoaAddress;
        
        // DEBUG: Log the first position structure to understand the API response
        if (positions.length > 0) {
          console.log(`[Monitor] DEBUG: First position structure for ${eoaAddress.substring(0, 8)}...:`, 
            JSON.stringify(positions[0], null, 2).substring(0, 500) + '...');
          
          // Extract proxy wallet from positions if available
          const proxyWallet = positions[0].proxyWallet;
          if (proxyWallet) {
            monitoringAddress = proxyWallet.toLowerCase();
            console.log(`[Monitor] Extracted proxy wallet from positions: ${monitoringAddress.substring(0, 8)}... for EOA: ${eoaAddress.substring(0, 8)}...`);
          }
        } else {
          console.log(`[Monitor] No positions found for ${eoaAddress.substring(0, 8)}... (new wallet or empty)`);
        }
        
        const positionMap = new Map<string, any>();
        
        for (const position of positions) {
          // FIXED: Use 'asset' field which is the token ID in Polymarket API
          // The API returns: asset (token ID), conditionId (market ID), size, avgPrice, outcome, etc.
          const tokenId = position.asset;
          if (tokenId) {
            positionMap.set(tokenId, position);
          } else {
            console.warn(`[Monitor] Position missing 'asset' field:`, JSON.stringify(position).substring(0, 200));
          }
        }
        
        // Use EOA address as key for consistency (we can look up positions by either)
        this.monitoredPositions.set(eoaAddress, positionMap);
        console.log(`[Monitor] Initialized ${positionMap.size} positions for ${eoaAddress.substring(0, 8)}...`);
      } catch (error: any) {
        console.warn(`[Monitor] Failed to initialize positions for ${wallet.address}:`, error.message);
      }
    }
  }

  /**
   * Check tracked wallets for new trades by comparing position changes
   */
  private async checkWalletsForTrades(
    onTradeDetected: (trade: DetectedTrade) => void
  ): Promise<void> {
    const wallets = await Storage.getActiveWallets();
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'walletMonitor.ts:checkWalletsForTrades-ENTRY',message:'Check wallets called',data:{walletCount:wallets.length,walletAddresses:wallets.map(w=>w.address),monitoredPositionsKeys:Array.from(this.monitoredPositions.keys())},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3-H5'})}).catch(()=>{});
    // #endregion
    
    if (wallets.length === 0) {
      // No wallets to monitor, skip this check
      return;
    }

    console.log(`[Monitor] Checking ${wallets.length} wallet(s) for trades...`);

    for (const wallet of wallets) {
      try {
        const eoaAddress = wallet.address.toLowerCase();
        console.log(`[Monitor] Checking wallet ${eoaAddress.substring(0, 8)}... for positions and trades`);
        
        // Polymarket Data API works directly with EOA addresses
        // The positions response includes proxyWallet field if one exists
        let currentPositions: any[] = [];
        
        try {
          currentPositions = await this.api.getUserPositions(eoaAddress);
          console.log(`[Monitor] Found ${currentPositions.length} current position(s) for ${eoaAddress.substring(0, 8)}...`);
        } catch (error: any) {
          console.error(`[Monitor] Failed to get positions for ${eoaAddress.substring(0, 8)}...:`, error.message);
          continue; // Skip to next wallet
        }
        
        // Use EOA address as the key for tracking (consistent with initializePositions)
        const previousPositions = this.monitoredPositions.get(eoaAddress) || new Map();
        console.log(`[Monitor] Tracking ${previousPositions.size} previous position(s) for ${eoaAddress.substring(0, 8)}...`);

        // Create map of current positions using CORRECT field name: 'asset'
        const currentPositionMap = new Map<string, any>();
        for (const position of currentPositions) {
          // FIXED: Use 'asset' field which is the token ID in Polymarket API
          const tokenId = position.asset;
          if (tokenId) {
            currentPositionMap.set(tokenId, position);
          }
        }
        
        console.log(`[Monitor] Built position map with ${currentPositionMap.size} entries for ${eoaAddress.substring(0, 8)}...`);

        // Detect changes (new positions or position size changes)
        for (const [tokenId, currentPos] of currentPositionMap.entries()) {
          const previousPos = previousPositions.get(tokenId);

          if (!previousPos) {
            // New position detected - this indicates a BUY
            // FIXED: Use 'size' field from Polymarket API
            const currentSize = parseFloat(currentPos.size || '0');
            if (currentSize > 0) {
              console.log(`[Monitor] 🆕 New position detected for ${eoaAddress.substring(0, 8)}...: ${currentSize} tokens of ${tokenId.substring(0, 20)}...`);
              const trade = await this.parsePositionToTrade(eoaAddress, currentPos, tokenId, 'BUY', null);
              if (trade) {
                console.log(`\n🔔 [Monitor] TRADE DETECTED: New position`);
                console.log(`   Side: ${trade.side}`);
                console.log(`   Amount: ${trade.amount} shares`);
                console.log(`   Price: ${trade.price}`);
                console.log(`   Market: ${trade.marketId}`);
                console.log(`   Outcome: ${trade.outcome}`);
                console.log(`[Monitor] 📤 Calling onTradeDetected callback...`);
                try {
                  await onTradeDetected(trade);
                  console.log(`[Monitor] ✅ Callback completed successfully`);
                } catch (callbackError: any) {
                  console.error(`[Monitor] ❌ Callback failed:`, callbackError.message);
                  console.error(`[Monitor]    Stack:`, callbackError.stack);
                }
              } else {
                console.warn(`[Monitor] Failed to parse new position as trade for token ${tokenId}`);
              }
            }
          } else {
            // Check if position size changed significantly (indicating a trade)
            // FIXED: Use 'size' field from Polymarket API
            const currentSize = parseFloat(currentPos.size || '0');
            const previousSize = parseFloat(previousPos.size || '0');
            const sizeDiff = currentSize - previousSize; // Positive = BUY, Negative = SELL

            // If size changed by more than 1% or 0.01 tokens, consider it a trade
            const absDiff = Math.abs(sizeDiff);
            const percentChange = previousSize > 0 ? Math.abs(sizeDiff) / previousSize : 0;
            
            if (absDiff > 0.01 || percentChange > 0.01) {
              const side: 'BUY' | 'SELL' = sizeDiff > 0 ? 'BUY' : 'SELL';
              console.log(`[Monitor] 📊 Position change detected for ${eoaAddress.substring(0, 8)}...: ${side} ${absDiff.toFixed(4)} tokens (${(percentChange * 100).toFixed(2)}% change) of ${tokenId.substring(0, 20)}...`);
              const trade = await this.parsePositionToTrade(eoaAddress, currentPos, tokenId, side, previousPos);
              if (trade) {
                console.log(`\n🔔 [Monitor] TRADE DETECTED: Position change`);
                console.log(`   Side: ${trade.side}`);
                console.log(`   Amount: ${trade.amount} shares`);
                console.log(`   Price: ${trade.price}`);
                console.log(`   Market: ${trade.marketId}`);
                console.log(`   Outcome: ${trade.outcome}`);
                console.log(`   Size change: ${sizeDiff > 0 ? '+' : ''}${sizeDiff.toFixed(4)} (${(percentChange * 100).toFixed(2)}%)`);
                console.log(`[Monitor] 📤 Calling onTradeDetected callback...`);
                try {
                  await onTradeDetected(trade);
                  console.log(`[Monitor] ✅ Callback completed successfully`);
                } catch (callbackError: any) {
                  console.error(`[Monitor] ❌ Callback failed:`, callbackError.message);
                  console.error(`[Monitor]    Stack:`, callbackError.stack);
                }
              } else {
                console.warn(`[Monitor] Failed to parse position change as trade for token ${tokenId} (size diff: ${sizeDiff})`);
              }
            }
          }
        }
        
        // Also check for positions that were closed (existed before but not now)
        for (const [tokenId, previousPos] of previousPositions.entries()) {
          if (!currentPositionMap.has(tokenId)) {
            // Position was closed - this indicates a SELL
            // FIXED: Use 'size' field from Polymarket API
            const previousSize = parseFloat(previousPos.size || '0');
            if (previousSize > 0.01) {
              console.log(`[Monitor] 🔴 Position closed for ${eoaAddress.substring(0, 8)}...: ${previousSize} tokens of ${tokenId.substring(0, 20)}...`);
              // Create a synthetic position with zero size to represent the close
              const closedPosition = { ...previousPos, size: 0 };
              const trade = await this.parsePositionToTrade(eoaAddress, closedPosition, tokenId, 'SELL', previousPos);
              if (trade) {
                console.log(`\n🔔 [Monitor] TRADE DETECTED: Position closed`);
                console.log(`   Side: ${trade.side}`);
                console.log(`   Amount: ${trade.amount} shares`);
                console.log(`   Price: ${trade.price}`);
                console.log(`   Market: ${trade.marketId}`);
                console.log(`   Outcome: ${trade.outcome}`);
                console.log(`[Monitor] 📤 Calling onTradeDetected callback...`);
                try {
                  await onTradeDetected(trade);
                  console.log(`[Monitor] ✅ Callback completed successfully`);
                } catch (callbackError: any) {
                  console.error(`[Monitor] ❌ Callback failed:`, callbackError.message);
                  console.error(`[Monitor]    Stack:`, callbackError.stack);
                }
              }
            }
          }
        }

        // Also check for recent trades directly from trade history
        // This helps catch trades that might have been missed by position monitoring
        try {
          console.log(`[Monitor] Fetching trade history for ${eoaAddress.substring(0, 8)}...`);
          let recentTrades: any[] = [];
          try {
            recentTrades = await this.api.getUserTrades(eoaAddress, 50);
            console.log(`[Monitor] Found ${recentTrades.length} trade(s) in history for ${eoaAddress.substring(0, 8)}...`);
          } catch (tradesError: any) {
            console.warn(`[Monitor] Failed to fetch trade history:`, tradesError.message);
            recentTrades = [];
          }
          
          const now = Date.now();
          const fiveMinutesAgo = now - 5 * 60 * 1000; // Check last 5 minutes for recent trades
          
          let recentTradeCount = 0;
          for (const trade of recentTrades) {
            // FIXED: Use correct field name 'timestamp' from Polymarket API
            const tradeTimestamp = new Date(trade.timestamp);
            const tradeTime = tradeTimestamp.getTime();

            // Process trades from the last 5 minutes (more focused window)
            if (tradeTime > fiveMinutesAgo && tradeTime <= now) {
              recentTradeCount++;
              console.log(`[Monitor] Processing recent trade from ${new Date(tradeTime).toISOString()}:`, JSON.stringify(trade, null, 2).substring(0, 500));
              const detectedTrade = await this.parseTradeData(eoaAddress, trade);
              if (detectedTrade) {
                // Validate the detected trade before triggering
                const priceNum = parseFloat(detectedTrade.price || '0');
                const amountNum = parseFloat(detectedTrade.amount || '0');
                
                if (detectedTrade.marketId && detectedTrade.marketId !== 'unknown' &&
                    priceNum > 0 && priceNum <= 1 && amountNum > 0) {
                  console.log(`\n🔔 [Monitor] TRADE DETECTED: From trade history`);
                  console.log(`   Side: ${detectedTrade.side}`);
                  console.log(`   Amount: ${detectedTrade.amount} shares`);
                  console.log(`   Price: ${detectedTrade.price}`);
                  console.log(`   Market: ${detectedTrade.marketId}`);
                  console.log(`   Outcome: ${detectedTrade.outcome}`);
                  console.log(`   Time: ${new Date(tradeTime).toISOString()}`);
                  console.log(`[Monitor] 📤 Calling onTradeDetected callback...`);
                  try {
                    await onTradeDetected(detectedTrade);
                    console.log(`[Monitor] ✅ Callback completed successfully`);
                  } catch (callbackError: any) {
                    console.error(`[Monitor] ❌ Callback failed:`, callbackError.message);
                    console.error(`[Monitor]    Stack:`, callbackError.stack);
                  }
                } else {
                  console.warn(`[Monitor] ✗ Skipping invalid trade from history: marketId=${detectedTrade.marketId}, price=${detectedTrade.price}, amount=${detectedTrade.amount}`);
                }
              } else {
                console.warn(`[Monitor] ✗ Failed to parse trade data for ${eoaAddress.substring(0, 8)}...`);
              }
            }
          }
          console.log(`[Monitor] Processed ${recentTradeCount} recent trade(s) (within last 5 min) for ${eoaAddress.substring(0, 8)}...`);
        } catch (error: any) {
          // Trade history might not be available, continue with position monitoring
          if (error.response?.status !== 404) {
            console.warn(`[Monitor] ⚠️ Trade history not available for ${eoaAddress.substring(0, 8)}...:`, error.message);
          }
        }

        // Update stored positions using EOA address as key (consistent with initialization)
        this.monitoredPositions.set(eoaAddress, currentPositionMap);
        console.log(`[Monitor] ✓ Updated position map (${currentPositionMap.size} positions) for ${eoaAddress.substring(0, 8)}...`);
      } catch (error: any) {
        // Log error but continue monitoring other wallets
        const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
        console.error(`[Monitor] ✗ Error monitoring wallet ${wallet.address.substring(0, 8)}...:`, errorMsg);
        if (error.stack) {
          console.error(`[Monitor] Stack trace:`, error.stack);
        }
        // Don't throw - continue with other wallets
      }
    }
    
    console.log(`[Monitor] ✓ Completed trade check cycle for all wallets`);
  }

  /**
   * Parse a position change into a DetectedTrade
   * FIXED: Uses correct Polymarket API field names (asset, conditionId, size, avgPrice, outcome)
   */
  private async parsePositionToTrade(
    walletAddress: string,
    position: any,
    tokenId: string,
    side: 'BUY' | 'SELL',
    previousPosition: any | null
  ): Promise<DetectedTrade | null> {
    try {
      // FIXED: Use conditionId from position (this is the market ID in Polymarket)
      let marketId = position.conditionId;
      
      // If no conditionId, we can't proceed
      if (!marketId) {
        console.warn(`[Monitor] Cannot determine marketId from position (no conditionId), skipping trade`);
        return null;
      }
      
      // FIXED: Use 'outcome' field directly from Polymarket API
      // The API returns "Yes" or "No" as strings, we need to convert to uppercase
      let outcome: 'YES' | 'NO' = 'YES';
      if (position.outcome) {
        outcome = position.outcome.toUpperCase() === 'NO' ? 'NO' : 'YES';
      } else if (position.outcomeIndex !== undefined) {
        // outcomeIndex: 0 = Yes, 1 = No
        outcome = position.outcomeIndex === 1 ? 'NO' : 'YES';
      }

      // FIXED: Use 'size' field for amount
      // For SELL, use the absolute change in position size
      let amount: string;
      if (side === 'SELL' && previousPosition) {
        const currentSize = parseFloat(position.size || '0');
        const previousSize = parseFloat(previousPosition.size || '0');
        amount = Math.abs(currentSize - previousSize).toString();
      } else {
        amount = (position.size || '0').toString();
      }
      
      // FIXED: Use avgPrice or curPrice from Polymarket API
      let price = position.avgPrice || position.curPrice;
      
      // If price is missing, try to get from market API
      if (!price || parseFloat(price) <= 0 || parseFloat(price) > 1) {
        try {
          const orderBook = await this.api.getOrderBook(tokenId);
          if (orderBook?.bids?.[0] && orderBook?.asks?.[0]) {
            const bidPrice = parseFloat(orderBook.bids[0].price || '0');
            const askPrice = parseFloat(orderBook.asks[0].price || '0');
            if (bidPrice > 0 && askPrice > 0) {
              price = ((bidPrice + askPrice) / 2).toString();
            }
          }
        } catch (orderBookError: any) {
          console.warn(`[Monitor] Could not get order book price for ${tokenId}:`, orderBookError.message);
        }
      }
      
      // Validate price before proceeding
      const priceNum = parseFloat(price || '0');
      if (!price || isNaN(priceNum) || priceNum <= 0 || priceNum > 1) {
        console.warn(`[Monitor] Invalid or missing price (${price}) for trade on market ${marketId}, skipping`);
        return null;
      }
      
      // Validate amount
      const amountNum = parseFloat(amount || '0');
      if (!amount || isNaN(amountNum) || amountNum <= 0) {
        console.warn(`[Monitor] Invalid or missing amount (${amount}) for trade on market ${marketId}, skipping`);
        return null;
      }

      return {
        walletAddress: walletAddress.toLowerCase(),
        marketId,
        outcome,
        amount: amount.toString(),
        price: price.toString(),
        side,
        timestamp: new Date(),
        transactionHash: `pos-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        tokenId: tokenId,  // Pass the asset/token ID through for CLOB client
        negRisk: position.negativeRisk || false,  // Pass negative risk flag
      };
    } catch (error: any) {
      console.error('[Monitor] Failed to parse position to trade:', error);
      return null;
    }
  }

  /**
   * Parse trade data from API into DetectedTrade format
   * FIXED: Uses correct Polymarket Data API field names
   * 
   * Polymarket /trades API returns:
   * {
   *   "asset": "12345...",        // token ID
   *   "conditionId": "0xabc...",  // market ID (condition ID)
   *   "side": "BUY" or "SELL",    // trade side
   *   "size": 123,                // trade size
   *   "price": 0.65,              // trade price
   *   "timestamp": "2024-...",    // ISO timestamp
   *   "outcome": "Yes" or "No",   // outcome name
   *   "outcomeIndex": 0 or 1,     // 0=Yes, 1=No
   *   "title": "Market Title",
   *   "transactionHash": "0x..."  // optional tx hash
   * }
   */
  private async parseTradeData(
    walletAddress: string,
    trade: any
  ): Promise<DetectedTrade | null> {
    try {
      // FIXED: Use conditionId as the market ID (this is what Polymarket API returns)
      let marketId = trade.conditionId;
      
      // Fallback: try asset (token ID) as market ID if no conditionId
      if (!marketId && trade.asset) {
        marketId = trade.asset;
      }
      
      // If still no marketId, we can't proceed
      if (!marketId || marketId === 'unknown') {
        console.warn(`[Monitor] Cannot determine marketId from trade data (no conditionId or asset), skipping trade`);
        return null;
      }

      // FIXED: Determine outcome from 'outcome' or 'outcomeIndex' fields
      let outcome: 'YES' | 'NO' = 'YES';
      if (trade.outcome) {
        // outcome field contains "Yes" or "No" as strings
        outcome = trade.outcome.toUpperCase() === 'NO' ? 'NO' : 'YES';
      } else if (trade.outcomeIndex !== undefined) {
        // outcomeIndex: 0 = Yes, 1 = No
        outcome = trade.outcomeIndex === 1 ? 'NO' : 'YES';
      }

      // FIXED: Use 'side' field directly from Polymarket API
      let side: 'BUY' | 'SELL' = 'BUY';
      if (trade.side) {
        const tradeSide = trade.side.toUpperCase();
        side = (tradeSide === 'SELL' || tradeSide === 'S') ? 'SELL' : 'BUY';
      }

      // FIXED: Use 'price' and 'size' fields from Polymarket API
      let price = trade.price;
      let amount = trade.size;
      
      // Validate price
      const priceNum = parseFloat(price || '0');
      if (!price || isNaN(priceNum) || priceNum <= 0 || priceNum > 1) {
        console.warn(`[Monitor] Invalid or missing price (${price}) for trade on market ${marketId}, skipping`);
        return null;
      }
      
      // Validate amount
      const amountNum = parseFloat(amount || '0');
      if (!amount || isNaN(amountNum) || amountNum <= 0) {
        console.warn(`[Monitor] Invalid or missing amount (${amount}) for trade on market ${marketId}, skipping`);
        return null;
      }

      return {
        walletAddress: walletAddress.toLowerCase(),
        marketId,
        outcome,
        amount: amount.toString(),
        price: price.toString(),
        side,
        timestamp: new Date(trade.timestamp || Date.now()),
        transactionHash: trade.transactionHash || trade.id || `trade-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        tokenId: trade.asset,  // Token ID from trade data for CLOB client
        negRisk: false,  // Default, not available in trade history
      };
    } catch (error: any) {
      console.error('[Monitor] Failed to parse trade data:', error);
      return null;
    }
  }

  /**
   * Reload wallets and initialize positions for newly added wallets
   * This should be called when a wallet is added or removed
   */
  async reloadWallets(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }

    const wallets = await Storage.getActiveWallets();
    
    // Initialize positions for any new wallets that aren't in monitoredPositions
    for (const wallet of wallets) {
      const eoaAddress = wallet.address.toLowerCase();
      
      // Use EOA address directly - Polymarket Data API works with EOA
      // and returns proxyWallet in the response if one exists
      if (!this.monitoredPositions.has(eoaAddress)) {
        try {
          const positions = await this.api.getUserPositions(eoaAddress);
          const positionMap = new Map<string, any>();
          
          for (const position of positions) {
            // FIXED: Use 'asset' field which is the token ID in Polymarket API
            const tokenId = position.asset;
            if (tokenId) {
              positionMap.set(tokenId, position);
            }
          }
          
          this.monitoredPositions.set(eoaAddress, positionMap);
          console.log(`[Monitor] Initialized ${positionMap.size} positions for newly added wallet ${eoaAddress.substring(0, 8)}...`);
        } catch (error: any) {
          console.warn(`[Monitor] Failed to initialize positions for new wallet ${wallet.address}:`, error.message);
        }
      }
    }

    // Remove wallets that are no longer tracked
    const trackedAddresses = new Set(wallets.map(w => w.address.toLowerCase()));
    for (const [address] of this.monitoredPositions.entries()) {
      if (!trackedAddresses.has(address)) {
        this.monitoredPositions.delete(address);
        console.log(`[Monitor] Removed wallet ${address.substring(0, 8)}... from monitoring`);
      }
    }
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    this.isMonitoring = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    console.log('Stopped wallet monitoring');
  }

  /**
   * Get the Polymarket API instance
   */
  getApi(): PolymarketApi {
    return this.api;
  }
}
