import { PolymarketApi } from './polymarketApi.js';
import { PolymarketClobClient } from './clobClient.js';
import { TradeOrder, TradeResult } from './types.js';
import { Storage } from './storage.js';
import { Side } from '@polymarket/clob-client-v2';
import {
  buildTradeExecutionDiagnosticContext,
  logTradeRegressionDebug,
} from './tradeDiagnostics.js';
import { classifyTradeExecutionFailure } from './tradeExecutionDiagnostics.js';
import { createComponentLogger } from './logger.js';
import { clobRateLimiter } from './clobRateLimiter.js';
import { getTenantIdStrict } from './tenantContext.js';
import { config } from './config.js';
import { isHostedMultiTenantMode } from './hostedMode.js';
import { getTradingWallet } from './walletManager.js';
import {
  getClobClientForTradingWallet,
  evictClobClientCacheEntry,
} from './clobClientFactory.js';
import { isWalletUnlocked } from './secureKeyManager.js';

const log = createComponentLogger('TradeExecutor');

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
      if (isHostedMultiTenantMode() && !config.privateKey) {
        this.isAuthenticated = true;
        log.info('✓ Trade executor ready (hosted multi-tenant — per-wallet CLOB clients)');
        return;
      }
      await this.clobClient.initialize();
      this.isAuthenticated = true;
      log.info('✓ Trade executor authenticated');
    } catch (error: any) {
      log.error({ detail: error.message }, '❌ Authentication failed')
      throw error;
    }
  }

  /**
   * CLOB client for an order: tenant trading wallet or legacy global .env wallet.
   */
  private async resolveClobClientForOrder(order: TradeOrder): Promise<PolymarketClobClient> {
    if (order.tradingWalletId) {
      const tw = getTradingWallet(order.tradingWalletId);
      if (!tw) {
        throw new Error(`Trading wallet "${order.tradingWalletId}" not found`);
      }
      if (!tw.isActive) {
        throw new Error(`Trading wallet "${order.tradingWalletId}" is inactive`);
      }
      if (!isWalletUnlocked()) {
        throw new Error('Wallet vault is locked. Unlock in the dashboard to execute trades.');
      }
      return getClobClientForTradingWallet(getTenantIdStrict(), tw, this.api);
    }
    if (isHostedMultiTenantMode()) {
      log.error(
        '[Execute] Hosted mode attempted CLOB access without tradingWalletId; blocking forbidden global fallback'
      );
      throw new Error('Hosted mode requires tradingWalletId for CLOB access; global client fallback is forbidden.');
    }
    await this.clobClient.initialize();
    return this.clobClient;
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
      const clobClient = await this.resolveClobClientForOrder(order);

      log.info(`\n${'='.repeat(60)}`);
      log.info(`🚀 [Execute] EXECUTING TRADE`);
      log.info(`${'='.repeat(60)}`);
      if (order.tradingWalletId) {
        log.info(`   Trading wallet: ${order.tradingWalletId}`);
      }
      log.info(`   Side: ${order.side}`);
      log.info(`   Amount: ${order.amount} shares`);
      log.info(`   Market: ${order.marketId}`);
      log.info(`   Outcome: ${order.outcome}`);
      log.info(`   Price: ${order.price}`);
      log.info(`   Timestamp: ${new Date().toISOString()}`);

      // Use tokenId directly if provided (bypasses Gamma API entirely)
      // This is the critical fix - Gamma API doesn't accept conditionId format
      const tokenId: string | undefined = order.tokenId;
      const tickSize: string = '0.01';  // Default tick size for most Polymarket markets
      const negRisk: boolean = order.negRisk ?? false;

      if (!tokenId) {
        // Token ID is required - fail if not provided
        // Previously we tried to call Gamma API here, but it returns 422 errors
        // because marketId (conditionId) is not the format Gamma API expects
        throw new Error(`Token ID not provided for market ${order.marketId}. Cannot execute trade without tokenId. This may indicate the trade detection did not extract the asset field properly.`);
      }

      log.info(`   Token ID: ${tokenId}`);
      log.info(`   Tick Size: ${tickSize}`);
      log.info(`   Neg Risk: ${negRisk}`);
      log.info(`${'='.repeat(60)}`)

      // Validate price and amount
      let price = parseFloat(order.price);
      let size = parseFloat(order.amount);

      if (isNaN(price) || price <= 0 || price > 1) {
        throw new Error(`Invalid price: ${order.price}. Price must be between 0 and 1`);
      }

      if (isNaN(size) || size <= 0) {
        throw new Error(`Invalid amount: ${order.amount}`);
      }
      
      // ============================================================
      // AGGRESSIVE PRICING FOR IMMEDIATE FILLS (Order or storage slippage)
      // ============================================================
      // Per-wallet slippage from order, else global from storage. Then CLOB client does tick alignment.
      let slippagePercent = order.slippagePercent ?? 2;
      if (slippagePercent === 2 && order.slippagePercent === undefined) {
        try {
          slippagePercent = await Storage.getSlippagePercent();
        } catch (slippageError: any) {
          log.warn(`[Execute] Could not load slippage config (using default 2%): ${slippageError.message}`);
        }
      }
      const PRICE_SLIPPAGE = slippagePercent / 100;
      const originalPrice = price;
      
      if (order.side === 'BUY') {
        price = Math.min(price * (1 + PRICE_SLIPPAGE), 0.99);
      } else {
        price = Math.max(price * (1 - PRICE_SLIPPAGE), 0.01);
      }
      
      log.info(`[Execute] ⚡ AGGRESSIVE PRICING for immediate fill:`);
      log.info(`   Original price: $${originalPrice.toFixed(4)}`);
      log.info(`   Adjusted price: $${price.toFixed(4)} (${order.side === 'BUY' ? '+' : '-'}${slippagePercent.toFixed(1)}% slippage)`);
      
      // Tick alignment is done in CLOB client; we only enforce Polymarket price bounds here.
      
      // POLYMARKET PRICE LIMITS: Must be between 0.01 and 0.99
      const MIN_PRICE = 0.01;
      const MAX_PRICE = 0.99;
      
      if (price < MIN_PRICE) {
        log.info(`[Execute] ⚠️ Price ${price} below minimum ${MIN_PRICE}`);
        return {
          success: false,
          error: `Price too low: ${price}. Polymarket requires price >= ${MIN_PRICE}. This is a "long shot" bet that cannot be copied.`,
          executionTimeMs: Date.now() - executionStart
        };
      }
      
      if (price > MAX_PRICE) {
        log.info(`[Execute] ⚠️ Price ${price} above maximum ${MAX_PRICE}`);
        return {
          success: false,
          error: `Price too high: ${price}. Polymarket requires price <= ${MAX_PRICE}. This market is nearly resolved.`,
          executionTimeMs: Date.now() - executionStart
        };
      }
      
      // Round size to 2 decimal places to avoid floating-point issues; CLOB client handles price tick alignment
      const rawSize = size;
      size = parseFloat(size.toFixed(2));
      
      if (size < 0.01) {
        throw new Error(`Order size too small after rounding: ${size}. Minimum is 0.01`);
      }
      
      log.info(`[Execute] Size rounded: ${rawSize} -> ${size} (price ${price} sent to CLOB for tick alignment)`);
      
      // Ensure price is still valid after rounding
      if (price <= 0 || price > 1) {
        throw new Error(`Price rounding resulted in invalid value: ${price} (original: ${order.price})`);
      }

      // Convert side to CLOB client Side enum
      const side = order.side === 'BUY' ? Side.BUY : Side.SELL;

      // For BUY orders, opportunistically fetch the wallet's pUSD balance so the V2 SDK
      // can do fee-aware fill calculation on market BUYs. Limit orders ignore the field.
      let userUSDCBalance: number | undefined;
      if (side === Side.BUY) {
        try {
          userUSDCBalance = await clobClient.getUsdcBalance();
        } catch (balErr: any) {
          log.warn(`[Execute] Could not fetch pUSD balance for fee-aware sizing (continuing): ${balErr?.message ?? balErr}`);
        }
      }

      // Place order via CLOB client
      log.info(`\n📤 Placing order via CLOB client...`);
      const clobOrderParams = {
        tokenID: tokenId,
        side: side,
        size: size,
        price: price,
        tickSize: tickSize,
        negRisk: negRisk,
        ...(userUSDCBalance !== undefined ? { userUSDCBalance } : {}),
      };
      const diagSig = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0', 10);
      const diagFunder =
        clobClient.getFunderAddress() ||
        process.env.POLYMARKET_FUNDER_ADDRESS ||
        clobClient.getWalletAddress() ||
        '';
      logTradeRegressionDebug('trade-executor.pre-submit', buildTradeExecutionDiagnosticContext({
        stage: 'pre-submit',
        order,
        clobOrderParams,
        execution: {
          signatureType: diagSig,
          funderAddress: diagFunder,
          clobHost: process.env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
          builderAuthConfigured: order.tradingWalletId
            ? true
            : !!process.env.POLYMARKET_BUILDER_API_KEY && !!process.env.POLYMARKET_BUILDER_SECRET && !!process.env.POLYMARKET_BUILDER_PASSPHRASE,
          retryAttempted: false,
        },
        errorMessage: '',
      }));
      
      let orderResponse: any;
      const releaseRateLimit = await clobRateLimiter.acquire(getTenantIdStrict());
      try {
        try {
          orderResponse = await clobClient.createAndPostOrder(clobOrderParams);
        } catch (clobError: any) {
          log.error({ err: clobError.message }, `[Execute] CLOB client threw error`);
          
          // AUTO-RETRY: If "invalid signature", try re-deriving API credentials once
          const isInvalidSig = clobError.message?.toLowerCase().includes('invalid signature');
          if (isInvalidSig) {
            log.warn(`[Execute] ⚠️ "invalid signature" detected — attempting to re-derive API credentials...`);
            log.warn(`[Execute]    This can happen when L2 API keys expire or are revoked by Polymarket.`);
            log.warn(`[Execute]    Also check that POLYMARKET_SIGNATURE_TYPE and POLYMARKET_FUNDER_ADDRESS are correct.`);
            log.warn(`[Execute]    Current signature type: ${process.env.POLYMARKET_SIGNATURE_TYPE || '0'}`);
            log.warn(`[Execute]    Current funder address: ${process.env.POLYMARKET_FUNDER_ADDRESS || '(not set, using signer address)'}`);
            
            try {
              let retryClient: PolymarketClobClient;
              if (order.tradingWalletId) {
                evictClobClientCacheEntry(getTenantIdStrict(), order.tradingWalletId);
                retryClient = await this.resolveClobClientForOrder(order);
              } else {
                this.clobClient = new PolymarketClobClient();
                await this.clobClient.initialize();
                retryClient = this.clobClient;
              }
              log.info(`[Execute] ✓ Re-derived API credentials, retrying order...`);
              
              // Retry the order once with fresh credentials
              orderResponse = await retryClient.createAndPostOrder(clobOrderParams);
            } catch (retryError: any) {
              log.error(`[Execute] ❌ Retry also failed: ${retryError.message}`);
              let authProbeSucceeded = false;
              try {
                await clobClient.getOpenOrders();
                authProbeSucceeded = true;
              } catch (authProbeError: any) {
                log.warn(`[Execute]    Auth probe failed after retry: ${authProbeError.message}`);
              }
              const failureSummary = classifyTradeExecutionFailure({
                errorMessage: retryError.message || clobError.message,
                authProbeSucceeded,
              });
              log.error(`[Execute]    Classified failure: ${failureSummary.classification} - ${failureSummary.summary}`);
              logTradeRegressionDebug('trade-executor.invalid-signature-retry-failed', buildTradeExecutionDiagnosticContext({
                stage: 'invalid-signature-retry-failed',
                order,
                clobOrderParams,
                execution: {
                  signatureType: parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0', 10),
                  funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS || clobClient.getWalletAddress() || '',
                  clobHost: process.env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
                  builderAuthConfigured: !!process.env.POLYMARKET_BUILDER_API_KEY && !!process.env.POLYMARKET_BUILDER_SECRET && !!process.env.POLYMARKET_BUILDER_PASSPHRASE,
                  retryAttempted: true,
                },
                errorMessage: retryError.message || clobError.message || 'invalid signature',
              }));
              log.error(`[Execute]    IMPORTANT: If this keeps happening, you may need to:`);
              log.error(`[Execute]    1. Regenerate your Builder API credentials at https://polymarket.com/settings?tab=builder`);
              log.error(`[Execute]    2. Verify POLYMARKET_SIGNATURE_TYPE matches your wallet type (0=EOA, 1=email, 2=MetaMask+proxy)`);
              log.error(`[Execute]    3. Verify POLYMARKET_FUNDER_ADDRESS is your Polymarket proxy wallet address`);
              throw retryError;
            }
          } else {
            throw clobError;
          }
        }
      } finally {
        releaseRateLimit();
      }

      const executionTime = Date.now() - executionStart;

      // DEBUG: Log the exact response we got

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
        log.error(`[DEBUG] VALIDATION FAILED: orderId="${orderId}", type=${typeof orderId}, isValid=${isValidOrderId}`);
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
      
      if (!isActuallyExecuted) {
        // Order was accepted but not executed - it's a pending limit order
        log.warn(`\n⚠️  [Execute] ORDER PLACED BUT NOT EXECUTED YET`);
        log.warn(`   Order ID: ${orderId}`);
        log.warn(`   Status: ${orderStatus || responseStatus || 'live'}`);
        log.warn(`   This is a limit order placed on the order book.`);
        log.warn(`   It will execute when matched, or may expire/cancel if not filled.`);
        log.warn(`   Transaction Hash: ${txHash || 'None (order not executed yet)'}`);
        log.warn(`   Taking Amount: ${takingAmount || 'None'}`);
        log.warn(`   Making Amount: ${makingAmount || 'None'}\n`);
        
        // Return pending status - order was placed but not executed yet
        return {
          success: false, // Keep false for backward compatibility, but use status field
          status: 'pending',
          orderId: String(orderId),
          transactionHash: undefined,
          error: `Order placed on order book (status: ${orderStatus || 'live'}) but not executed yet. This is a pending limit order that will execute when matched.`,
          executionTimeMs: executionTime
        };
      }

      // If we get here, the order was actually executed
      log.info(`\n✅ [Execute] ORDER EXECUTED SUCCESSFULLY!`);
      log.info(`${'='.repeat(60)}`);
      log.info(`   Order ID: ${orderId}`);
      log.info(`   Status: ${orderStatus || responseStatus || 'executed'}`);
      log.info(`   Transaction Hash: ${txHash || 'N/A'}`);
      if (hasExecutionAmounts) {
        log.info(`   Taking Amount: ${takingAmount}`);
        log.info(`   Making Amount: ${makingAmount}`);
      }
      log.info(`   Execution Time: ${executionTime}ms`);
      log.info(`${'='.repeat(60)}\n`);

      return {
        success: true,
        status: 'executed',
        orderId: String(orderId),
        transactionHash: txHash,
        executionTimeMs: executionTime
      };

    } catch (error: any) {
      const executionTime = Date.now() - executionStart;
      const failure = await this.classifyExecutionFailure(error);
      log.error(`\n${'='.repeat(60)}`);
      log.error('❌ [Execute] TRADE EXECUTION FAILED!');
      log.error(`${'='.repeat(60)}`);
      log.error(`Error message: ${error.message}`);
      log.error(`Failure class: ${failure.code} (${failure.detail})`);
      log.error({ err: error.stack }, 'Error stack');
      
      // Log additional error details if available
      if (error.response) {
        log.error(`HTTP Status: ${error.response.status}`);
        log.error({ detail: JSON.stringify(error.response.data, null, 2) }, `Response data`)
      }
      if (error.originalError) {
        log.error({ err: error.originalError.message }, `Original error`);
      }
      if (error.responseData) {
        log.error({ detail: JSON.stringify(error.responseData, null, 2) }, `Response data (from enhanced error)`)
      }
      if (error.requestParams) {
        log.error({ detail: JSON.stringify(error.requestParams, null, 2) }, `Request params that failed`)
      }
      
      // Build comprehensive error message
      let errorMessage = `[${failure.code}] ${error.message || 'Unknown error'}`;
      
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

  private async classifyExecutionFailure(error: any): Promise<{ code: string; detail: string }> {
    const message = String(error?.message || '').toLowerCase();
    if (message.includes('market_closed') || (message.includes('orderbook') && message.includes('does not exist'))) {
      return { code: 'MARKET_CLOSED', detail: 'Market resolved/closed' };
    }
    if (message.includes('invalid signature')) {
      if (isHostedMultiTenantMode() && !config.privateKey) {
        return { code: 'AUTH_SIGNATURE', detail: 'Invalid signature (per-wallet CLOB)' };
      }
      try {
        await this.clobClient.initialize();
        await this.clobClient.getOpenOrders();
        return { code: 'ORDER_PAYLOAD_OR_MARKET', detail: 'Auth probe succeeded; order likely malformed or market-rejected' };
      } catch {
        return { code: 'AUTH_SIGNATURE', detail: 'Auth probe failed after invalid signature error' };
      }
    }
    if (message.includes('http 400')) {
      return { code: 'ORDER_PAYLOAD', detail: 'Request rejected by CLOB with bad-request semantics' };
    }
    if (message.includes('cloudflare') || message.includes('blocked')) {
      return { code: 'AUTH_OR_NETWORK_BLOCK', detail: 'Request blocked before valid order processing' };
    }
    return { code: 'UNKNOWN_EXECUTION_FAILURE', detail: 'Unclassified execution error' };
  }

  /**
   * Get the wallet address used for executing trades
   */
  getWalletAddress(): string | null {
    if (isHostedMultiTenantMode() && !config.privateKey) {
      return null;
    }
    return this.clobClient.getWalletAddress();
  }

  /**
   * Get the funder/proxy wallet address if configured
   */
  getFunderAddress(): string | null {
    if (isHostedMultiTenantMode() && !config.privateKey) {
      return null;
    }
    return this.clobClient.getFunderAddress();
  }

  /**
   * Get the CLOB client instance for direct access
   */
  getClobClient(): PolymarketClobClient {
    if (isHostedMultiTenantMode()) {
      log.error('[Execute] Hosted mode attempted global CLOB client access; blocked');
      throw new Error('Hosted mode forbids global CLOB client access; use tenant trading wallet clients.');
    }
    return this.clobClient;
  }

  /**
   * Balance / market info for a specific tenant trading wallet (hosted).
   */
  async getClobClientForTradingWalletId(tradingWalletId: string): Promise<PolymarketClobClient> {
    const tw = getTradingWallet(tradingWalletId);
    if (!tw) {
      throw new Error(`Trading wallet "${tradingWalletId}" not found`);
    }
    if (!isWalletUnlocked()) {
      throw new Error('Wallet vault is locked');
    }
    return getClobClientForTradingWallet(getTenantIdStrict(), tw, this.api);
  }
}
