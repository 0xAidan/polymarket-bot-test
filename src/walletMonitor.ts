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
  private provider: ethers.Provider | null = null;
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
      this.provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
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

    console.log(`Monitoring ${(await Storage.getActiveWallets()).length} wallets every ${config.monitoringIntervalMs}ms`);
  }

  /**
   * Initialize position tracking for all wallets
   */
  private async initializePositions(): Promise<void> {
    const wallets = await Storage.getActiveWallets();
    
    for (const wallet of wallets) {
      try {
        const positions = await this.api.getUserPositions(wallet.address);
        const positionMap = new Map<string, any>();
        
        for (const position of positions) {
          // Store position by token ID
          const tokenId = position.tokenId || position.token_id || position.market?.tokenId;
          if (tokenId) {
            positionMap.set(tokenId, position);
          }
        }
        
        this.monitoredPositions.set(wallet.address.toLowerCase(), positionMap);
        console.log(`Initialized ${positionMap.size} positions for ${wallet.address.substring(0, 8)}...`);
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

    for (const wallet of wallets) {
      try {
        const address = wallet.address.toLowerCase();
        const currentPositions = await this.api.getUserPositions(address);
        const previousPositions = this.monitoredPositions.get(address) || new Map();

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
              const trade = await this.parsePositionToTrade(wallet.address, currentPos, tokenId, 'BUY', null);
              if (trade) {
                onTradeDetected(trade);
              }
            }
          } else {
            // Check if position size changed significantly (indicating a trade)
            const currentSize = parseFloat(currentPos.quantity || currentPos.size || '0');
            const previousSize = parseFloat(previousPos.quantity || previousPos.size || '0');
            const sizeDiff = currentSize - previousSize; // Positive = BUY, Negative = SELL

            // If size changed by more than 1% or 0.01 tokens, consider it a trade
            if (Math.abs(sizeDiff) > 0.01 || (previousSize > 0 && Math.abs(sizeDiff) / previousSize > 0.01)) {
              const side: 'BUY' | 'SELL' = sizeDiff > 0 ? 'BUY' : 'SELL';
              const trade = await this.parsePositionToTrade(wallet.address, currentPos, tokenId, side, previousPos);
              if (trade) {
                onTradeDetected(trade);
              }
            }
          }
        }

        // Also check for recent trades directly from trade history
        try {
          const recentTrades = await this.api.getUserTrades(address, 10);
          for (const trade of recentTrades) {
            const tradeTimestamp = new Date(trade.timestamp || trade.createdAt || trade.time);
            const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

            // Only process very recent trades (within last 5 minutes)
            if (tradeTimestamp.getTime() > fiveMinutesAgo) {
              const detectedTrade = await this.parseTradeData(wallet.address, trade);
              if (detectedTrade) {
                onTradeDetected(detectedTrade);
              }
            }
          }
        } catch (error: any) {
          // Trade history might not be available, continue with position monitoring
          // Only log as warning if it's not a 404 (which is expected for wallets with no trades)
          if (error.response?.status !== 404) {
            console.warn(`Trade history not available for ${address.substring(0, 8)}...:`, error.message);
          }
        }

        // Update stored positions
        this.monitoredPositions.set(address, currentPositionMap);
      } catch (error: any) {
        // Log error but continue monitoring other wallets
        const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
        console.error(`Error monitoring wallet ${wallet.address.substring(0, 8)}...:`, errorMsg);
        // Don't throw - continue with other wallets
      }
    }
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
      const marketId = market.id || market.questionId || market.conditionId || tokenId;
      
      // Determine outcome (YES/NO) from token ID
      // Polymarket tokens typically have a suffix indicating outcome
      let outcome: 'YES' | 'NO' = 'YES';
      if (tokenId.toLowerCase().includes('no') || tokenId.endsWith('1')) {
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
      
      const price = position.avgPrice || position.price || market.currentPrice || '0';

      return {
        walletAddress: walletAddress.toLowerCase(),
        marketId,
        outcome,
        amount: amount.toString(),
        price: price.toString(),
        side,
        timestamp: new Date(),
        transactionHash: position.txHash || position.transactionHash || `pos-${Date.now()}`
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
      const marketId = market.id || market.questionId || market.conditionId || trade.tokenId;

      let outcome: 'YES' | 'NO' = 'YES';
      if (trade.outcome === 'NO' || trade.outcome === 1 || trade.side === 'NO') {
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

      return {
        walletAddress: walletAddress.toLowerCase(),
        marketId: marketId || 'unknown',
        outcome,
        amount: trade.size || trade.quantity || trade.amount || '0',
        price: trade.price || trade.avgPrice || '0',
        side,
        timestamp: new Date(trade.timestamp || trade.createdAt || trade.time || Date.now()),
        transactionHash: trade.txHash || trade.transactionHash || trade.id || `trade-${Date.now()}`
      };
    } catch (error: any) {
      console.error('Failed to parse trade data:', error);
      return null;
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
}
