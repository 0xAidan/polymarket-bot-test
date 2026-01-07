import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
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
   * Initialize the CLOB client with User API credentials
   */
  async initialize(): Promise<void> {
    if (this.isInitialized && this.client) {
      return;
    }

    if (!config.privateKey) {
      throw new Error('Private key not configured');
    }

    try {
      const HOST = config.polymarketClobApiUrl;
      const CHAIN_ID = 137; // Polygon mainnet
      
      // Create wallet signer using ethers v5 (required by @polymarket/clob-client)
      const provider = new (ethers as any).providers.JsonRpcProvider(config.polygonRpcUrl);
      this.signer = new ethers.Wallet(config.privateKey, provider);

      // Create temporary client to derive User API credentials
      const tempClient = new ClobClient(HOST, CHAIN_ID, this.signer);
      const apiCreds = await tempClient.createOrDeriveApiKey();

      console.log('✓ Derived User API credentials for L2 authentication');

      // Determine signature type (0 = EOA, 1 = Magic Link proxy, 2 = Gnosis Safe)
      // For EOA wallets, use 0
      const signatureType = 0;
      
      // For EOA wallets, funder is the wallet address itself
      const funderAddress = this.signer.address;

      // Initialize the trading client with User API credentials
      this.client = new ClobClient(
        HOST,
        CHAIN_ID,
        this.signer,
        apiCreds,
        signatureType,
        funderAddress
      );

      // Optionally add Builder API credentials for order attribution (optional)
      // Note: Builder credentials are handled separately and are optional
      if (config.polymarketBuilderApiKey && 
          config.polymarketBuilderSecret && 
          config.polymarketBuilderPassphrase) {
        console.log('✓ Builder API credentials configured for order attribution');
      } else {
        console.log('ℹ️  Builder API credentials not configured (optional - only for attribution)');
      }

      this.isInitialized = true;
      console.log('✓ CLOB client initialized successfully');
      console.log(`   Wallet: ${this.signer.address}`);
      console.log(`   Funder: ${funderAddress}`);
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
      
      const response = await this.client.createAndPostOrder(
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

      // Log full response for debugging
      console.log(`[CLOB] Order response received:`, JSON.stringify(response, null, 2));

      // Check if response is empty or null
      if (!response) {
        throw new Error('CLOB client returned empty/null response');
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
        // Try to parse as JSON error
        try {
          const parsed = JSON.parse(response);
          if (parsed.error) {
            throw new Error(`CLOB API error: ${parsed.error}`);
          }
        } catch {
          // Not JSON, might be an error page
          if (response.includes('<!DOCTYPE') || response.includes('<html')) {
            throw new Error('Received HTML error page instead of JSON response - API may be blocked');
          }
        }
      }

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
