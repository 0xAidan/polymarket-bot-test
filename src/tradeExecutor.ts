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
      const size = parseFloat(order.amount);

      if (isNaN(price) || price <= 0 || price > 1) {
        throw new Error(`Invalid price: ${order.price}. Price must be between 0 and 1`);
      }

      if (isNaN(size) || size <= 0) {
        throw new Error(`Invalid amount: ${order.amount}`);
      }

      // Round price to match tick size (critical for CLOB API)
      // Most Polymarket markets use 0.01 tick size, but we'll round to 4 decimal places as a safe default
      // The CLOB client will handle further rounding based on actual market tick size
      price = Math.round(price * 10000) / 10000; // Round to 4 decimal places
      
      // Ensure price is still valid after rounding
      if (price <= 0 || price > 1) {
        throw new Error(`Price rounding resulted in invalid value: ${price} (original: ${order.price})`);
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

      // Check if order actually has a transaction hash (indicates it was executed on-chain)
      const txHash = orderResponse.txHash || orderResponse.transactionHash || orderResponse.hash || null;
      const hasTransactionHash = txHash && txHash !== '' && txHash !== 'null' && txHash !== 'undefined';
      
      // Check order status and execution amounts to determine if order was actually filled
      const orderStatus = orderResponse.status || responseStatus || '';
      const takingAmount = orderResponse.takingAmount || '';
      const makingAmount = orderResponse.makingAmount || '';
      const hasExecutionAmounts = (takingAmount && takingAmount !== '' && takingAmount !== '0') || 
                                   (makingAmount && makingAmount !== '' && makingAmount !== '0');
      
      // Orders with status "live" are placed on the order book but not filled yet
      // Only mark as successfully executed if:
      // 1. Has transaction hash (on-chain execution), OR
      // 2. Has execution amounts (takingAmount/makingAmount filled), OR  
      // 3. Status indicates filled/completed (not "live")
      const isActuallyExecuted = hasTransactionHash || 
                                 hasExecutionAmounts || 
                                 (orderStatus && orderStatus.toLowerCase() !== 'live' && orderStatus.toLowerCase() !== 'pending');
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'tradeExecutor.ts:executeTrade',message:'Order response validation',data:{orderId:String(orderId),hasTxHash:hasTransactionHash,txHash:txHash?.substring(0,20),responseStatus,orderStatus,takingAmount,makingAmount,hasExecutionAmounts,isActuallyExecuted,responseKeys:Object.keys(orderResponse||{}),fullResponse:JSON.stringify(orderResponse).substring(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      
      if (!isActuallyExecuted) {
        // Order was accepted but not executed - it's a pending limit order
        console.warn(`\n⚠️  [Execute] ORDER PLACED BUT NOT EXECUTED YET`);
        console.warn(`   Order ID: ${orderId}`);
        console.warn(`   Status: ${orderStatus || responseStatus || 'live'}`);
        console.warn(`   This is a limit order placed on the order book.`);
        console.warn(`   It will execute when matched, or may expire/cancel if not filled.`);
        console.warn(`   Transaction Hash: ${txHash || 'None (order not executed yet)'}`);
        console.warn(`   Taking Amount: ${takingAmount || 'None'}`);
        console.warn(`   Making Amount: ${makingAmount || 'None'}\n`);
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'tradeExecutor.ts:executeTrade',message:'Order placed but not executed',data:{orderId:String(orderId),orderStatus,responseStatus,marketId:order.marketId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        
        // Return pending status - order was placed but not executed yet
        return {
          success: false, // Keep false for backward compatibility, but use status field
          status: 'pending',
          orderId: String(orderId),
          transactionHash: null,
          error: `Order placed on order book (status: ${orderStatus || 'live'}) but not executed yet. This is a pending limit order that will execute when matched.`,
          executionTimeMs: executionTime
        };
      }

      // If we get here, the order was actually executed
      console.log(`\n✅ [Execute] ORDER EXECUTED SUCCESSFULLY!`);
      console.log(`${'='.repeat(60)}`);
      console.log(`   Order ID: ${orderId}`);
      console.log(`   Status: ${orderStatus || responseStatus || 'executed'}`);
      console.log(`   Transaction Hash: ${txHash || 'N/A'}`);
      if (hasExecutionAmounts) {
        console.log(`   Taking Amount: ${takingAmount}`);
        console.log(`   Making Amount: ${makingAmount}`);
      }
      console.log(`   Execution Time: ${executionTime}ms`);
      console.log(`${'='.repeat(60)}\n`);

      return {
        success: true,
        status: 'executed',
        orderId: String(orderId),
        transactionHash: txHash,
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
      if (error.responseData) {
        console.error(`Response data (from enhanced error):`, JSON.stringify(error.responseData, null, 2));
      }
      if (error.requestParams) {
        console.error(`Request params that failed:`, JSON.stringify(error.requestParams, null, 2));
      }
      
      // Build comprehensive error message
      let errorMessage = error.message || 'Unknown error';
      
      // Add request params to error message for diagnostics
      if (error.requestParams) {
        errorMessage += ` | Request: tokenID=${error.requestParams.tokenID}, price=${error.requestParams.price}, size=${error.requestParams.size}, side=${error.requestParams.side}`;
      }
      
      // Add response details if available
      if (error.responseData) {
        const responseStr = typeof error.responseData === 'string' 
          ? error.responseData 
          : JSON.stringify(error.responseData);
        if (responseStr.length < 200) {
          errorMessage += ` | Response: ${responseStr}`;
        }
      }
      
      return {
        success: false,
        status: 'failed',
        error: errorMessage,
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
