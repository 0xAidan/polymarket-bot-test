import axios, { AxiosInstance, AxiosError } from 'axios';
import { ethers } from 'ethers';
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
 * Rate limiting configuration
 */
const RATE_LIMIT = {
  requestsPerSecond: 5, // Conservative limit
  requestsPerMinute: 100,
  lastRequestTime: 0,
  requestCount: 0,
  windowStart: Date.now()
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
   * Rate limiting helper
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    
    // Reset counter if window expired
    if (now - RATE_LIMIT.windowStart > 60000) {
      RATE_LIMIT.requestCount = 0;
      RATE_LIMIT.windowStart = now;
    }
    
    // Check per-minute limit
    if (RATE_LIMIT.requestCount >= RATE_LIMIT.requestsPerMinute) {
      const waitTime = 60000 - (now - RATE_LIMIT.windowStart);
      if (waitTime > 0) {
        console.warn(`Rate limit: Waiting ${waitTime}ms before next request`);
        await sleep(waitTime);
        RATE_LIMIT.requestCount = 0;
        RATE_LIMIT.windowStart = Date.now();
      }
    }
    
    // Check per-second limit
    const timeSinceLastRequest = now - RATE_LIMIT.lastRequestTime;
    const minInterval = 1000 / RATE_LIMIT.requestsPerSecond;
    if (timeSinceLastRequest < minInterval) {
      await sleep(minInterval - timeSinceLastRequest);
    }
    
    RATE_LIMIT.lastRequestTime = Date.now();
    RATE_LIMIT.requestCount++;
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
        // Apply rate limiting
        await this.rateLimit();
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
   * Tries multiple endpoints as Polymarket API structure may vary
   */
  async getUserPositions(userAddress: string): Promise<any[]> {
    return this.retryRequest(async () => {
      const address = userAddress.toLowerCase();
      
      // Try multiple possible endpoints
      const endpoints = [
        `/users/${address}/positions`,
        `/users/${address}/positions/active`,
        `/positions?user=${address}`,
        `/user/${address}/positions`,
      ];

      for (const endpoint of endpoints) {
        try {
          const fullUrl = `${this.dataApiClient.defaults.baseURL}${endpoint}`;
          console.log(`[PolymarketAPI] Trying endpoint: ${fullUrl}`);
          
          const response = await this.dataApiClient.get(endpoint);
          let positions = response.data;
          
          // Log raw response for debugging (first 500 chars)
          if (positions) {
            const responseStr = JSON.stringify(positions).substring(0, 500);
            console.log(`[PolymarketAPI] Response from ${endpoint}: ${responseStr}...`);
          }
          
          // Handle different response structures
          if (Array.isArray(positions)) {
            console.log(`✓ Found positions via ${endpoint}: ${positions.length} positions`);
            return positions;
          } else if (positions?.positions && Array.isArray(positions.positions)) {
            console.log(`✓ Found positions via ${endpoint}: ${positions.positions.length} positions`);
            return positions.positions;
          } else if (positions?.data && Array.isArray(positions.data)) {
            console.log(`✓ Found positions via ${endpoint}: ${positions.data.length} positions`);
            return positions.data;
          } else if (positions?.results && Array.isArray(positions.results)) {
            console.log(`✓ Found positions via ${endpoint}: ${positions.results.length} positions`);
            return positions.results;
          } else if (positions && typeof positions === 'object') {
            // Single position object
            console.log(`✓ Found position via ${endpoint}`);
            return [positions];
          } else if (positions) {
            // Unknown structure, log it
            console.log(`⚠ Unexpected response structure from ${endpoint}:`, typeof positions);
          }
        } catch (error: any) {
          // Log detailed error info
          const status = error.response?.status;
          const statusText = error.response?.statusText;
          const errorData = error.response?.data;
          
          if (status === 404) {
            console.log(`✗ Endpoint ${endpoint} returned 404 (not found), trying next...`);
            continue;
          } else if (status === 403 || status === 401) {
            console.log(`✗ Endpoint ${endpoint} returned ${status} (auth required), trying alternatives...`);
            // Don't give up on auth errors - might work on different endpoint
            continue;
          } else {
            console.log(`✗ Endpoint ${endpoint} failed (${status || 'no status'}): ${error.message}`);
            if (errorData) {
              console.log(`  Error details:`, JSON.stringify(errorData).substring(0, 300));
            }
          }
          
          // Re-throw if all endpoints fail (but don't throw on 404)
          if (endpoint === endpoints[endpoints.length - 1] && status !== 404) {
            throw error;
          }
        }
      }
      
      // If all endpoints fail with 404, return empty array
      console.log(`✗ No positions found for ${address} on any endpoint`);
      return [];
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
   * Place an order via CLOB API
   * Note: Order placement is NOT retried to avoid duplicate orders
   * Uses rate limiting but no retries for order placement
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

    // Apply rate limiting
    await this.rateLimit();

    try {
      if (!this.signer) {
        throw new Error('Signer not initialized');
      }

      const makerAddress = await this.signer.getAddress();
      const nonce = orderParams.nonce || Date.now();
      
      // CLOB API typically requires signed orders
      // Polymarket uses EIP-712 typed data signing for orders
      // This is a simplified version - may need adjustment based on actual API
      const order = {
        token_id: orderParams.tokenId,
        side: orderParams.side.toLowerCase(),
        size: orderParams.size,
        price: orderParams.price,
        nonce: nonce.toString(),
        maker: makerAddress,
        expiration: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiration
      };

      // Sign the order
      // Note: Polymarket CLOB API requires EIP-712 signing, but the exact format
      // depends on their contract. For now, we use message signing as a fallback.
      // TODO: Consider using @polymarket/clob-client library for official support
      // which handles EIP-712 signing correctly
      let signature: string;
      try {
        // Try EIP-712 signing (ethers v6 syntax)
        // Note: This may need adjustment based on actual Polymarket contract structure
        // The signTypedData method should be available in ethers v6
        const domain = {
          name: 'Polymarket',
          version: '1',
          chainId: 137, // Polygon mainnet
          verifyingContract: '0x0000000000000000000000000000000000000000' // Placeholder - needs actual contract
        };

        const types = {
          Order: [
            { name: 'tokenId', type: 'string' },
            { name: 'side', type: 'string' },
            { name: 'size', type: 'string' },
            { name: 'price', type: 'string' },
            { name: 'nonce', type: 'string' },
            { name: 'maker', type: 'address' },
            { name: 'expiration', type: 'uint256' }
          ]
        };

        // In ethers v6, signTypedData should be available
        // If not available, this will fall back to message signing
        if (typeof (this.signer as any).signTypedData === 'function') {
          signature = await (this.signer as any).signTypedData(domain, types, order);
        } else {
          throw new Error('signTypedData not available, using message signing');
        }
      } catch (eip712Error: any) {
        // Fallback to simple message signing if EIP-712 fails
        console.warn('EIP-712 signing failed, using message signing:', eip712Error.message);
        const orderMessage = JSON.stringify(order);
        signature = await this.signer.signMessage(orderMessage);
      }
      
      const response = await this.clobApiClient.post('/orders', {
        ...order,
        signature,
        maker: makerAddress
      });

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
      
      console.error(errorMessage);
      if (error.response?.data) {
        console.error('Error details:', error.response.data);
      }
      
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
