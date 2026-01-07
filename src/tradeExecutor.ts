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

      // Use tokenId directly if provided (bypasses Gamma API entirely)
      // This is the critical fix - Gamma API doesn't accept conditionId format
      let tokenId: string | undefined = order.tokenId;
      let tickSize: string = '0.01';  // Default tick size for most Polymarket markets
      let negRisk: boolean = order.negRisk ?? false;

      if (!tokenId) {
        // Token ID is required - fail if not provided
        // Previously we tried to call Gamma API here, but it returns 422 errors
        // because marketId (conditionId) is not the format Gamma API expects
        throw new Error(`Token ID not provided for market ${order.marketId}. Cannot execute trade without tokenId. This may indicate the trade detection did not extract the asset field properly.`);
      }

      console.log(`   Token ID: ${tokenId}`);
      console.log(`   Tick Size: ${tickSize}`);
      console.log(`   Neg Risk: ${negRisk}`);
      console.log(`${'='.repeat(60)}`)

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
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'tradeExecutor.ts:executeTrade',message:'About to place order',data:{tokenId,tickSize,negRisk,side:order.side,size,price},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B'})}).catch(()=>{});
      // #endregion
      
      let orderResponse: any;
      try {
        orderResponse = await this.clobClient.createAndPostOrder({
          tokenID: tokenId,
          side: side,
          size: size,
          price: price,
          tickSize: tickSize,
          negRisk: negRisk,
        });
      } catch (clobError: any) {
        // CLOB client threw an error - this is expected for failures
        console.error(`[Execute] CLOB client threw error:`, clobError.message);
        throw clobError;
      }

      const executionTime = Date.now() - executionStart;

      // DEBUG: Log the exact response we got
      console.log(`[DEBUG] orderResponse type: ${typeof orderResponse}`);
      console.log(`[DEBUG] orderResponse: ${JSON.stringify(orderResponse)}`);

      // CRITICAL: Check for HTTP error status FIRST (handles both string and number)
      const responseStatus = orderResponse?.status;
      if (responseStatus !== undefined && responseStatus !== null) {
        const numericStatus = typeof responseStatus === 'string' ? parseInt(responseStatus, 10) : responseStatus;
        if (!isNaN(numericStatus) && numericStatus >= 400) {
          throw new Error(`Order rejected with HTTP status ${numericStatus}. This usually means Cloudflare blocked the request. Check Builder credentials.`);
        }
      }

      // Check for error field
      if (orderResponse?.error) {
        throw new Error(`Order placement failed: ${orderResponse.error}`);
      }

      // CRITICAL: Validate the response before declaring success
      const orderId = orderResponse?.orderID || orderResponse?.orderId || orderResponse?.id;
      
      // Strict validation - orderId must be a non-empty, non-"undefined" string
      const isValidOrderId = orderId !== undefined && 
                              orderId !== null && 
                              orderId !== '' && 
                              String(orderId) !== 'undefined' && 
                              String(orderId) !== 'null' &&
                              String(orderId).trim().length > 0;

      if (!isValidOrderId) {
        const errorDetails = JSON.stringify(orderResponse || 'empty response');
        console.error(`[DEBUG] VALIDATION FAILED: orderId="${orderId}", type=${typeof orderId}, isValid=${isValidOrderId}`);
        throw new Error(`Order placement failed: No valid order ID returned. orderId="${orderId}". Response: ${errorDetails}`);
      }

      // If we get here, the order was actually placed successfully
      console.log(`\n✅ [Execute] ORDER PLACED SUCCESSFULLY!`);
      console.log(`${'='.repeat(60)}`);
      console.log(`   Order ID: ${orderId}`);
      console.log(`   Status: ${responseStatus || 'accepted'}`);
      console.log(`   Execution Time: ${executionTime}ms`);
      console.log(`${'='.repeat(60)}\n`);

      return {
        success: true,
        orderId: String(orderId),
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
