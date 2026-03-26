import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import * as ethers from 'ethers';
import { config } from './config.js';
import { getValidEvmAddress } from './addressUtils.js';
import { logTradeRegressionDebug } from './tradeDiagnostics.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('ClobClient');

/** Explicit wallet + Builder options (hosted multi-tenant or tests). */
export interface ClobWalletInitOptions {
  privateKey: string;
  signatureType: number;
  funderAddress: string;
  builder?: {
    key: string;
    secret: string;
    passphrase: string;
  };
}

/**
 * Wrapper for Polymarket CLOB client with proper L2 authentication
 * Uses User API credentials (derived from private key) for authentication
 * Builder API credentials are optional and only used for order attribution
 */
export class PolymarketClobClient {
  private client: ClobClient | null = null;
  private signer: ethers.Wallet | null = null;
  private isInitialized = false;
  /** Set after init — used for getFunderAddress when not using env */
  private resolvedFunderAddress: string | null = null;
  private readonly USDC_DECIMALS = 1_000_000; // 10^6

  /**
   * Initialize from an explicit wallet identity (tenant trading wallet).
   */
  async initializeFromOptions(opts: ClobWalletInitOptions): Promise<void> {
    if (this.isInitialized && this.client) {
      return;
    }

    const HOST = config.polymarketClobApiUrl || 'https://clob.polymarket.com';
    const CHAIN_ID = 137;

    const provider = new (ethers as any).providers.JsonRpcProvider(config.polygonRpcUrl);
    this.signer = new ethers.Wallet(opts.privateKey, provider);
    this.resolvedFunderAddress = opts.funderAddress;

    const tempClient = new ClobClient(HOST, CHAIN_ID, this.signer);
    let apiCreds;
    try {
      apiCreds = await tempClient.createOrDeriveApiKey();
      log.info('✓ Derived User API credentials for L2 authentication');
    } catch (apiKeyError: any) {
      log.error(`❌ CRITICAL: Failed to create/derive API key: ${apiKeyError.message}`);
      throw new Error(`Cannot trade without L2 API credentials. Error: ${apiKeyError.message}. Make sure your wallet has been used on Polymarket before.`);
    }

    const creds = apiCreds as any;
    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      log.error(`❌ CRITICAL: API credentials are invalid or missing!`);
      throw new Error('Failed to obtain valid L2 API credentials. The wallet may not be registered on Polymarket.');
    }

    let builderConfig: BuilderConfig | undefined;
    const b = opts.builder;
    if (b?.key && b?.secret && b?.passphrase) {
      builderConfig = new BuilderConfig({
        localBuilderCreds: {
          key: b.key,
          secret: b.secret,
          passphrase: b.passphrase,
        },
      });
      log.info('✓ Builder API credentials configured for this wallet');
    } else {
      log.error('❌ Builder API credentials missing for this wallet — orders may be blocked by Cloudflare');
    }

    this.client = new ClobClient(
      HOST,
      CHAIN_ID,
      this.signer,
      apiCreds,
      opts.signatureType,
      opts.funderAddress,
      undefined,
      false,
      builderConfig
    );

    this.isInitialized = true;
    log.info('✓ CLOB client initialized (explicit wallet)');
    log.info(`   Wallet (EOA): ${this.signer.address}`);
    log.info(`   Funder: ${opts.funderAddress}`);
    log.info(`   Signature Type: ${opts.signatureType}`);
  }

  /**
   * Initialize the CLOB client with User API credentials and Builder credentials
   */
  async initialize(): Promise<void> {
    if (this.isInitialized && this.client) {
      return;
    }

    if (!config.privateKey) {
      throw new Error('Private key not configured');
    }

    try {
      const signatureType = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0', 10);
      const provider = new (ethers as any).providers.JsonRpcProvider(config.polygonRpcUrl);
      const signer = new ethers.Wallet(config.privateKey, provider);
      const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || signer.address;

      let builder: ClobWalletInitOptions['builder'];
      if (
        config.polymarketBuilderApiKey &&
        config.polymarketBuilderSecret &&
        config.polymarketBuilderPassphrase
      ) {
        builder = {
          key: config.polymarketBuilderApiKey,
          secret: config.polymarketBuilderSecret,
          passphrase: config.polymarketBuilderPassphrase,
        };
      } else {
        log.error('❌ Builder API credentials NOT configured!');
        log.error('   Orders WILL BE BLOCKED by Cloudflare without Builder authentication.');
        log.error('   Set POLYMARKET_BUILDER_API_KEY, POLYMARKET_BUILDER_SECRET, POLYMARKET_BUILDER_PASSPHRASE');
      }

      await this.initializeFromOptions({
        privateKey: config.privateKey,
        signatureType,
        funderAddress,
        builder,
      });

      const HOST = config.polymarketClobApiUrl || 'https://clob.polymarket.com';
      log.info('✓ CLOB client initialized successfully');
      log.info(`   Host: ${HOST}`);
      log.info(`   Builder API Key: ${config.polymarketBuilderApiKey ? config.polymarketBuilderApiKey.substring(0, 8) + '...' : 'NOT SET'}`);
      if (signatureType === 2 && funderAddress === signer.address) {
        log.warn(`   ⚠️ WARNING: Signature type is 2 (POLY_GNOSIS_SAFE) but funder address = signer address!`);
        log.warn(`      You probably need to set POLYMARKET_FUNDER_ADDRESS to your Polymarket proxy wallet address.`);
      }
    } catch (error: any) {
      log.error({ detail: error.message }, '❌ Failed to initialize CLOB client');
      if (error.stack) {
        log.error({ err: error.stack }, 'Stack trace');
      }
      throw error;
    }
  }

  /**
   * Get market information
   */
  async getMarket(tokenId: string): Promise<any> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) {
      throw new Error('CLOB client not initialized');
    }
    return await this.client.getMarket(tokenId);
  }

  /**
   * Get the minimum order size for a market
   * Returns the min_order_size from the order book, defaults to 5 if not available
   */
  async getMinOrderSize(tokenId: string): Promise<number> {
    try {
      const market = await this.getMarket(tokenId);
      // The API returns min_order_size as a string
      const minSize = parseFloat(market?.min_order_size || market?.minOrderSize || '5');
      if (isNaN(minSize) || minSize <= 0) {
        log.info(`[CLOB] No valid min_order_size found for ${tokenId.substring(0, 20)}..., defaulting to 5`);
        return 5;
      }
      log.info(`[CLOB] Market min_order_size for ${tokenId.substring(0, 20)}...: ${minSize}`);
      return minSize;
    } catch (error: any) {
      log.warn({ detail: error.message }, `[CLOB] Could not fetch min_order_size for ${tokenId.substring(0, 20)}..., defaulting to 5`)
      return 5; // Default to 5 shares as that's what most markets use
    }
  }

  /**
   * Place an order using the CLOB client
   */
  async createAndPostOrder(params: {
    tokenID: string;
    price: number;
    size: number;
    side: Side;
    tickSize?: string;
    negRisk?: boolean;
  }): Promise<any> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) {
      throw new Error('CLOB client not initialized');
    }

    // Get market info to determine tickSize and negRisk if not provided
    let tickSize = params.tickSize;
    let negRisk = params.negRisk;

    if (!tickSize || negRisk === undefined) {
      try {
        const market = await this.getMarket(params.tokenID);
        tickSize = tickSize || market.tickSize || '0.01';
        negRisk = negRisk !== undefined ? negRisk : (market.negRisk || false);
        log.info(`[CLOB] Market info: tickSize=${tickSize}, negRisk=${negRisk}`);
      } catch (error: any) {
        log.warn({ detail: error.message }, `[CLOB] Could not fetch market info for tokenID ${params.tokenID}, using defaults`)
        tickSize = tickSize || '0.01';
        negRisk = negRisk !== undefined ? negRisk : false;
      }
    }

    // Round price to match tick size exactly (CRITICAL for CLOB API)
    // CLOB API is very strict - price must match tick size exactly
    const tickSizeNum = parseFloat(tickSize || '0.01');
    let finalPrice = params.price;
    if (!isNaN(tickSizeNum) && tickSizeNum > 0) {
      // Round price to nearest tick
      const roundedPrice = Math.round(params.price / tickSizeNum) * tickSizeNum;
      // Polymarket allows (0, 1) only; reject 0 and 1
      if (roundedPrice > 0 && roundedPrice < 1) {
        if (Math.abs(roundedPrice - params.price) > 0.0001) {
          log.info(`[CLOB] Price rounded from ${params.price} to ${roundedPrice} to match tickSize ${tickSize}`);
        }
        finalPrice = roundedPrice;
      } else {
        log.warn(`[CLOB] Price rounding resulted in invalid value: ${roundedPrice}, using original: ${params.price}`);
      }
    }

    // Validate final price
    if (finalPrice <= 0 || finalPrice > 1) {
      throw new Error(`Invalid price after rounding: ${finalPrice} (original: ${params.price}, tickSize: ${tickSize})`);
    }

    // Place the order with proper error handling
    try {
      log.info(`[CLOB] Placing order: tokenID=${params.tokenID}, originalPrice=${params.price}, size=${params.size}, side=${params.side}, tickSize=${tickSize}`);
      
      
      let response: any;
      try {
        response = await this.client.createAndPostOrder(
          {
            tokenID: params.tokenID,
            price: finalPrice, // Use rounded price
            size: params.size,
            side: params.side,
          },
          {
            tickSize: tickSize! as any, // TickSize type from CLOB client
            negRisk: negRisk!,
          },
          OrderType.GTC // Good-Til-Cancelled
        );
      } catch (innerError: any) {
        // CLOB client threw an error - this is the expected behavior for failures
        log.error({ err: innerError.message }, `[CLOB] Client threw error`);
        const responseData = innerError.response?.data;
        
        // DETAILED ERROR LOGGING FOR 400 ERRORS
        const status = innerError.response?.status;
        let enhancedError = innerError;
        
        if (status === 400) {
          log.error(`[CLOB] ===== 400 BAD REQUEST DETAILS =====`);
          log.error({ detail: JSON.stringify(responseData, null, 2) }, `[CLOB] Response data`)
          log.error(`[CLOB] Request params: tokenID=${params.tokenID}, price=${params.price}, size=${params.size}, side=${params.side}`);
          log.error(`[CLOB] Options: tickSize=${tickSize}, negRisk=${negRisk}`);
          log.error(`[CLOB] ======================================`);
          
          // Create enhanced error message with response details
          let errorDetails = '';
          if (typeof responseData === 'string') {
            errorDetails = responseData;
          } else if (responseData?.message) {
            errorDetails = responseData.message;
          } else if (responseData?.error) {
            errorDetails = typeof responseData.error === 'string' ? responseData.error : JSON.stringify(responseData.error);
          } else if (responseData) {
            errorDetails = JSON.stringify(responseData);
          }
          
          logTradeRegressionDebug('clob-client.http-400', {
            source: 'clob-client',
            status,
            responseData,
            requestParams: {
              tokenID: params.tokenID,
              originalPrice: params.price,
              finalPrice,
              size: params.size,
              side: params.side === Side.BUY ? 'BUY' : 'SELL',
              tickSize,
              negRisk,
            },
          });
          const enhancedMessage = `CLOB API returned HTTP 400 - ${errorDetails || 'request was rejected'}. Params: tokenID=${params.tokenID}, originalPrice=${params.price}, finalPrice=${finalPrice}, size=${params.size}, side=${params.side}, tickSize=${tickSize}, negRisk=${negRisk}. Check: tokenID validity, price/size format, market status, or balance.`;
          enhancedError = new Error(enhancedMessage);
          (enhancedError as any).originalError = innerError;
          (enhancedError as any).response = innerError.response;
          (enhancedError as any).responseData = responseData;
          (enhancedError as any).requestParams = { tokenID: params.tokenID, originalPrice: params.price, finalPrice, size: params.size, side: params.side, tickSize, negRisk };
        }
        
        throw enhancedError;
      }

      if (response && typeof response === 'object') {
        // TODO: Handle specific response types if necessary
      }

      // CRITICAL: Check for HTTP error status FIRST (handles both string and number)
      const statusCode = response?.status;
      if (statusCode !== undefined && statusCode !== null) {
        const numericStatus = typeof statusCode === 'string' ? parseInt(statusCode, 10) : statusCode;
        if (!isNaN(numericStatus) && numericStatus >= 400) {
          // Check for specific "orderbook does not exist" error (market closed/resolved)
          const errorMsg = response?.error || response?.message || 'request was rejected';
          if (typeof errorMsg === 'string' && errorMsg.includes('orderbook') && errorMsg.includes('does not exist')) {
            throw new Error(`MARKET_CLOSED: The orderbook for this market no longer exists. The market has been resolved or closed.`);
          }
          const details = typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg);
          throw new Error(`CLOB API returned HTTP error ${numericStatus} - ${details}`);
        }
      }

      // Check if response is empty or null
      if (!response) {
        throw new Error('CLOB client returned empty/null response - order was NOT placed');
      }

      // Check if response is an empty object
      if (typeof response === 'object' && Object.keys(response).length === 0) {
        throw new Error('CLOB client returned empty object - order likely failed silently');
      }

      // Check if response contains error indicators
      if (response.error) {
        throw new Error(`CLOB API error: ${response.error}`);
      }

      // Check for Cloudflare block (response might be HTML string)
      if (typeof response === 'string') {
        if (response.includes('Cloudflare') || response.includes('blocked')) {
          throw new Error('Request blocked by Cloudflare - server IP may be blocked');
        }
        if (response.includes('<!DOCTYPE') || response.includes('<html')) {
          throw new Error('Received HTML error page instead of JSON response - API may be blocked');
        }
      }

      // CRITICAL: Validate that we got an actual valid order ID
      const orderId = response?.orderID || response?.orderId || response?.id;
      const isValidOrderId = orderId !== undefined && 
                              orderId !== null && 
                              orderId !== '' && 
                              String(orderId) !== 'undefined' && 
                              String(orderId) !== 'null' &&
                              String(orderId).length > 0;
      
      if (!isValidOrderId) {
        log.error(`[DEBUG] VALIDATION FAILED: orderId="${orderId}", type=${typeof orderId}`);
        throw new Error(`CLOB response missing valid orderID. Got orderId="${orderId}". Full response: ${JSON.stringify(response)}`);
      }

      log.info(`[CLOB] Order placed successfully: orderID=${orderId}`);
      return response;
    } catch (error: any) {
      // Extract meaningful error message from various error formats
      let errorMessage = 'Unknown CLOB error';
      
      if (error.response) {
        // Axios-style error with response
        const status = error.response.status;
        const data = error.response.data;
        
        if (status === 403) {
          errorMessage = `Request blocked (403 Forbidden) - Server IP may be blocked by Cloudflare`;
        } else if (typeof data === 'string' && data.includes('Cloudflare')) {
          errorMessage = `Request blocked by Cloudflare (status ${status})`;
        } else if (data?.error) {
          errorMessage = `CLOB API error (${status}): ${data.error}`;
        } else {
          errorMessage = `CLOB API error (${status}): ${JSON.stringify(data)}`;
        }
      } else if (error.message) {
        errorMessage = error.message;
      }

      log.error({ err: errorMessage }, `[CLOB] Order failed`);
      throw new Error(`Failed to place order: ${errorMessage}`);
    }
  }

  /**
   * Get the wallet address (EOA)
   * If the CLOB client isn't initialized, derive from private key
   */
  getWalletAddress(): string | null {
    // First try the signer if initialized
    if (this.signer?.address) {
      return this.signer.address;
    }
    
    // If not initialized, derive from private key in config
    try {
      const privateKey = process.env.PRIVATE_KEY || config.privateKey;
      if (privateKey && privateKey.length === 66 && privateKey.startsWith('0x')) {
        const wallet = new ethers.Wallet(privateKey);
        return wallet.address;
      }
    } catch (error: any) {
      log.warn({ detail: error.message }, '[CLOB] Could not derive wallet address')
    }
    
    return null;
  }

  /**
   * Get the funder address (proxy wallet) if configured
   * This is the address where Polymarket holds your funds
   */
  getFunderAddress(): string | null {
    if (this.resolvedFunderAddress) {
      const normalized = getValidEvmAddress(this.resolvedFunderAddress);
      if (normalized) {
        return normalized;
      }
    }
    const funderAddress = getValidEvmAddress(process.env.POLYMARKET_FUNDER_ADDRESS);
    const signerAddress = this.signer?.address?.toLowerCase();
    if (funderAddress && funderAddress !== signerAddress) {
      return funderAddress;
    }
    return null;
  }

  /**
   * Get open orders
   */
  async getOpenOrders(): Promise<any[]> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) {
      throw new Error('CLOB client not initialized');
    }
    return await this.client.getOpenOrders();
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<any> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) {
      throw new Error('CLOB client not initialized');
    }
    // Use cancelOrder method which takes order_id as a string parameter
    return await this.client.cancelOrder(orderId);
  }

  /**
   * Get USDC (collateral) balance for the authenticated wallet.
   * The CLOB API returns raw micro-USDC (6 decimals on Polygon),
   * so we divide by 1e6 to return a human-readable dollar value.
   */
  async getUsdcBalance(): Promise<number> {
    const collateral = await this.getCollateralStatus();
    return collateral.balanceUsdc;
  }

  /**
   * Fetch collateral balance + allowance and compute spendable USDC.
   * This is used to prevent avoidable "not enough balance / allowance" order failures.
   */
  async getCollateralStatus(): Promise<{
    balanceUsdc: number;
    allowanceUsdc: number | null;
    spendableUsdc: number;
    raw: unknown;
  }> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) {
      throw new Error('CLOB client not initialized');
    }

    try {
      const response = await (this.client as any).getBalanceAllowance({
        asset_type: 'COLLATERAL'
      });
      const balanceRaw = this.parseRawAmount(response?.balance) ?? 0;
      const allowanceRaw = this.parseRawAmount(response?.allowance);

      const balanceUsdc = balanceRaw / this.USDC_DECIMALS;
      const allowanceUsdc = allowanceRaw === null ? null : allowanceRaw / this.USDC_DECIMALS;
      const spendableUsdc = allowanceUsdc === null
        ? balanceUsdc
        : Math.min(balanceUsdc, allowanceUsdc);

      log.info(
        `[CLOB] Collateral status: balance=$${balanceUsdc.toFixed(2)}, ` +
        `allowance=${allowanceUsdc === null ? 'unknown' : '$' + allowanceUsdc.toFixed(2)}, ` +
        `spendable=$${spendableUsdc.toFixed(2)}`
      );

      return {
        balanceUsdc,
        allowanceUsdc,
        spendableUsdc,
        raw: response,
      };
    } catch (error: any) {
      log.error({ detail: error.message }, '[CLOB] Failed to get collateral status');
      throw error;
    }
  }

  private parseRawAmount(value: unknown): number | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const parsed = Number.parseFloat(String(value));
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  }
}
