import axios, { AxiosInstance, AxiosError } from 'axios';
import { ethers } from 'ethers';
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

    const provider = new ethers.JsonRpcProvider(config.polygonRpcUrl);
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
   */
  async getProxyWalletAddress(eoaAddress?: string): Promise<string | null> {
    if (!this.signer) {
      await this.initialize();
    }

    const address = eoaAddress || this.signer?.address;
    if (!address) {
      return null;
    }

    try {
      // Try to get proxy wallet from public profile
      // Polymarket Data API endpoint: GET /public-profile?address={address}
      const response = await this.retryRequest(async () => {
        return await this.dataApiClient.get('/public-profile', {
          params: { address: address.toLowerCase() }
        });
      }, `getProxyWalletAddress(${address.substring(0, 8)}...)`);
      
      if (response.data?.proxyWallet) {
        console.log(`[API] Found proxy wallet: ${response.data.proxyWallet} for EOA: ${address}`);
        return response.data.proxyWallet;
      }
      
      // If no proxy wallet found, the EOA might be used directly
      console.log(`[API] No proxy wallet found for ${address}, using EOA directly`);
      return null;
    } catch (error: any) {
      // If API doesn't support this endpoint or returns error, return null
      // This is not critical - we can still check the EOA balance
      if (error.response?.status !== 404) {
        console.warn(`[API] Could not fetch proxy wallet for ${address}:`, error.message);
      }
      return null;
    }
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
   */
  async getUserPositions(userAddress: string): Promise<any[]> {
    return this.retryRequest(async () => {
      try {
        const response = await this.dataApiClient.get(`/users/${userAddress.toLowerCase()}/positions`);
        return response.data || [];
      } catch (error: any) {
        if (error.response?.status === 404) {
          // User has no positions
          return [];
        }
        // Re-throw to trigger retry logic
        throw error;
      }
    }, `getUserPositions(${userAddress.substring(0, 8)}...)`);
  }

  /**
   * Get user's trade history
   */
  async getUserTrades(userAddress: string, limit = 50): Promise<any[]> {
    return this.retryRequest(async () => {
      try {
        const response = await this.dataApiClient.get(
          `/users/${userAddress.toLowerCase()}/trades`,
          { params: { limit } }
        );
        return response.data || [];
      } catch (error: any) {
        if (error.response?.status === 404) {
          return [];
        }
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
