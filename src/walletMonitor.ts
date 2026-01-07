import { ethers } from 'ethers';
import { config } from './config.js';
import { Storage } from './storage.js';
import { PolymarketApi } from './polymarketApi.js';
import { DetectedTrade } from './types.js';

/**
 * Monitors wallet addresses for Polymarket trades
 * Uses Polymarket Data API to detect trades and positions
 */
export class WalletMonitor {
  private provider: ethers.providers.Provider | null = null;
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
      this.provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
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

    // Get initial positions for all tracked wallets
    await this.initializePositions();

    // Start polling for position changes
    this.pollingInterval = setInterval(async () => {
      if (!this.isMonitoring) return;
      await this.checkWalletsForTrades(onTradeDetected);
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
    
    for (const wallet of wallets) {
      try {
        const eoaAddress = wallet.address.toLowerCase();
        
        // Get proxy wallet address (Polymarket uses proxy wallets for trading)
        let monitoringAddress = eoaAddress;
        try {
          const proxyAddress = await this.api.getProxyWalletAddress(eoaAddress);
          if (proxyAddress) {
            monitoringAddress = proxyAddress.toLowerCase();
            console.log(`Initializing positions for proxy wallet ${monitoringAddress.substring(0, 8)}... (EOA: ${eoaAddress.substring(0, 8)}...)`);
          }
        } catch (proxyError: any) {
          console.warn(`Failed to get proxy wallet for ${eoaAddress.substring(0, 8)}..., using EOA directly:`, proxyError.message);
        }
        
        const positions = await this.api.getUserPositions(monitoringAddress);
        const positionMap = new Map<string, any>();
        
        for (const position of positions) {
          // Store position by token ID
          const tokenId = position.tokenId || position.token_id || position.market?.tokenId;
          if (tokenId) {
            positionMap.set(tokenId, position);
          }
        }
        
        // Use monitoringAddress as key since that's where positions are tracked
        this.monitoredPositions.set(monitoringAddress, positionMap);
        console.log(`Initialized ${positionMap.size} positions for ${eoaAddress.substring(0, 8)}... (monitored via ${monitoringAddress.substring(0, 8)}...)`);
      } catch (error: any) {
        console.warn(`Failed to initialize positions for ${wallet.address}:`, error.message);
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
    
    if (wallets.length === 0) {
      // No wallets to monitor, skip this check
      return;
    }

    console.log(`[Monitor] Checking ${wallets.length} wallet(s) for trades...`);

    for (const wallet of wallets) {
      try {
        const eoaAddress = wallet.address.toLowerCase();
        console.log(`[Monitor] Checking wallet ${eoaAddress.substring(0, 8)}... for positions and trades`);
        
        // Get proxy wallet address (Polymarket uses proxy wallets for trading)
        // Positions and trades are associated with the proxy wallet, not the EOA
        let monitoringAddress = eoaAddress;
        let proxyAddress: string | null = null;
        try {
          proxyAddress = await this.api.getProxyWalletAddress(eoaAddress);
          if (proxyAddress) {
            monitoringAddress = proxyAddress.toLowerCase();
            console.log(`[Monitor] Using proxy wallet ${monitoringAddress.substring(0, 8)}... for monitoring (EOA: ${eoaAddress.substring(0, 8)}...)`);
          } else {
            console.log(`[Monitor] No proxy wallet found via API, will try EOA ${eoaAddress.substring(0, 8)}... directly`);
          }
        } catch (proxyError: any) {
          console.warn(`[Monitor] Failed to get proxy wallet for ${eoaAddress.substring(0, 8)}..., will try EOA directly:`, proxyError.message);
          proxyAddress = null; // Ensure it's null if lookup failed
        }
        
        // Try to get positions - if proxy wallet was found, use it; otherwise try EOA
        let currentPositions: any[] = [];
        let positionsError: any = null;
        
        try {
          currentPositions = await this.api.getUserPositions(monitoringAddress);
          console.log(`[Monitor] Found ${currentPositions.length} current position(s) for ${monitoringAddress.substring(0, 8)}...`);
        } catch (error: any) {
          positionsError = error;
          console.warn(`[Monitor] Failed to get positions for ${monitoringAddress.substring(0, 8)}...:`, error.message);
          
          // If we tried proxy wallet and it failed, try EOA as fallback
          if (proxyAddress && monitoringAddress === proxyAddress.toLowerCase()) {
            console.log(`[Monitor] Trying EOA ${eoaAddress.substring(0, 8)}... as fallback...`);
            try {
              currentPositions = await this.api.getUserPositions(eoaAddress);
              monitoringAddress = eoaAddress; // Switch to EOA if it works
              console.log(`[Monitor] Found ${currentPositions.length} position(s) using EOA ${eoaAddress.substring(0, 8)}...`);
            } catch (eoaError: any) {
              console.error(`[Monitor] Both proxy wallet and EOA failed for ${eoaAddress.substring(0, 8)}...`);
              throw eoaError;
            }
          } else {
            throw error;
          }
        }
        
        // Use monitoringAddress as the key for tracking positions
        const previousPositions = this.monitoredPositions.get(monitoringAddress) || new Map();
        console.log(`[Monitor] Tracking ${previousPositions.size} previous position(s) for ${monitoringAddress.substring(0, 8)}...`);

        // Create map of current positions
        const currentPositionMap = new Map<string, any>();
        for (const position of currentPositions) {
          const tokenId = position.tokenId || position.token_id || position.market?.tokenId;
          if (tokenId) {
            currentPositionMap.set(tokenId, position);
          }
        }

        // Detect changes (new positions or position size changes)
        for (const [tokenId, currentPos] of currentPositionMap.entries()) {
          const previousPos = previousPositions.get(tokenId);

          if (!previousPos) {
            // New position detected - this indicates a BUY
            const currentSize = parseFloat(currentPos.quantity || currentPos.size || '0');
            if (currentSize > 0) {
              console.log(`[Monitor] New position detected for ${eoaAddress.substring(0, 8)}... (proxy: ${monitoringAddress.substring(0, 8)}...): ${currentSize} tokens of ${tokenId.substring(0, 20)}...`);
              const trade = await this.parsePositionToTrade(eoaAddress, currentPos, tokenId, 'BUY', null);
              if (trade) {
                console.log(`\n🔔 [Monitor] TRADE DETECTED: New position`);
                console.log(`   Side: ${trade.side}`);
                console.log(`   Amount: ${trade.amount} shares`);
                console.log(`   Price: ${trade.price}`);
                console.log(`   Market: ${trade.marketId}`);
                console.log(`   Outcome: ${trade.outcome}`);
                onTradeDetected(trade);
              } else {
                console.warn(`[Monitor] Failed to parse new position as trade for token ${tokenId}`);
              }
            }
          } else {
            // Check if position size changed significantly (indicating a trade)
            const currentSize = parseFloat(currentPos.quantity || currentPos.size || '0');
            const previousSize = parseFloat(previousPos.quantity || previousPos.size || '0');
            const sizeDiff = currentSize - previousSize; // Positive = BUY, Negative = SELL

            // If size changed by more than 1% or 0.01 tokens, consider it a trade
            const absDiff = Math.abs(sizeDiff);
            const percentChange = previousSize > 0 ? Math.abs(sizeDiff) / previousSize : 0;
            
            if (absDiff > 0.01 || percentChange > 0.01) {
              const side: 'BUY' | 'SELL' = sizeDiff > 0 ? 'BUY' : 'SELL';
              console.log(`[Monitor] Position change detected for ${eoaAddress.substring(0, 8)}... (proxy: ${monitoringAddress.substring(0, 8)}...): ${side} ${absDiff.toFixed(4)} tokens (${(percentChange * 100).toFixed(2)}% change) of ${tokenId.substring(0, 20)}...`);
              const trade = await this.parsePositionToTrade(eoaAddress, currentPos, tokenId, side, previousPos);
              if (trade) {
                console.log(`\n🔔 [Monitor] TRADE DETECTED: Position change`);
                console.log(`   Side: ${trade.side}`);
                console.log(`   Amount: ${trade.amount} shares`);
                console.log(`   Price: ${trade.price}`);
                console.log(`   Market: ${trade.marketId}`);
                console.log(`   Outcome: ${trade.outcome}`);
                console.log(`   Size change: ${sizeDiff > 0 ? '+' : ''}${sizeDiff.toFixed(4)} (${(percentChange * 100).toFixed(2)}%)`);
                onTradeDetected(trade);
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
            const previousSize = parseFloat(previousPos.quantity || previousPos.size || '0');
            if (previousSize > 0.01) {
              console.log(`[Monitor] Position closed for ${eoaAddress.substring(0, 8)}... (proxy: ${monitoringAddress.substring(0, 8)}...): ${previousSize} tokens of ${tokenId.substring(0, 20)}...`);
              // Create a synthetic position with zero size to represent the close
              const closedPosition = { ...previousPos, quantity: '0', size: '0' };
              const trade = await this.parsePositionToTrade(eoaAddress, closedPosition, tokenId, 'SELL', previousPos);
              if (trade) {
                console.log(`\n🔔 [Monitor] TRADE DETECTED: Position closed`);
                console.log(`   Side: ${trade.side}`);
                console.log(`   Amount: ${trade.amount} shares`);
                console.log(`   Price: ${trade.price}`);
                console.log(`   Market: ${trade.marketId}`);
                console.log(`   Outcome: ${trade.outcome}`);
                onTradeDetected(trade);
              }
            }
          }
        }

        // Also check for recent trades directly from trade history
        // This helps catch trades that might have been missed by position monitoring
        try {
          console.log(`[Monitor] Fetching trade history for ${monitoringAddress.substring(0, 8)}... (EOA: ${eoaAddress.substring(0, 8)}...)`);
          let recentTrades: any[] = [];
          try {
            recentTrades = await this.api.getUserTrades(monitoringAddress, 50); // Get more trades
            console.log(`[Monitor] Found ${recentTrades.length} trade(s) in history for ${monitoringAddress.substring(0, 8)}...`);
          } catch (tradesError: any) {
            // If proxy wallet failed, try EOA as fallback
            if (proxyAddress && monitoringAddress === proxyAddress.toLowerCase()) {
              console.log(`[Monitor] Trade history failed for proxy wallet, trying EOA ${eoaAddress.substring(0, 8)}... as fallback...`);
              try {
                recentTrades = await this.api.getUserTrades(eoaAddress, 50);
                console.log(`[Monitor] Found ${recentTrades.length} trade(s) using EOA ${eoaAddress.substring(0, 8)}...`);
              } catch (eoaTradesError: any) {
                console.warn(`[Monitor] Both proxy wallet and EOA failed for trade history:`, eoaTradesError.message);
                recentTrades = [];
              }
            } else {
              console.warn(`[Monitor] Failed to fetch trade history:`, tradesError.message);
              recentTrades = [];
            }
          }
          
          const now = Date.now();
          const oneHourAgo = now - 60 * 60 * 1000; // Check last hour instead of 5 minutes
          
          let recentTradeCount = 0;
          for (const trade of recentTrades) {
            const tradeTimestamp = new Date(trade.timestamp || trade.createdAt || trade.time);
            const tradeTime = tradeTimestamp.getTime();

            // Process trades from the last hour (more lenient window)
            if (tradeTime > oneHourAgo && tradeTime <= now) {
              recentTradeCount++;
              console.log(`[Monitor] Processing recent trade from ${new Date(tradeTime).toISOString()}:`, JSON.stringify(trade, null, 2));
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
                  onTradeDetected(detectedTrade);
                } else {
                  console.warn(`[Monitor] ✗ Skipping invalid trade from history: marketId=${detectedTrade.marketId}, price=${detectedTrade.price}, amount=${detectedTrade.amount}`);
                }
              } else {
                console.warn(`[Monitor] ✗ Failed to parse trade data for ${eoaAddress.substring(0, 8)}...`);
              }
            }
          }
          console.log(`[Monitor] Processed ${recentTradeCount} recent trade(s) (within last hour) for ${monitoringAddress.substring(0, 8)}...`);
        } catch (error: any) {
          // Trade history might not be available, continue with position monitoring
          // Only log as warning if it's not a 404 (which is expected for wallets with no trades)
          if (error.response?.status !== 404) {
            console.warn(`[Monitor] ⚠️ Trade history not available for ${monitoringAddress.substring(0, 8)}...:`, error.message);
            if (error.response) {
              console.warn(`[Monitor] Response status: ${error.response.status}, data:`, JSON.stringify(error.response.data, null, 2));
            }
          } else {
            console.log(`[Monitor] No trade history found for ${monitoringAddress.substring(0, 8)}... (404 - expected if wallet has no trades)`);
          }
        }

        // Update stored positions (use monitoringAddress as key since that's where positions are tracked)
        this.monitoredPositions.set(monitoringAddress, currentPositionMap);
        console.log(`[Monitor] ✓ Completed check for ${eoaAddress.substring(0, 8)}... (monitored via ${monitoringAddress.substring(0, 8)}...)`);
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
   */
  private async parsePositionToTrade(
    walletAddress: string,
    position: any,
    tokenId: string,
    side: 'BUY' | 'SELL',
    previousPosition: any | null
  ): Promise<DetectedTrade | null> {
    try {
      // Extract market information from position
      const market = position.market || position.condition || {};
      let marketId = market.id || market.questionId || market.conditionId;
      
      // If we don't have a marketId, try to extract it from tokenId
      // Polymarket token IDs are often in format: conditionId-outcomeIndex
      if (!marketId && tokenId) {
        const parts = tokenId.split('-');
        if (parts.length >= 2) {
          marketId = parts.slice(0, -1).join('-'); // Everything except last part
        } else {
          marketId = tokenId;
        }
      }
      
      // If still no marketId, we can't proceed
      if (!marketId || marketId === 'unknown') {
        console.warn(`Cannot determine marketId from position for token ${tokenId}, skipping trade`);
        return null;
      }
      
      // Determine outcome (YES/NO) from token ID
      // Polymarket tokens typically have a suffix indicating outcome
      let outcome: 'YES' | 'NO' = 'YES';
      if (tokenId.toLowerCase().includes('no') || tokenId.endsWith('1') || tokenId.endsWith('-1')) {
        outcome = 'NO';
      }

      // Get price and amount
      // For SELL, use the absolute change in position size
      let amount = position.quantity || position.size || '0';
      if (side === 'SELL' && previousPosition) {
        const currentSize = parseFloat(position.quantity || position.size || '0');
        const previousSize = parseFloat(previousPosition.quantity || previousPosition.size || '0');
        amount = Math.abs(currentSize - previousSize).toString();
      }
      
      // Try multiple sources for price
      let price = position.avgPrice || position.price || market.currentPrice || market.price;
      
      // If price is still missing or invalid, try to get it from the market API
      if (!price || price === '0' || parseFloat(price) <= 0 || parseFloat(price) > 1) {
        try {
          const marketInfo = await this.api.getMarket(marketId);
          price = marketInfo.currentPrice || marketInfo.price || marketInfo.lastPrice;
          
          // If still no price, try to get from order book
          if (!price || price === '0') {
            try {
              // Try to get price from order book (mid price)
              const orderBook = await this.api.getOrderBook(tokenId);
              if (orderBook?.bids?.[0] && orderBook?.asks?.[0]) {
                const bidPrice = parseFloat(orderBook.bids[0].price || '0');
                const askPrice = parseFloat(orderBook.asks[0].price || '0');
                if (bidPrice > 0 && askPrice > 0) {
                  price = ((bidPrice + askPrice) / 2).toString();
                }
              }
            } catch (orderBookError: any) {
              console.warn(`Could not get order book price for ${tokenId}:`, orderBookError.message);
            }
          }
        } catch (marketError: any) {
          console.warn(`Could not fetch market price for ${marketId}:`, marketError.message);
        }
      }
      
      // Validate price before proceeding
      const priceNum = parseFloat(price || '0');
      if (!price || price === '0' || isNaN(priceNum) || priceNum <= 0 || priceNum > 1) {
        console.warn(`Invalid or missing price (${price}) for trade on market ${marketId}, skipping`);
        return null;
      }
      
      // Validate amount
      const amountNum = parseFloat(amount || '0');
      if (!amount || amount === '0' || isNaN(amountNum) || amountNum <= 0) {
        console.warn(`Invalid or missing amount (${amount}) for trade on market ${marketId}, skipping`);
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
        transactionHash: position.txHash || position.transactionHash || `pos-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      };
    } catch (error: any) {
      console.error('Failed to parse position to trade:', error);
      return null;
    }
  }

  /**
   * Parse trade data from API into DetectedTrade format
   */
  private async parseTradeData(
    walletAddress: string,
    trade: any
  ): Promise<DetectedTrade | null> {
    try {
      const market = trade.market || trade.condition || {};
      let marketId = market.id || market.questionId || market.conditionId;
      
      // Try to extract marketId from tokenId if not available
      if (!marketId && trade.tokenId) {
        const parts = trade.tokenId.split('-');
        if (parts.length >= 2) {
          marketId = parts.slice(0, -1).join('-');
        } else {
          marketId = trade.tokenId;
        }
      }
      
      // If still no marketId, we can't proceed
      if (!marketId || marketId === 'unknown') {
        console.warn(`Cannot determine marketId from trade data, skipping trade`);
        return null;
      }

      let outcome: 'YES' | 'NO' = 'YES';
      if (trade.outcome === 'NO' || trade.outcome === 1 || trade.side === 'NO' || 
          (trade.tokenId && (trade.tokenId.toLowerCase().includes('no') || trade.tokenId.endsWith('1') || trade.tokenId.endsWith('-1')))) {
        outcome = 'NO';
      }

      // Determine side from trade data
      // Check if API provides side directly, or infer from trade type
      let side: 'BUY' | 'SELL' = 'BUY';
      if (trade.side) {
        // API might provide 'buy'/'sell' or 'BUY'/'SELL'
        const tradeSide = trade.side.toUpperCase();
        side = (tradeSide === 'SELL' || tradeSide === 'S') ? 'SELL' : 'BUY';
      } else if (trade.type) {
        // Some APIs use 'type' field
        const tradeType = trade.type.toUpperCase();
        side = (tradeType === 'SELL' || tradeType === 'S') ? 'SELL' : 'BUY';
      } else if (trade.action) {
        // Some APIs use 'action' field
        const action = trade.action.toUpperCase();
        side = (action === 'SELL' || action === 'S') ? 'SELL' : 'BUY';
      }
      // Default to BUY if we can't determine

      // Get price and amount
      let price = trade.price || trade.avgPrice || trade.fillPrice || market.currentPrice || '0';
      let amount = trade.size || trade.quantity || trade.amount || '0';
      
      // Validate price and amount
      const priceNum = parseFloat(price || '0');
      const amountNum = parseFloat(amount || '0');
      
      if (!price || price === '0' || isNaN(priceNum) || priceNum <= 0 || priceNum > 1) {
        console.warn(`Invalid or missing price (${price}) for trade on market ${marketId}, skipping`);
        return null;
      }
      
      if (!amount || amount === '0' || isNaN(amountNum) || amountNum <= 0) {
        console.warn(`Invalid or missing amount (${amount}) for trade on market ${marketId}, skipping`);
        return null;
      }

      return {
        walletAddress: walletAddress.toLowerCase(),
        marketId,
        outcome,
        amount: amount.toString(),
        price: price.toString(),
        side,
        timestamp: new Date(trade.timestamp || trade.createdAt || trade.time || Date.now()),
        transactionHash: trade.txHash || trade.transactionHash || trade.id || `trade-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      };
    } catch (error: any) {
      console.error('Failed to parse trade data:', error);
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
      
      // Get proxy wallet address for monitoring
      let monitoringAddress = eoaAddress;
      try {
        const proxyAddress = await this.api.getProxyWalletAddress(eoaAddress);
        if (proxyAddress) {
          monitoringAddress = proxyAddress.toLowerCase();
        }
      } catch (proxyError: any) {
        // Use EOA if proxy lookup fails
      }
      
      if (!this.monitoredPositions.has(monitoringAddress)) {
        try {
          const positions = await this.api.getUserPositions(monitoringAddress);
          const positionMap = new Map<string, any>();
          
          for (const position of positions) {
            const tokenId = position.tokenId || position.token_id || position.market?.tokenId;
            if (tokenId) {
              positionMap.set(tokenId, position);
            }
          }
          
          this.monitoredPositions.set(monitoringAddress, positionMap);
          console.log(`Initialized ${positionMap.size} positions for newly added wallet ${eoaAddress.substring(0, 8)}... (monitored via ${monitoringAddress.substring(0, 8)}...)`);
        } catch (error: any) {
          console.warn(`Failed to initialize positions for new wallet ${wallet.address}:`, error.message);
        }
      }
    }

    // Remove wallets that are no longer tracked
    const trackedAddresses = new Set(wallets.map(w => w.address.toLowerCase()));
    for (const [address] of this.monitoredPositions.entries()) {
      if (!trackedAddresses.has(address)) {
        this.monitoredPositions.delete(address);
        console.log(`Removed wallet ${address.substring(0, 8)}... from monitoring`);
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
