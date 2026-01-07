import { PolymarketApi } from './polymarketApi.js';
import { TradeOrder, TradeResult } from './types.js';

/**
 * Executes trades on Polymarket via CLOB API
 */
export class TradeExecutor {
  private api: PolymarketApi;
  private isAuthenticated = false;

  constructor() {
    this.api = new PolymarketApi();
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
      console.log(`Executing trade: ${order.side} ${order.amount} shares of ${order.marketId} (${order.outcome}) at ${order.price}`);

      // Get market information to find token ID
      let tokenId: string;
      try {
        const market = await this.api.getMarket(order.marketId);
        
        // Extract token ID based on outcome
        // Polymarket tokens are typically structured as: marketId-outcomeIndex
        // YES is usually outcome 0, NO is outcome 1
        if (order.outcome === 'YES') {
          tokenId = market.tokens?.[0]?.tokenId || 
                   market.yesTokenId || 
                   `${order.marketId}-0` ||
                   order.marketId;
        } else {
          tokenId = market.tokens?.[1]?.tokenId || 
                   market.noTokenId || 
                   `${order.marketId}-1` ||
                   order.marketId;
        }
      } catch (error: any) {
        // If we can't get market info, try to construct token ID
        console.warn('Could not fetch market info, using fallback token ID:', error.message);
        tokenId = order.outcome === 'YES' ? `${order.marketId}-0` : `${order.marketId}-1`;
      }

      // Validate price and amount
      const price = parseFloat(order.price);
      const size = parseFloat(order.amount);

      if (isNaN(price) || price <= 0 || price > 1) {
        throw new Error(`Invalid price: ${order.price}. Price must be between 0 and 1`);
      }

      if (isNaN(size) || size <= 0) {
        throw new Error(`Invalid amount: ${order.amount}`);
      }

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
}
