import { PolymarketApi } from './polymarketApi.js';
import { PolymarketClobClient } from './clobClient.js';
import { TradeOrder, TradeResult } from './types.js';
import { Side } from '@polymarket/clob-client';

/**
 * Executes trades on Polymarket via CLOB API using the official CLOB client
 */
export class TradeExecutor {
  private api: PolymarketApi;
  private clobClient: PolymarketClobClient;
  private isAuthenticated = false;

  constructor() {
    this.api = new PolymarketApi();
    this.clobClient = new PolymarketClobClient();
  }

  /**
   * Authenticate with Polymarket API
   */
  async authenticate(): Promise<void> {
    try {
      await this.api.initialize();
      await this.clobClient.initialize();
      this.isAuthenticated = true;
      console.log('✓ Trade executor authenticated');
    } catch (error: any) {
      console.error('❌ Authentication failed:', error.message);
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
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🚀 [Execute] EXECUTING TRADE`);
      console.log(`${'='.repeat(60)}`);
      console.log(`   Side: ${order.side}`);
      console.log(`   Amount: ${order.amount} shares`);
      console.log(`   Market: ${order.marketId}`);
      console.log(`   Outcome: ${order.outcome}`);
      console.log(`   Price: ${order.price}`);
      console.log(`   Timestamp: ${new Date().toISOString()}`);

      // Get market information to find token ID
      let tokenId: string;
      let tickSize: string | undefined;
      let negRisk: boolean | undefined;

      try {
        const market = await this.api.getMarket(order.marketId);
        
        // Extract token ID from clobTokenIds array
        // clobTokenIds is an array where [0] is YES and [1] is NO
        const clobTokenIds = market.clobTokenIds || [];
        
        if (order.outcome === 'YES') {
          tokenId = clobTokenIds[0] || market.tokens?.[0]?.tokenId || market.yesTokenId;
        } else {
          tokenId = clobTokenIds[1] || market.tokens?.[1]?.tokenId || market.noTokenId;
        }

        // Get tickSize and negRisk from market
        tickSize = market.tickSize;
        negRisk = market.negRisk;

        if (!tokenId) {
          throw new Error(`Could not determine token ID for ${order.outcome} outcome`);
        }

      console.log(`   Token ID: ${tokenId}`);
      console.log(`   Tick Size: ${tickSize || 'default'}`);
      console.log(`   Neg Risk: ${negRisk || false}`);
      console.log(`${'='.repeat(60)}`);
      } catch (error: any) {
        console.error(`❌ Failed to get market info: ${error.message}`);
        throw new Error(`Could not fetch market information: ${error.message}`);
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

      // Convert side to CLOB client Side enum
      const side = order.side === 'BUY' ? Side.BUY : Side.SELL;

      // Place order via CLOB client
      console.log(`\n📤 Placing order via CLOB client...`);
      const orderResponse = await this.clobClient.createAndPostOrder({
        tokenID: tokenId,
        side: side,
        size: size,
        price: price,
        tickSize: tickSize,
        negRisk: negRisk,
      });

      const executionTime = Date.now() - executionStart;

      console.log(`\n✅ [Execute] ORDER PLACED SUCCESSFULLY!`);
      console.log(`${'='.repeat(60)}`);
      console.log(`   Order ID: ${orderResponse.orderID || orderResponse.orderId}`);
      console.log(`   Status: ${orderResponse.status || 'pending'}`);
      console.log(`   Execution Time: ${executionTime}ms`);
      console.log(`${'='.repeat(60)}\n`);

      return {
        success: true,
        orderId: orderResponse.orderID || orderResponse.orderId || orderResponse.clobOrderId,
        transactionHash: orderResponse.txHash || orderResponse.transactionHash || orderResponse.hash || null,
        executionTimeMs: executionTime
      };

    } catch (error: any) {
      const executionTime = Date.now() - executionStart;
      console.error(`\n${'='.repeat(60)}`);
      console.error('❌ [Execute] TRADE EXECUTION FAILED!');
      console.error(`${'='.repeat(60)}`);
      console.error(`Error message: ${error.message}`);
      console.error(`Error stack:`, error.stack);
      
      // Log additional error details if available
      if (error.response) {
        console.error(`HTTP Status: ${error.response.status}`);
        console.error(`Response data:`, JSON.stringify(error.response.data, null, 2));
      }
      if (error.originalError) {
        console.error(`Original error:`, error.originalError.message);
      }
      
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
    return this.clobClient.getWalletAddress();
  }
}
