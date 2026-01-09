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
      let price = parseFloat(order.price);
      let size = parseFloat(order.amount);

      if (isNaN(price) || price <= 0 || price > 1) {
        throw new Error(`Invalid price: ${order.price}. Price must be between 0 and 1`);
      }

      if (isNaN(size) || size <= 0) {
        throw new Error(`Invalid amount: ${order.amount}`);
      }
      
      // CRITICAL FIX: Round price to tick size alignment
      // Polymarket CLOB API requires prices to be exact multiples of tick size
      // e.g., with tickSize=0.01, price must be 0.74, 0.75, NOT 0.7421
      const tickSizeNum = parseFloat(tickSize);
      const rawPrice = price;
      price = Math.round(price / tickSizeNum) * tickSizeNum;
      // Fix floating point precision issues (e.g., 0.7000000001 -> 0.7)
      price = parseFloat(price.toFixed(2));
      
      // POLYMARKET PRICE LIMITS: Must be between 0.01 and 0.99
      const MIN_PRICE = 0.01;
      const MAX_PRICE = 0.99;
      
      if (price < MIN_PRICE) {
        console.log(`[Execute] ⚠️ Price ${rawPrice} rounds to ${price}, below minimum ${MIN_PRICE}`);
        // Return failure instead of throwing - allows caller to handle gracefully
        return {
          success: false,
          error: `Price too low: ${rawPrice} rounds to ${price}. Polymarket requires price >= ${MIN_PRICE}. This is a "long shot" bet that cannot be copied.`,
          executionTimeMs: Date.now() - executionStart
        };
      }
      
      if (price > MAX_PRICE) {
        console.log(`[Execute] ⚠️ Price ${rawPrice} rounds to ${price}, above maximum ${MAX_PRICE}`);
        // Return failure instead of throwing - allows caller to handle gracefully
        return {
          success: false,
          error: `Price too high: ${rawPrice} rounds to ${price}. Polymarket requires price <= ${MAX_PRICE}. This market is nearly resolved.`,
          executionTimeMs: Date.now() - executionStart
        };
      }
      
      // CRITICAL FIX: Round size to 2 decimal places
      // Prevents floating-point precision errors like "14.430000000000291"
      const rawSize = size;
      size = parseFloat(size.toFixed(2));
      
      // Ensure minimum size of 0.01
      if (size < 0.01) {
        throw new Error(`Order size too small after rounding: ${size}. Minimum is 0.01`);
      }
      
      console.log(`[Execute] Price/Size rounding applied:`);
      console.log(`   Raw price: ${rawPrice} -> Rounded: ${price} (tick size: ${tickSize})`);
      console.log(`   Raw size: ${rawSize} -> Rounded: ${size}`);

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'tradeExecutor.ts:executeTrade-afterRounding',message:'Final order values AFTER rounding',data:{tokenId:tokenId,tokenIdLength:tokenId?.length,rawPrice:rawPrice,roundedPrice:price,priceDecimalPlaces:(price.toString().split('.')[1]||'').length,rawSize:rawSize,roundedSize:size,tickSize:tickSize,negRisk:negRisk,side:order.side,marketId:order.marketId,outcome:order.outcome},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2,H3,H4'})}).catch(()=>{});
      // #endregion

      // Convert side to CLOB client Side enum
      const side = order.side === 'BUY' ? Side.BUY : Side.SELL;

      // Place order via CLOB client
      console.log(`\n📤 Placing order via CLOB client...`);
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'tradeExecutor.ts:executeTrade-preClobCall',message:'CALLING clobClient.createAndPostOrder NOW',data:{tokenID:tokenId,tokenIDpreview:tokenId?.substring(0,40),side:side,sideRaw:order.side,size:size,price:price,tickSize:tickSize,negRisk:negRisk},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2,H3,H4,H5'})}).catch(()=>{});
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
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'tradeExecutor.ts:executeTrade-clobError',message:'CLOB client threw error',data:{errorMessage:clobError.message,errorName:clobError.name,httpStatus:clobError.response?.status,responseData:JSON.stringify(clobError.response?.data)?.substring(0,500),tokenID:tokenId,price:price,size:size,side:side,tickSize:tickSize,negRisk:negRisk},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1,H2,H3,H4,H5'})}).catch(()=>{});
        // #endregion
        
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
