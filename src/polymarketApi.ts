import axios, { AxiosInstance, AxiosError } from 'axios';
import * as ethers from 'ethers';
import crypto from 'crypto';
import { config } from './config.js';
import { DetectedTrade } from './types.js';

/**
 * Retry configuration for API requests
 */
const RETRY_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 1000, // Start with 1 second
  retryableStatusCodes: [429, 500, 502, 503, 504], // Rate limit and server errors
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']
};

/**
 * Sleep helper for retries
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable
 */
function isRetryableError(error: any): boolean {
  if (error.response) {
    // HTTP error response
    return RETRY_CONFIG.retryableStatusCodes.includes(error.response.status);
  }
  if (error.code) {
    // Network error
    return RETRY_CONFIG.retryableErrors.includes(error.code);
  }
  return false;
}

/**
 * Polymarket API client
 * Handles authentication and API interactions
 */
export class PolymarketApi {
  private dataApiClient: AxiosInstance;
  private clobApiClient: AxiosInstance;
  private gammaApiClient: AxiosInstance;
  private signer: ethers.Wallet | null = null;
  private authToken: string | null = null;

  constructor() {
    // Configure with timeouts and retry logic
    const axiosConfig = {
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json',
      }
    };

    this.dataApiClient = axios.create({
      ...axiosConfig,
      baseURL: config.polymarketDataApiUrl,
    });

    this.clobApiClient = axios.create({
      ...axiosConfig,
      baseURL: config.polymarketClobApiUrl,
    });

    this.gammaApiClient = axios.create({
      ...axiosConfig,
      baseURL: config.polymarketGammaApiUrl,
    });
  }

  /**
   * Initialize wallet signer for authentication
   */
  async initialize(): Promise<void> {
    if (!config.privateKey) {
      throw new Error('Private key not configured');
    }

    const provider = new (ethers as any).providers.JsonRpcProvider(config.polygonRpcUrl);
    this.signer = new ethers.Wallet(config.privateKey, provider);
    
    // Store wallet address in config for easy access
    config.userWalletAddress = this.signer.address;
    
    // Authenticate if required by API
    await this.authenticate();
  }

  /**
   * Get the wallet address being used for trades
   */
  getWalletAddress(): string | null {
    if (!this.signer) {
      return null;
    }
    return this.signer.address;
  }

  /**
   * Get the proxy wallet address from Polymarket
   * Polymarket uses proxy wallets for trading, which is where funds are actually held
   * 
   * FIXED: Extract proxy wallet from positions API response instead of unreliable Dome API
   * The positions API returns proxyWallet field in each position object.
   */
  async getProxyWalletAddress(eoaAddress?: string): Promise<string | null> {
    if (!this.signer) {
      await this.initialize();
    }

    const address = eoaAddress || this.signer?.address;
    if (!address) {
      return null;
    }

    // Known proxy wallet mapping (fallback if API fails)
    const knownProxyWallets: Record<string, string> = {
      '0x2d43e332af357cab0fa1b2692e1e0fdb0b733010': '0xd56276b120ad094ba9f429386427f2492233b6d1'
    };
    
    const normalizedEoa = address.toLowerCase();
    if (knownProxyWallets[normalizedEoa]) {
      console.log(`[API] Using known proxy wallet mapping: ${knownProxyWallets[normalizedEoa]} for EOA: ${address}`);
      return knownProxyWallets[normalizedEoa];
    }

    // PRIMARY METHOD: Extract proxy wallet from positions API response
    // The positions API returns proxyWallet field in each position
    try {
      console.log(`[API] Attempting to extract proxy wallet from positions for ${address.substring(0, 8)}...`);
      const positions = await this.getUserPositions(address);
      
      if (positions && positions.length > 0 && positions[0].proxyWallet) {
        const proxyWallet = positions[0].proxyWallet;
        console.log(`[API] ✓ Found proxy wallet from positions: ${proxyWallet} for EOA: ${address.substring(0, 8)}...`);
        return proxyWallet;
      }
      
      console.log(`[API] No positions or no proxyWallet field found for ${address.substring(0, 8)}...`);
    } catch (positionsError: any) {
      console.warn(`[API] Failed to get positions for proxy wallet lookup:`, positionsError.message);
    }

    // FALLBACK: Try Dome API (but it often fails with 403)
    try {
      console.log(`[API] Fallback: Attempting Dome API for ${address.substring(0, 8)}...`);
      const domeResponse = await this.retryRequest(async () => {
        return await axios.get('https://api.domeapi.io/v1/polymarket/wallet', {
          params: { eoa: address.toLowerCase() },
          timeout: 10000
        });
      }, `getProxyWalletAddress-Dome(${address.substring(0, 8)}...)`);
      
      if (domeResponse.data?.proxyWallet || domeResponse.data?.proxy) {
        const proxyWallet = domeResponse.data.proxyWallet || domeResponse.data.proxy;
        console.log(`[API] ✓ Found proxy wallet via Dome API: ${proxyWallet} for EOA: ${address.substring(0, 8)}...`);
        return proxyWallet;
      }
    } catch (domeError: any) {
      // Dome API often fails with 403, this is expected
      console.log(`[API] Dome API unavailable for ${address.substring(0, 8)}... (this is normal)`);
    }
    
    // No proxy wallet found - the EOA will be used directly with the Data API
    // Note: Polymarket Data API works with EOA addresses directly
    console.log(`[API] No proxy wallet found for ${address.substring(0, 8)}..., using EOA directly (this is OK)`);
    return null;
  }

  /**
   * Authenticate with Polymarket API
   * Polymarket may use wallet signature authentication
   */
  async authenticate(): Promise<void> {
    if (!this.signer) {
      await this.initialize();
    }

    try {
      // Polymarket typically uses wallet signature authentication
      if (!this.signer) {
        throw new Error('Signer not initialized');
      }

      // Create a message to sign
      const message = `Sign in to Polymarket\nTimestamp: ${Date.now()}`;
      
      // Sign the message
      const signature = await this.signer.signMessage(message);
      const address = await this.signer.getAddress();

      // Try to authenticate (this endpoint may vary based on actual API)
      try {
        const response = await this.dataApiClient.post('/auth', {
          address,
          message,
          signature
        });

        if (response.data.token) {
          this.authToken = response.data.token;
          this.setAuthHeaders();
        }
      } catch (error: any) {
        // If auth endpoint doesn't exist or API key is used instead
        if (config.polymarketApiKey) {
          this.setApiKeyHeaders();
        } else {
          console.warn('Authentication endpoint not available, using public API');
        }
      }
    } catch (error: any) {
      console.warn('Authentication failed, continuing with public endpoints:', error.message);
    }
  }

  /**
   * Set authentication headers for API requests
   */
  private setAuthHeaders(): void {
    if (this.authToken) {
      this.dataApiClient.defaults.headers['Authorization'] = `Bearer ${this.authToken}`;
      this.clobApiClient.defaults.headers['Authorization'] = `Bearer ${this.authToken}`;
      this.gammaApiClient.defaults.headers['Authorization'] = `Bearer ${this.authToken}`;
    }
  }

  /**
   * Set API key headers if provided
   */
  private setApiKeyHeaders(): void {
    if (config.polymarketApiKey) {
      this.dataApiClient.defaults.headers['X-API-Key'] = config.polymarketApiKey;
      this.clobApiClient.defaults.headers['X-API-Key'] = config.polymarketApiKey;
      this.gammaApiClient.defaults.headers['X-API-Key'] = config.polymarketApiKey;
    }
  }

  /**
   * Retry wrapper for API requests
   */
  private async retryRequest<T>(
    requestFn: () => Promise<T>,
    operation: string,
    retries = RETRY_CONFIG.maxRetries
  ): Promise<T> {
    let lastError: any;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await requestFn();
      } catch (error: any) {
        lastError = error;
        
        // Don't retry on last attempt or if error is not retryable
        if (attempt === retries || !isRetryableError(error)) {
          throw error;
        }
        
        // Calculate exponential backoff delay
        const delay = RETRY_CONFIG.retryDelayMs * Math.pow(2, attempt);
        console.warn(`${operation} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms...`, error.message);
        await sleep(delay);
      }
    }
    
    throw lastError;
  }

  /**
   * Get user positions from Data API
   * This helps us detect new trades by comparing position changes
   * 
   * Polymarket Data API returns positions with these fields:
   * - asset: token ID (use this as the unique identifier)
   * - conditionId: market ID
   * - size: position size
   * - avgPrice: average entry price
   * - curPrice: current market price
   * - outcome: "Yes" or "No"
   * - outcomeIndex: 0=Yes, 1=No
   * - proxyWallet: proxy wallet address (can be used to find proxy)
   * - title: market title
   * - slug: market slug
   */
  async getUserPositions(userAddress: string): Promise<any[]> {
    return this.retryRequest(async () => {
      try {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'polymarketApi.ts:getUserPositions',message:'API call start',data:{userAddress:userAddress.substring(0,8),apiUrl:this.dataApiClient.defaults.baseURL},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        // Polymarket Data API uses: GET /positions?user={proxyWalletAddress}
        // CRITICAL FIX: Whale wallets can have 200+ positions, default limit is 100
        // Must request more to see all positions and detect trades on any market
        const response = await this.dataApiClient.get('/positions', {
          params: { 
            user: userAddress.toLowerCase(),
            limit: 500  // Fetch up to 500 positions to handle whale wallets
          }
        });
        
        const positions = response.data || [];
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'polymarketApi.ts:getUserPositions',message:'API call success',data:{userAddress:userAddress.substring(0,8),positionCount:positions.length,firstPositionFields:positions[0]?Object.keys(positions[0]):[],firstPositionSample:positions[0]?JSON.stringify(positions[0]).substring(0,500):null},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        // DEBUG: Log first position structure on first successful fetch
        if (positions.length > 0) {
          console.log(`[API] ✓ Fetched ${positions.length} position(s) for ${userAddress.substring(0, 8)}...`);
          // Log available fields to help with debugging field name issues
          const samplePos = positions[0];
          console.log(`[API] Position fields available: ${Object.keys(samplePos).join(', ')}`);
        } else {
          console.log(`[API] No positions found for ${userAddress.substring(0, 8)}...`);
        }
        
        return positions;
      } catch (error: any) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'polymarketApi.ts:getUserPositions',message:'API call error',data:{userAddress:userAddress.substring(0,8),errorMsg:error.message,errorStatus:error.response?.status,errorData:error.response?.data?JSON.stringify(error.response.data).substring(0,500):null},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        if (error.response?.status === 404) {
          // User has no positions
          console.log(`[API] No positions found for ${userAddress.substring(0, 8)}... (404)`);
          return [];
        }
        // Log error for debugging
        console.warn(`[API] Error fetching positions for ${userAddress.substring(0, 8)}...:`, error.message);
        // Re-throw to trigger retry logic
        throw error;
      }
    }, `getUserPositions(${userAddress.substring(0, 8)}...)`);
  }

  /**
   * Get user's trade history from Polymarket Data API
   * Uses the correct endpoint: GET /trades?user={proxyWalletAddress}
   * 
   * Polymarket Data API returns trades with these fields:
   * - asset: token ID
   * - conditionId: market ID  
   * - side: "BUY" or "SELL"
   * - size: trade size
   * - price: trade price
   * - timestamp: ISO timestamp
   * - outcome: "Yes" or "No"
   * - outcomeIndex: 0=Yes, 1=No
   * - transactionHash: optional tx hash
   */
  async getUserTrades(userAddress: string, limit = 50): Promise<any[]> {
    return this.retryRequest(async () => {
      try {
        // Try the /activity endpoint first as it may be more real-time than /trades
        // /activity?user={address}&type=TRADE returns more recent data
        const response = await this.dataApiClient.get('/activity', {
          params: { 
            user: userAddress.toLowerCase(),
            type: 'TRADE',
            limit,
            sortBy: 'TIMESTAMP',
            sortDirection: 'DESC',
            _t: Date.now() // Cache buster
          },
          headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          }
        });
        
        const trades = response.data || [];
        
        // DEBUG: Log first trade structure to help with field name issues
        if (trades.length > 0) {
          console.log(`[API] ✓ Fetched ${trades.length} trade(s) for ${userAddress.substring(0, 8)}...`);
          const sampleTrade = trades[0];
          console.log(`[API] Trade fields available: ${Object.keys(sampleTrade).join(', ')}`);
          // #region agent log
          // CRITICAL: Log the MOST RECENT trade timestamp to see if API returns fresh data
          // FIXED: Handle Unix seconds timestamps from Polymarket API
          const mostRecentTradeTimeRaw = trades[0]?.timestamp;
          const mostRecentTradeTimeMs = typeof mostRecentTradeTimeRaw === 'number' 
            ? (mostRecentTradeTimeRaw < 1e12 ? mostRecentTradeTimeRaw * 1000 : mostRecentTradeTimeRaw)
            : new Date(mostRecentTradeTimeRaw).getTime();
          const mostRecentAgeSeconds = mostRecentTradeTimeRaw ? Math.round((Date.now() - mostRecentTradeTimeMs) / 1000) : -1;
          fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'polymarketApi.ts:getUserTrades',message:'TRADES FROM API - checking freshness',data:{userAddress:userAddress.substring(0,8),tradeCount:trades.length,mostRecentTradeTimestampRaw:mostRecentTradeTimeRaw,mostRecentTradeTimestampMs:mostRecentTradeTimeMs,mostRecentAgeSeconds:mostRecentAgeSeconds,nowIso:new Date().toISOString(),mostRecentTradeIso:mostRecentTradeTimeMs>0?new Date(mostRecentTradeTimeMs).toISOString():'none',first5Trades:trades.slice(0,5).map((t:any)=>{const ts=typeof t.timestamp==='number'?(t.timestamp<1e12?t.timestamp*1000:t.timestamp):new Date(t.timestamp).getTime();return{timestampRaw:t.timestamp,timestampMs:ts,ageSeconds:Math.round((Date.now()-ts)/1000),txHash:t.transactionHash||'none',side:t.side,size:t.size,price:t.price,conditionId:t.conditionId?.substring(0,15)||'none'};})},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B'})}).catch(()=>{});
          // #endregion
        } else {
          console.log(`[API] No trades found for ${userAddress.substring(0, 8)}...`);
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/2ec20c9e-d2d7-47da-832d-03660ee4883b',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'polymarketApi.ts:getUserTrades',message:'NO TRADES found for wallet',data:{userAddress:userAddress.substring(0,8),tradeCount:0},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
        }
        
        return trades;
      } catch (error: any) {
        if (error.response?.status === 404) {
          console.log(`[API] No trades found for ${userAddress.substring(0, 8)}... (404)`);
          return [];
        }
        console.warn(`[API] Error fetching trades for ${userAddress.substring(0, 8)}...:`, error.message);
        throw error;
      }
    }, `getUserTrades(${userAddress.substring(0, 8)}...)`);
  }

  /**
   * Get market information from Gamma API
   */
  async getMarket(marketId: string): Promise<any> {
    return this.retryRequest(async () => {
      const response = await this.gammaApiClient.get(`/markets/${marketId}`);
      return response.data;
    }, `getMarket(${marketId})`);
  }

  /**
   * Get order book for a market from CLOB API
   */
  async getOrderBook(tokenId: string): Promise<any> {
    return this.retryRequest(async () => {
      const response = await this.clobApiClient.get(`/book`, {
        params: { token_id: tokenId }
      });
      return response.data;
    }, `getOrderBook(${tokenId.substring(0, 20)}...)`);
  }

  /**
   * Generate HMAC signature for Builder API authentication
   */
  private generateBuilderSignature(
    timestamp: string,
    method: string,
    path: string,
    body: string = ''
  ): string {
    if (!config.polymarketBuilderSecret) {
      throw new Error('Builder API secret not configured');
    }

    // Create the message to sign: timestamp + method + path + body
    const message = timestamp + method.toUpperCase() + path + body;
    
    // Create HMAC signature using the secret
    const signature = crypto
      .createHmac('sha256', Buffer.from(config.polymarketBuilderSecret, 'base64'))
      .update(message)
      .digest('base64');

    return signature;
  }

  /**
   * Get Builder API authentication headers
   */
  private getBuilderAuthHeaders(method: string, path: string, body: string = ''): Record<string, string> {
    if (!config.polymarketBuilderApiKey || !config.polymarketBuilderSecret || !config.polymarketBuilderPassphrase) {
      throw new Error('Builder API credentials not configured. Please set POLYMARKET_BUILDER_API_KEY, POLYMARKET_BUILDER_SECRET, and POLYMARKET_BUILDER_PASSPHRASE in your .env file.');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.generateBuilderSignature(timestamp, method, path, body);

    return {
      'POLY_BUILDER_API_KEY': config.polymarketBuilderApiKey,
      'POLY_BUILDER_TIMESTAMP': timestamp,
      'POLY_BUILDER_PASSPHRASE': config.polymarketBuilderPassphrase,
      'POLY_BUILDER_SIGNATURE': signature,
    };
  }

  /**
   * Place an order via CLOB API
   * Note: Order placement is NOT retried to avoid duplicate orders
   */
  async placeOrder(orderParams: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    size: string;
    price: string;
    nonce?: number;
  }): Promise<any> {
    if (!this.signer) {
      await this.initialize();
    }

    try {
      // Validate Builder API credentials
      if (!config.polymarketBuilderApiKey || !config.polymarketBuilderSecret || !config.polymarketBuilderPassphrase) {
        throw new Error('Builder API credentials not configured. Trading requires POLYMARKET_BUILDER_API_KEY, POLYMARKET_BUILDER_SECRET, and POLYMARKET_BUILDER_PASSPHRASE.');
      }

      // CLOB API order format
      const order = {
        token_id: orderParams.tokenId,
        side: orderParams.side.toLowerCase(),
        size: orderParams.size,
        price: orderParams.price,
        nonce: orderParams.nonce || Date.now(),
      };

      if (!this.signer) {
        throw new Error('Signer not initialized');
      }

      // Prepare request body
      const requestBody = JSON.stringify(order);
      // Try both endpoints - /order (singular) is the correct one based on docs
      const path = '/order';
      
      // Get Builder API authentication headers
      const authHeaders = this.getBuilderAuthHeaders('POST', path, requestBody);
      
      console.log(`Placing order with Builder API authentication...`);
      console.log(`Order details:`, JSON.stringify(order, null, 2));
      console.log(`Using endpoint: ${path}`);
      console.log(`Builder API Key: ${config.polymarketBuilderApiKey.substring(0, 10)}...`);
      
      // Make the request with Builder API headers
      const response = await this.clobApiClient.post(path, order, {
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        }
      });

      console.log(`Order placed successfully! Response:`, JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error: any) {
      // Provide more detailed error information
      let errorMessage = 'Failed to place order';
      
      if (error.response) {
        // HTTP error response
        const status = error.response.status;
        const data = error.response.data;
        
        if (status === 400) {
          errorMessage = `Invalid order: ${data?.message || JSON.stringify(data)}`;
        } else if (status === 401 || status === 403) {
          errorMessage = `Authentication failed: ${data?.message || 'Invalid credentials'}`;
        } else if (status === 429) {
          errorMessage = `Rate limited: ${data?.message || 'Too many requests'}`;
        } else if (status >= 500) {
          errorMessage = `Server error (${status}): ${data?.message || 'Internal server error'}`;
        } else {
          errorMessage = `HTTP ${status}: ${data?.message || JSON.stringify(data)}`;
        }
      } else if (error.request) {
        // Request made but no response
        errorMessage = `Network error: No response from server (${error.code || 'unknown'})`;
      } else {
        errorMessage = error.message || 'Unknown error';
      }
      
      console.error('❌ Order placement failed!');
      console.error(`Error: ${errorMessage}`);
      console.error(`Status: ${error.response?.status || 'N/A'}`);
      if (error.response?.data) {
        console.error('Full error response:', JSON.stringify(error.response.data, null, 2));
      }
      if (error.response?.headers) {
        console.error('Response headers:', JSON.stringify(error.response.headers, null, 2));
      }
      // Note: order and authHeaders may be out of scope here, so we log what we can
      console.error('Request that failed:', {
        url: `${this.clobApiClient.defaults.baseURL}/order`,
        method: 'POST'
      });
      
      // Create a more informative error
      const enhancedError = new Error(errorMessage);
      (enhancedError as any).originalError = error;
      (enhancedError as any).response = error.response;
      throw enhancedError;
    }
  }

  /**
   * Get client instances for direct access if needed
   */
  getDataApiClient(): AxiosInstance {
    return this.dataApiClient;
  }

  getClobApiClient(): AxiosInstance {
    return this.clobApiClient;
  }

  getGammaApiClient(): AxiosInstance {
    return this.gammaApiClient;
  }

  getSigner(): ethers.Wallet | null {
    return this.signer;
  }
}
