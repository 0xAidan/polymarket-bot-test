import { ClobClient, Side, OrderType } from '@polymarket/clob-client-v2';
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
    builderCode: string;
  };
}

/**
 * Wrapper for Polymarket CLOB V2 client with proper L2 authentication.
 * In V2: builder attribution is via a `builderCode` field on each order;
 * missing builderCode does NOT block placement, just disables attribution.
 */
export class PolymarketClobClient {
  private client: ClobClient | null = null;
  private signer: ethers.Wallet | null = null;
  private isInitialized = false;
  private resolvedFunderAddress: string | null = null;
  private builderCode: string | null = null;
  private readonly USDC_DECIMALS = 1_000_000; // 10^6

  /**
   * Initialize from an explicit wallet identity (tenant trading wallet).
   */
  async initializeFromOptions(opts: ClobWalletInitOptions): Promise<void> {
    if (this.isInitialized && this.client) {
      return;
    }

    const HOST = config.polymarketClobApiUrl || 'https://clob.polymarket.com';

    const provider = new (ethers as any).providers.JsonRpcProvider(config.polygonRpcUrl);
    this.signer = new ethers.Wallet(opts.privateKey, provider);
    this.resolvedFunderAddress = opts.funderAddress;
    this.builderCode = opts.builder?.builderCode || null;

    const tempClient = new ClobClient({
      host: HOST,
      chain: 137,
      signer: this.signer,
    });
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

    if (this.builderCode) {
      log.info('✓ Builder code attached for this wallet (attribution enabled)');
    } else {
      log.warn('Builder attribution disabled — POLYMARKET_BUILDER_CODE not set. Orders will still place; you just lose attribution.');
    }

    const clientOpts: any = {
      host: HOST,
      chain: 137,
      signer: this.signer,
      creds: apiCreds,
      signatureType: opts.signatureType,
      funderAddress: opts.funderAddress,
    };
    if (this.builderCode) {
      clientOpts.builderConfig = { builderCode: this.builderCode };
    }
    this.client = new ClobClient(clientOpts);

    this.isInitialized = true;
    log.info('✓ CLOB V2 client initialized (explicit wallet)');
    log.info(`   Wallet (EOA): ${this.signer.address}`);
    log.info(`   Funder: ${opts.funderAddress}`);
    log.info(`   Signature Type: ${opts.signatureType}`);
  }

  /**
   * Initialize the CLOB client with User API credentials and Builder attribution.
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
      if (config.polymarketBuilderCode) {
        builder = { builderCode: config.polymarketBuilderCode };
      } else {
        log.warn('Builder code not configured — POLYMARKET_BUILDER_CODE missing. Orders will place without attribution.');
      }

      await this.initializeFromOptions({
        privateKey: config.privateKey,
        signatureType,
        funderAddress,
        builder,
      });

      const HOST = config.polymarketClobApiUrl || 'https://clob.polymarket.com';
      log.info('✓ CLOB V2 client initialized successfully');
      log.info(`   Host: ${HOST}`);
      log.info(`   Builder code: ${config.polymarketBuilderCode ? config.polymarketBuilderCode.substring(0, 8) + '...' : 'NOT SET (attribution disabled)'}`);
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

  async getMarket(tokenId: string): Promise<any> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) {
      throw new Error('CLOB client not initialized');
    }
    return await this.client.getMarket(tokenId);
  }

  async getMinOrderSize(tokenId: string): Promise<number> {
    try {
      const market = await this.getMarket(tokenId);
      const minSize = parseFloat(market?.min_order_size || market?.minOrderSize || '5');
      if (isNaN(minSize) || minSize <= 0) {
        log.info(`[CLOB] No valid min_order_size found for ${tokenId.substring(0, 20)}..., defaulting to 5`);
        return 5;
      }
      log.info(`[CLOB] Market min_order_size for ${tokenId.substring(0, 20)}...: ${minSize}`);
      return minSize;
    } catch (error: any) {
      log.warn({ detail: error.message }, `[CLOB] Could not fetch min_order_size for ${tokenId.substring(0, 20)}..., defaulting to 5`);
      return 5;
    }
  }

  /**
   * Place an order using the CLOB V2 client.
   * Optional `userUSDCBalance` is forwarded for fee-aware fill calc on market BUYs only.
   */
  async createAndPostOrder(params: {
    tokenID: string;
    price: number;
    size: number;
    side: Side;
    tickSize?: string;
    negRisk?: boolean;
    userUSDCBalance?: number;
  }): Promise<any> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) {
      throw new Error('CLOB client not initialized');
    }

    let tickSize = params.tickSize;
    let negRisk = params.negRisk;

    if (!tickSize || negRisk === undefined) {
      try {
        const market = await this.getMarket(params.tokenID);
        tickSize = tickSize || market.tickSize || '0.01';
        negRisk = negRisk !== undefined ? negRisk : (market.negRisk || false);
        log.info(`[CLOB] Market info: tickSize=${tickSize}, negRisk=${negRisk}`);
      } catch (error: any) {
        log.warn({ detail: error.message }, `[CLOB] Could not fetch market info for tokenID ${params.tokenID}, using defaults`);
        tickSize = tickSize || '0.01';
        negRisk = negRisk !== undefined ? negRisk : false;
      }
    }

    const tickSizeNum = parseFloat(tickSize || '0.01');
    let finalPrice = params.price;
    if (!isNaN(tickSizeNum) && tickSizeNum > 0) {
      const roundedPrice = Math.round(params.price / tickSizeNum) * tickSizeNum;
      if (roundedPrice > 0 && roundedPrice < 1) {
        if (Math.abs(roundedPrice - params.price) > 0.0001) {
          log.info(`[CLOB] Price rounded from ${params.price} to ${roundedPrice} to match tickSize ${tickSize}`);
        }
        finalPrice = roundedPrice;
      } else {
        log.warn(`[CLOB] Price rounding resulted in invalid value: ${roundedPrice}, using original: ${params.price}`);
      }
    }

    if (finalPrice <= 0 || finalPrice > 1) {
      throw new Error(`Invalid price after rounding: ${finalPrice} (original: ${params.price}, tickSize: ${tickSize})`);
    }

    try {
      log.info(`[CLOB] Placing order: tokenID=${params.tokenID}, originalPrice=${params.price}, size=${params.size}, side=${params.side}, tickSize=${tickSize}`);

      const orderBody: any = {
        tokenID: params.tokenID,
        price: finalPrice,
        size: params.size,
        side: params.side,
      };
      if (this.builderCode) {
        orderBody.builderCode = this.builderCode;
      }
      if (params.userUSDCBalance !== undefined) {
        orderBody.userUSDCBalance = params.userUSDCBalance;
      }

      let response: any;
      try {
        response = await this.client.createAndPostOrder(
          orderBody,
          {
            tickSize: tickSize! as any,
            negRisk: negRisk!,
          },
          OrderType.GTC,
        );
      } catch (innerError: any) {
        log.error({ err: innerError.message }, `[CLOB] Client threw error`);
        const responseData = innerError.response?.data;

        const status = innerError.response?.status;
        let enhancedError = innerError;

        if (status === 400) {
          log.error(`[CLOB] ===== 400 BAD REQUEST DETAILS =====`);
          log.error({ detail: JSON.stringify(responseData, null, 2) }, `[CLOB] Response data`);
          log.error(`[CLOB] Request params: tokenID=${params.tokenID}, price=${params.price}, size=${params.size}, side=${params.side}`);
          log.error(`[CLOB] Options: tickSize=${tickSize}, negRisk=${negRisk}`);
          log.error(`[CLOB] ======================================`);

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

      const statusCode = response?.status;
      if (statusCode !== undefined && statusCode !== null) {
        const numericStatus = typeof statusCode === 'string' ? parseInt(statusCode, 10) : statusCode;
        if (!isNaN(numericStatus) && numericStatus >= 400) {
          const errorMsg = response?.error || response?.message || 'request was rejected';
          if (typeof errorMsg === 'string' && errorMsg.includes('orderbook') && errorMsg.includes('does not exist')) {
            throw new Error(`MARKET_CLOSED: The orderbook for this market no longer exists. The market has been resolved or closed.`);
          }
          const details = typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg);
          throw new Error(`CLOB API returned HTTP error ${numericStatus} - ${details}`);
        }
      }

      if (!response) {
        throw new Error('CLOB client returned empty/null response - order was NOT placed');
      }

      if (typeof response === 'object' && Object.keys(response).length === 0) {
        throw new Error('CLOB client returned empty object - order likely failed silently');
      }

      if (response.error) {
        throw new Error(`CLOB API error: ${response.error}`);
      }

      if (typeof response === 'string') {
        if (response.includes('Cloudflare') || response.includes('blocked')) {
          throw new Error('Request blocked by Cloudflare - server IP may be blocked');
        }
        if (response.includes('<!DOCTYPE') || response.includes('<html')) {
          throw new Error('Received HTML error page instead of JSON response - API may be blocked');
        }
      }

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
      let errorMessage = 'Unknown CLOB error';

      if (error.response) {
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

  getWalletAddress(): string | null {
    if (this.signer?.address) {
      return this.signer.address;
    }

    try {
      const privateKey = process.env.PRIVATE_KEY || config.privateKey;
      if (privateKey && privateKey.length === 66 && privateKey.startsWith('0x')) {
        const wallet = new ethers.Wallet(privateKey);
        return wallet.address;
      }
    } catch (error: any) {
      log.warn({ detail: error.message }, '[CLOB] Could not derive wallet address');
    }

    return null;
  }

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

  async getOpenOrders(): Promise<any[]> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) {
      throw new Error('CLOB client not initialized');
    }
    return await this.client.getOpenOrders();
  }

  async cancelOrder(orderId: string): Promise<any> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) {
      throw new Error('CLOB client not initialized');
    }
    return await this.client.cancelOrder(orderId);
  }

  /**
   * Get pUSD (V2 collateral) balance for the authenticated wallet.
   * The CLOB API returns raw micro-pUSD (6 decimals on Polygon).
   */
  async getUsdcBalance(): Promise<number> {
    const collateral = await this.getCollateralStatus();
    return collateral.balanceUsdc;
  }

  /**
   * Fetch collateral balance + allowance and compute spendable amount.
   * V2 returns pUSD through this same path.
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
        asset_type: 'COLLATERAL',
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
        `spendable=$${spendableUsdc.toFixed(2)}`,
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
