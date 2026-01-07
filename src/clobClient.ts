import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
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
      
      // Create wallet signer using ethers v5
      const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
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

    // Place the order
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

    return response;
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
    // Use cancel method which takes order_id as a string parameter
    return await (this.client as any).cancel(orderId);
  }
}
