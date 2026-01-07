import { PolymarketApi } from './polymarketApi.js';
import { TradeOrder, TradeResult } from './types.js';
import { BalanceTracker } from './balanceTracker.js';
import { Storage } from './storage.js';

/**
 * Executes trades on Polymarket via CLOB API
 */
export class TradeExecutor {
  private api: PolymarketApi;
  private balanceTracker: BalanceTracker;
  private isAuthenticated = false;

  constructor(balanceTracker: BalanceTracker) {
    this.api = new PolymarketApi();
    this.balanceTracker = balanceTracker;
  }

  /**
   * Authenticate with Polymarket API
   */
  async authenticate(): Promise<void> {
    try {
      await this.api.initialize();
      this.isAuthenticated = true;
      console.log('Trade executor authenticated');
    } catch (error: any) {
      console.error('Authentication failed:', error.message);
      throw error;
    }
  }

  /**
   * Execute a trade order on Polymarket
   * 
   * @param order Trade order to execute
   * @returns Result of the trade execution
   */
  async executeTrade(order: TradeOrder): Promise<TradeResult> {
    if (!this.isAuthenticated) {
      await this.authenticate();
    }

    const executionStart = Date.now();

    try {
      // Get configured trade size
      const config = await Storage.loadConfig();
      const tradeSizeUsd = config.tradeSizeUsd || 20; // Default $20

      // Get market information to find token ID and validate market
      let tokenId: string;
      let market: any;
      try {
        market = await this.api.getMarket(order.marketId);
        
        // Validate market exists
        if (!market || !market.id) {
          throw new Error(`Market ${order.marketId} not found`);
        }
        
        // Validate market is tradeable
        if (market.closed || market.resolved || market.paused || market.archived) {
          throw new Error(`Market ${order.marketId} is not tradeable (closed/resolved/paused/archived)`);
        }
        
        // Validate market has outcomes
        if (!market.outcomes || market.outcomes.length < 2) {
          throw new Error(`Market ${order.marketId} does not have valid outcomes`);
        }
        
        // Extract token ID based on outcome
        // Polymarket tokens are typically structured as: marketId-outcomeIndex
        // YES is usually outcome 0, NO is outcome 1
        if (order.outcome === 'YES') {
          tokenId = market.tokens?.[0]?.tokenId || 
                   market.yesTokenId || 
                   market.outcomes?.[0]?.tokenId ||
                   `${order.marketId}-0` ||
                   order.marketId;
        } else {
          tokenId = market.tokens?.[1]?.tokenId || 
                   market.noTokenId || 
                   market.outcomes?.[1]?.tokenId ||
                   `${order.marketId}-1` ||
                   order.marketId;
        }
      } catch (error: any) {
        // If we can't get market info, try to construct token ID
        console.warn('Could not fetch market info, using fallback token ID:', error.message);
        tokenId = order.outcome === 'YES' ? `${order.marketId}-0` : `${order.marketId}-1`;
      }

      // Validate price
      const price = parseFloat(order.price);
      if (isNaN(price) || price <= 0 || price > 1) {
        throw new Error(`Invalid price: ${order.price}. Price must be between 0 and 1`);
      }

      // Calculate trade size based on configured USD amount
      // For BUY: amount = tradeSizeUsd / price
      // For SELL: we need to check available position, but for now use same calculation
      const size = order.side === 'BUY' 
        ? (tradeSizeUsd / price).toFixed(6) 
        : (tradeSizeUsd / price).toFixed(6);

      const sizeNum = parseFloat(size);
      if (isNaN(sizeNum) || sizeNum <= 0) {
        throw new Error(`Invalid calculated amount: ${size}`);
      }

      // Check balance before executing trade
      const walletAddress = this.getWalletAddress();
      if (!walletAddress) {
        throw new Error('Wallet address not available');
      }

      const balance = await this.balanceTracker.getBalance(walletAddress);
      const requiredAmount = tradeSizeUsd; // For BUY, we need USDC equal to trade size
      
      if (balance < requiredAmount) {
        throw new Error(`Insufficient balance: Have $${balance.toFixed(2)} USDC, need $${requiredAmount.toFixed(2)} USDC`);
      }

      console.log(`Executing trade: ${order.side} ${size} shares of ${order.marketId} (${order.outcome}) at ${order.price} ($${tradeSizeUsd} position)`);

      // Place order via CLOB API
      const orderResponse = await this.api.placeOrder({
        tokenId,
        side: order.side,
        size: size.toString(),
        price: price.toString()
      });

      const executionTime = Date.now() - executionStart;

      return {
        success: true,
        orderId: orderResponse.orderId || orderResponse.id || orderResponse.clobOrderId,
        transactionHash: orderResponse.txHash || orderResponse.transactionHash || orderResponse.hash,
        executionTimeMs: executionTime
      };

    } catch (error: any) {
      const executionTime = Date.now() - executionStart;
      console.error('Trade execution failed:', error.message);
      
      return {
        success: false,
        error: error.message || 'Unknown error',
        executionTimeMs: executionTime
      };
    }
  }

  /**
   * Get market information
   */
  async getMarketInfo(marketId: string): Promise<any> {
    try {
      return await this.api.getMarket(marketId);
    } catch (error: any) {
      console.error('Failed to get market info:', error.message);
      throw error;
    }
  }

  /**
   * Get the wallet address used for executing trades
   */
  getWalletAddress(): string | null {
    return this.api.getWalletAddress();
  }
}
