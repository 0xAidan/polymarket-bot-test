import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import * as ethers from 'ethers';
import axios from 'axios';
import { config } from './config.js';

// Add axios interceptor to log all requests (for debugging Builder headers)
axios.interceptors.request.use((request) => {
  if (request.url?.includes('clob.polymarket.com') || request.url?.includes('order')) {
    console.log(`[AXIOS DEBUG] ===== OUTGOING REQUEST =====`);
    console.log(`[AXIOS DEBUG] URL: ${request.url}`);
    console.log(`[AXIOS DEBUG] Method: ${request.method}`);
    console.log(`[AXIOS DEBUG] Headers: ${JSON.stringify(request.headers, null, 2)}`);
    // Check for Builder headers specifically
    const builderHeaders = Object.keys(request.headers || {}).filter(h => h.toLowerCase().includes('poly') || h.toLowerCase().includes('builder'));
    console.log(`[AXIOS DEBUG] Builder-related headers found: ${builderHeaders.length > 0 ? builderHeaders.join(', ') : 'NONE!'}`);
    console.log(`[AXIOS DEBUG] ================================`);
  }
  return request;
}, (error) => {
  return Promise.reject(error);
});

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
      
      console.log(`[DEBUG] CLOB Host: ${HOST}`);
      
      // Create wallet signer using ethers v5 (required by @polymarket/clob-client)
      const provider = new (ethers as any).providers.JsonRpcProvider(config.polygonRpcUrl);
      this.signer = new ethers.Wallet(config.privateKey, provider);
      
      console.log(`[DEBUG] Wallet address (EOA): ${this.signer.address}`);
      console.log(`[DEBUG] About to call createOrDeriveApiKey...`);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clobClient.ts:init',message:'CLOB init start',data:{host:HOST,walletAddress:this.signer.address},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'F,G'})}).catch(()=>{});
      // #endregion

      // Create temporary client to derive User API credentials
      const tempClient = new ClobClient(HOST, CHAIN_ID, this.signer);
      let apiCreds;
      try {
        apiCreds = await tempClient.createOrDeriveApiKey();
        console.log('✓ Derived User API credentials for L2 authentication');
        // The CLOB client returns credentials with properties: key, secret, passphrase
        console.log(`[DEBUG] API Creds received: ${JSON.stringify({hasKey: !!(apiCreds as any)?.key, hasSecret: !!(apiCreds as any)?.secret, hasPassphrase: !!(apiCreds as any)?.passphrase})}`);
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

      // Determine signature type (0 = EOA, 1 = Magic Link proxy, 2 = Gnosis Safe)
      // NOTE: If your Polymarket account was created via email/Magic Link, use 1
      // If you connected via MetaMask/WalletConnect directly, use 0
      // Check your account setup at https://polymarket.com/settings
      const signatureType = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0', 10);
      
      // Funder address - for EOA (type 0), this is the wallet address
      // For proxy wallet (type 1), this should be the proxy wallet address
      const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || this.signer.address;
      
      console.log(`[DEBUG] Signature Type: ${signatureType} (0=EOA, 1=MagicLink/Proxy, 2=GnosisSafe)`);
      console.log(`[DEBUG] Funder Address: ${funderAddress}`);
      console.log(`[DEBUG] Signer Address: ${this.signer.address}`);

      // Create BuilderConfig with Builder API credentials (REQUIRED for authenticated trading)
      // Without this, requests get blocked by Cloudflare as unauthorized bot traffic
      let builderConfig: BuilderConfig | undefined;
      
      // DEBUG: Log builder credential presence
      console.log(`[DEBUG] Checking builder credentials...`);
      console.log(`[DEBUG] POLYMARKET_BUILDER_API_KEY present: ${!!config.polymarketBuilderApiKey} (length: ${config.polymarketBuilderApiKey?.length || 0})`);
      console.log(`[DEBUG] POLYMARKET_BUILDER_SECRET present: ${!!config.polymarketBuilderSecret} (length: ${config.polymarketBuilderSecret?.length || 0})`);
      console.log(`[DEBUG] POLYMARKET_BUILDER_PASSPHRASE present: ${!!config.polymarketBuilderPassphrase} (length: ${config.polymarketBuilderPassphrase?.length || 0})`);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clobClient.ts:builderCredCheck',message:'Builder credentials check',data:{hasKey:!!config.polymarketBuilderApiKey,keyLength:config.polymarketBuilderApiKey?.length||0,hasSecret:!!config.polymarketBuilderSecret,secretLength:config.polymarketBuilderSecret?.length||0,hasPassphrase:!!config.polymarketBuilderPassphrase,passphraseLength:config.polymarketBuilderPassphrase?.length||0,signatureType},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B,C'})}).catch(()=>{});
      // #endregion
      
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
        console.log(`[DEBUG] BuilderConfig created successfully`);
        // Log partial credentials for debugging (first 8 chars only for security)
        console.log(`[DEBUG] Builder API Key starts with: ${config.polymarketBuilderApiKey.substring(0, 8)}...`);
        console.log(`[DEBUG] Builder Secret length: ${config.polymarketBuilderSecret.length} chars`);
        console.log(`[DEBUG] Builder Passphrase length: ${config.polymarketBuilderPassphrase.length} chars`);
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
      console.log(`   Wallet: ${this.signer.address}`);
      console.log(`   Funder: ${funderAddress}`);
      console.log(`   Builder Auth: ${builderConfig ? 'ENABLED' : 'DISABLED'}`);
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
      } catch (error: any) {
        console.warn('Could not fetch market info, using defaults:', error.message);
        tickSize = tickSize || '0.01';
        negRisk = negRisk !== undefined ? negRisk : false;
      }
    }

    // Place the order with proper error handling
    try {
      console.log(`[CLOB] Placing order: tokenID=${params.tokenID}, price=${params.price}, size=${params.size}, side=${params.side}`);
      
      // DEBUG: Log builder config status
      console.log(`[DEBUG] Builder credentials configured: key=${!!config.polymarketBuilderApiKey}, secret=${!!config.polymarketBuilderSecret}, passphrase=${!!config.polymarketBuilderPassphrase}`);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clobClient.ts:createAndPostOrder',message:'Placing order',data:{tokenID:params.tokenID,price:params.price,size:params.size,side:params.side,tickSize,negRisk,clobUrl:config.polymarketClobApiUrl},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B'})}).catch(()=>{});
      // #endregion
      
      let response: any;
      // #region agent log
      const orderStartTime = Date.now();
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clobClient.ts:preOrder',message:'About to call createAndPostOrder',data:{tokenID:params.tokenID,price:params.price,size:params.size,side:params.side,tickSize,negRisk,clobUrl:config.polymarketClobApiUrl||'default'},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B,C,D'})}).catch(()=>{});
      // #endregion
      try {
        response = await this.client.createAndPostOrder(
          {
            tokenID: params.tokenID,
            price: params.price,
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
        const errorDuration = Date.now() - orderStartTime;
        // Check if this is a Cloudflare block
        const isCloudflareBlock = innerError.message?.includes('403') || innerError.message?.includes('Cloudflare') || innerError.message?.includes('blocked');
        const responseData = innerError.response?.data;
        const isHtmlResponse = typeof responseData === 'string' && (responseData.includes('<!DOCTYPE') || responseData.includes('Cloudflare'));
        
        // DETAILED ERROR LOGGING FOR 400 ERRORS
        const status = innerError.response?.status;
        if (status === 400) {
          console.error(`[CLOB] ===== 400 BAD REQUEST DETAILS =====`);
          console.error(`[CLOB] Response data:`, JSON.stringify(responseData, null, 2));
          console.error(`[CLOB] Request params: tokenID=${params.tokenID}, price=${params.price}, size=${params.size}, side=${params.side}`);
          console.error(`[CLOB] Options: tickSize=${tickSize}, negRisk=${negRisk}`);
          console.error(`[CLOB] ======================================`);
        }
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clobClient.ts:createAndPostOrder:catch',message:'CLOB client error',data:{errorMsg:innerError.message,errorCode:innerError.code,responseStatus:status,responseData:typeof responseData==='object'?responseData:responseData?.slice?.(0,500),isCloudflareBlock,isHtmlResponse,errorDuration,requestParams:{tokenID:params.tokenID,price:params.price,size:params.size,side:params.side,tickSize,negRisk}},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B,C,D'})}).catch(()=>{});
        // #endregion
        throw innerError;
      }

      // DEBUG: Log the EXACT response for diagnosis
      console.log(`[DEBUG] CLOB response type: ${typeof response}`);
      console.log(`[DEBUG] CLOB response isNull: ${response === null}`);
      console.log(`[DEBUG] CLOB response isUndefined: ${response === undefined}`);
      if (response && typeof response === 'object') {
        console.log(`[DEBUG] CLOB response keys: ${Object.keys(response).join(', ')}`);
        console.log(`[DEBUG] CLOB response.orderID: ${response.orderID} (type: ${typeof response.orderID})`);
        console.log(`[DEBUG] CLOB response.status: ${response.status} (type: ${typeof response.status})`);
        console.log(`[DEBUG] CLOB response.error: ${response.error}`);
      }
      console.log(`[DEBUG] Full CLOB response: ${JSON.stringify(response)}`);

      // CRITICAL: Check for HTTP error status FIRST (handles both string and number)
      const statusCode = response?.status;
      if (statusCode !== undefined && statusCode !== null) {
        const numericStatus = typeof statusCode === 'string' ? parseInt(statusCode, 10) : statusCode;
        if (!isNaN(numericStatus) && numericStatus >= 400) {
          throw new Error(`CLOB API returned HTTP error ${numericStatus} - request was rejected`);
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
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clobClient.ts:createAndPostOrder:success',message:'Order placed successfully',data:{orderId,responseKeys:response?Object.keys(response):[],status:response?.status},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B'})}).catch(()=>{});
      // #endregion
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
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clobClient.ts:createAndPostOrder:finalError',message:'Order failed - final error',data:{errorMessage,hasResponse:!!error.response,responseStatus:error.response?.status},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B,C'})}).catch(()=>{});
      // #endregion
      throw new Error(`Failed to place order: ${errorMessage}`);
    }
  }

  /**
   * Get the wallet address
   */
  getWalletAddress(): string | null {
    return this.signer?.address || null;
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
}
