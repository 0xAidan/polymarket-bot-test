import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import * as ethers from 'ethers';
import { config } from './config.js';

/**
 * Wrapper for Polymarket CLOB client with proper L2 authentication
 * Uses User API credentials (derived from private key) for authentication
 * Builder API credentials are optional and only used for order attribution
 */
export class PolymarketClobClient {
  private client: ClobClient | null = null;
  private signer: ethers.Wallet | null = null;
  private isInitialized = false;

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
      // Use configured CLOB URL - can be set to a Cloudflare Worker proxy if needed
      // Set POLYMARKET_CLOB_API_URL env var to your worker URL to bypass IP blocking
      const HOST = config.polymarketClobApiUrl || 'https://clob.polymarket.com';
      const CHAIN_ID = 137; // Polygon mainnet
      
      
      // Create wallet signer using ethers v5 (required by @polymarket/clob-client)
      const provider = new (ethers as any).providers.JsonRpcProvider(config.polygonRpcUrl);
      this.signer = new ethers.Wallet(config.privateKey, provider);
      

      // STEP 1: Create temporary client with ONLY the signer to derive API credentials
      // Per Polymarket docs: https://docs.polymarket.com/developers/CLOB/authentication
      // L1 auth (createOrDeriveApiKey) only needs the signer, NOT signatureType/funder
      const tempClient = new ClobClient(HOST, CHAIN_ID, this.signer);
      let apiCreds;
      try {
        apiCreds = await tempClient.createOrDeriveApiKey();
        console.log('✓ Derived User API credentials for L2 authentication');
        // The CLOB client returns credentials with properties: key, secret, passphrase
      } catch (apiKeyError: any) {
        console.error(`❌ CRITICAL: Failed to create/derive API key: ${apiKeyError.message}`);
        throw new Error(`Cannot trade without L2 API credentials. Error: ${apiKeyError.message}. Make sure your wallet has been used on Polymarket before.`);
      }
      
      // CRITICAL: Validate that we actually got credentials
      // Note: CLOB client returns {key, secret, passphrase} not {apiKey, apiSecret, apiPassphrase}
      const creds = apiCreds as any;
      if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
        console.error(`❌ CRITICAL: API credentials are invalid or missing!`);
        console.error(`   apiCreds: ${JSON.stringify(apiCreds)}`);
        throw new Error('Failed to obtain valid L2 API credentials. The wallet may not be registered on Polymarket.');
      }
      
      console.log(`✓ API credentials validated successfully`);

      // STEP 2: Now read signature type and funder address for the full client
      // Per Polymarket docs: https://docs.polymarket.com/developers/CLOB/authentication
      // 
      // Signature Types:
      //   0 = EOA: Pure externally-owned account, signer IS the funder (no proxy)
      //   1 = POLY_PROXY: Magic Link / email signup (Polymarket created internal key)
      //   2 = POLY_GNOSIS_SAFE: Browser wallet (MetaMask/Rabby) connected with proxy wallet
      //
      // If you connected MetaMask and Polymarket shows a different "Proxy Wallet" address,
      // you need signatureType=2 and funderAddress=your proxy wallet address
      const signatureType = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0', 10);
      
      // Funder address - the wallet that holds the funds
      // For EOA (type 0): same as signer address
      // For proxy (type 1 or 2): the proxy wallet address shown in Polymarket settings
      const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || this.signer.address;
      

      // Create BuilderConfig with Builder API credentials (REQUIRED for authenticated trading)
      // Without this, requests get blocked by Cloudflare as unauthorized bot traffic
      let builderConfig: BuilderConfig | undefined;
      
      
      if (config.polymarketBuilderApiKey && 
          config.polymarketBuilderSecret && 
          config.polymarketBuilderPassphrase) {
        
        builderConfig = new BuilderConfig({
          localBuilderCreds: {
            key: config.polymarketBuilderApiKey,
            secret: config.polymarketBuilderSecret,
            passphrase: config.polymarketBuilderPassphrase,
          }
        });
        console.log('✓ Builder API credentials configured for authenticated trading');
        // Log partial credentials for debugging (first 8 chars only for security)
      } else {
        console.error('❌ Builder API credentials NOT configured!');
        console.error('   Orders WILL BE BLOCKED by Cloudflare without Builder authentication.');
        console.error('   This is the #1 cause of trade execution failures on cloud servers.');
        console.error('   Set POLYMARKET_BUILDER_API_KEY, POLYMARKET_BUILDER_SECRET, POLYMARKET_BUILDER_PASSPHRASE');
        console.error('   Get these from: https://polymarket.com/settings?tab=builder');
      }

      // Initialize the trading client with ALL 9 parameters including BuilderConfig
      // Parameters: host, chainId, signer, apiCreds, signatureType, funderAddress, relayer, useRelayer, builderConfig
      this.client = new ClobClient(
        HOST,
        CHAIN_ID,
        this.signer,
        apiCreds,
        signatureType,
        funderAddress,
        undefined,      // relayer (not used)
        false,          // useRelayer
        builderConfig   // BuilderConfig for authenticated trading
      );

      this.isInitialized = true;
      console.log('✓ CLOB client initialized successfully');
      console.log(`   Host: ${HOST}`);
      console.log(`   Wallet (EOA): ${this.signer.address}`);
      console.log(`   Funder: ${funderAddress}`);
      console.log(`   Signature Type: ${signatureType} (${signatureType === 0 ? 'EOA' : signatureType === 1 ? 'POLY_PROXY' : signatureType === 2 ? 'POLY_GNOSIS_SAFE' : 'UNKNOWN'})`);
      console.log(`   Builder Auth: ${builderConfig ? 'ENABLED' : 'DISABLED'}`);
      console.log(`   Builder API Key: ${config.polymarketBuilderApiKey ? config.polymarketBuilderApiKey.substring(0, 8) + '...' : 'NOT SET'}`);
      if (signatureType === 2 && funderAddress === this.signer.address) {
        console.warn(`   ⚠️ WARNING: Signature type is 2 (POLY_GNOSIS_SAFE) but funder address = signer address!`);
        console.warn(`      You probably need to set POLYMARKET_FUNDER_ADDRESS to your Polymarket proxy wallet address.`);
      }
    } catch (error: any) {
      console.error('❌ Failed to initialize CLOB client:', error.message);
      if (error.stack) {
        console.error('Stack trace:', error.stack);
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
        console.log(`[CLOB] No valid min_order_size found for ${tokenId.substring(0, 20)}..., defaulting to 5`);
        return 5;
      }
      console.log(`[CLOB] Market min_order_size for ${tokenId.substring(0, 20)}...: ${minSize}`);
      return minSize;
    } catch (error: any) {
      console.warn(`[CLOB] Could not fetch min_order_size for ${tokenId.substring(0, 20)}..., defaulting to 5:`, error.message);
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
        console.log(`[CLOB] Market info: tickSize=${tickSize}, negRisk=${negRisk}`);
      } catch (error: any) {
        console.warn(`[CLOB] Could not fetch market info for tokenID ${params.tokenID}, using defaults:`, error.message);
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
      // Ensure it's still between 0 and 1
      if (roundedPrice > 0 && roundedPrice <= 1) {
        if (Math.abs(roundedPrice - params.price) > 0.0001) {
          console.log(`[CLOB] Price rounded from ${params.price} to ${roundedPrice} to match tickSize ${tickSize}`);
        }
        finalPrice = roundedPrice;
      } else {
        console.warn(`[CLOB] Price rounding resulted in invalid value: ${roundedPrice}, using original: ${params.price}`);
      }
    }

    // Validate final price
    if (finalPrice <= 0 || finalPrice > 1) {
      throw new Error(`Invalid price after rounding: ${finalPrice} (original: ${params.price}, tickSize: ${tickSize})`);
    }

    // Place the order with proper error handling
    try {
      console.log(`[CLOB] Placing order: tokenID=${params.tokenID}, originalPrice=${params.price}, size=${params.size}, side=${params.side}, tickSize=${tickSize}`);
      
      
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
        console.error(`[CLOB] Client threw error:`, innerError.message);
        const responseData = innerError.response?.data;
        
        // DETAILED ERROR LOGGING FOR 400 ERRORS
        const status = innerError.response?.status;
        let enhancedError = innerError;
        
        if (status === 400) {
          console.error(`[CLOB] ===== 400 BAD REQUEST DETAILS =====`);
          console.error(`[CLOB] Response data:`, JSON.stringify(responseData, null, 2));
          console.error(`[CLOB] Request params: tokenID=${params.tokenID}, price=${params.price}, size=${params.size}, side=${params.side}`);
          console.error(`[CLOB] Options: tickSize=${tickSize}, negRisk=${negRisk}`);
          console.error(`[CLOB] ======================================`);
          
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
        console.error(`[DEBUG] VALIDATION FAILED: orderId="${orderId}", type=${typeof orderId}`);
        throw new Error(`CLOB response missing valid orderID. Got orderId="${orderId}". Full response: ${JSON.stringify(response)}`);
      }

      console.log(`[CLOB] Order placed successfully: orderID=${orderId}`);
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

      console.error(`[CLOB] Order failed:`, errorMessage);
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
      console.warn('[CLOB] Could not derive wallet address:', error.message);
    }
    
    return null;
  }

  /**
   * Get the funder address (proxy wallet) if configured
   * This is the address where Polymarket holds your funds
   */
  getFunderAddress(): string | null {
    // Check if POLYMARKET_FUNDER_ADDRESS is set
    const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS;
    if (funderAddress && funderAddress !== this.signer?.address) {
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
   * Get USDC (collateral) balance for the authenticated wallet
   * Uses Polymarket's internal balance, not raw on-chain USDC
   * This is the actual trading balance available on Polymarket
   */
  async getUsdcBalance(): Promise<number> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) {
      throw new Error('CLOB client not initialized');
    }

    try {
      // Get balance for COLLATERAL (USDC) asset type
      console.log(`[CLOB] Fetching USDC balance via getBalanceAllowance...`);
      const response = await (this.client as any).getBalanceAllowance({
        asset_type: 'COLLATERAL'
      });
      
      console.log(`[CLOB] getBalanceAllowance response:`, JSON.stringify(response));
      
      const balanceStr = response?.balance || '0';
      const balanceNum = parseFloat(balanceStr);
      console.log(`[DIAG] Raw balance response: ${JSON.stringify(response)}, parsed: ${balanceNum}`);

      // Determine if balance is in wei (large number) or already human-readable
      // USDC has 6 decimals, so $4.00 in wei = 4000000
      // If the number is > 1000, it's likely in wei format
      let balance: number;
      if (balanceNum > 1000) {
        // Balance is in wei (smallest unit), convert to USDC
        balance = balanceNum / 1_000_000;
        console.log(`[CLOB] Balance appears to be in wei format, converting: ${balanceStr} -> $${balance.toFixed(2)}`);
      } else {
        // Balance is already in human-readable USDC format
        balance = balanceNum;
        console.log(`[CLOB] Balance appears to be in USDC format: $${balance.toFixed(2)}`);
      }
      
      console.log(`[CLOB] USDC balance: $${balance.toFixed(2)}`);
      return balance;
    } catch (error: any) {
      console.error('[CLOB] Failed to get USDC balance:', error.message);
      console.error('[CLOB] Error details:', error);
      throw error;
    }
  }
}
