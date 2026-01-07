import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { config } from './config.js';
import { DetectedTrade } from './types.js';

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
    this.dataApiClient = axios.create({
      baseURL: config.polymarketDataApiUrl,
      headers: {
        'Content-Type': 'application/json',
      }
    });

    this.clobApiClient = axios.create({
      baseURL: config.polymarketClobApiUrl,
      headers: {
        'Content-Type': 'application/json',
      }
    });

    this.gammaApiClient = axios.create({
      baseURL: config.polymarketGammaApiUrl,
      headers: {
        'Content-Type': 'application/json',
      }
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
   * Get user positions from Data API
   * This helps us detect new trades by comparing position changes
   */
  async getUserPositions(userAddress: string): Promise<any[]> {
    try {
      const response = await this.dataApiClient.get(`/users/${userAddress.toLowerCase()}/positions`);
      return response.data || [];
    } catch (error: any) {
      if (error.response?.status === 404) {
        // User has no positions
        return [];
      }
      console.error(`Failed to get positions for ${userAddress}:`, error.message);
      throw error;
    }
  }

  /**
   * Get user's trade history
   */
  async getUserTrades(userAddress: string, limit = 50): Promise<any[]> {
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
      console.error(`Failed to get trades for ${userAddress}:`, error.message);
      throw error;
    }
  }

  /**
   * Get market information from Gamma API
   */
  async getMarket(marketId: string): Promise<any> {
    try {
      const response = await this.gammaApiClient.get(`/markets/${marketId}`);
      return response.data;
    } catch (error: any) {
      console.error(`Failed to get market ${marketId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get order book for a market from CLOB API
   */
  async getOrderBook(tokenId: string): Promise<any> {
    try {
      const response = await this.clobApiClient.get(`/book`, {
        params: { token_id: tokenId }
      });
      return response.data;
    } catch (error: any) {
      console.error(`Failed to get order book for ${tokenId}:`, error.message);
      throw error;
    }
  }

  /**
   * Place an order via CLOB API
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
      // CLOB API typically requires signed orders
      // This is a simplified version - actual implementation may need more fields
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

      // Sign the order (Polymarket CLOB may require EIP-712 signing)
      const orderMessage = JSON.stringify(order);
      const signature = await this.signer.signMessage(orderMessage);
      
      const response = await this.clobApiClient.post('/orders', {
        ...order,
        signature,
        maker: await this.signer.getAddress()
      });

      return response.data;
    } catch (error: any) {
      console.error('Failed to place order:', error.message);
      if (error.response?.data) {
        console.error('Error details:', error.response.data);
      }
      throw error;
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
