import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Wallet configuration
  privateKey: process.env.PRIVATE_KEY || '',
  userWalletAddress: '', // Will be derived from private key

  // Polymarket API configuration
  polymarketApiKey: process.env.POLYMARKET_API_KEY || '',
  polymarketApiUrl: process.env.POLYMARKET_API_URL || 'https://api.polymarket.com',

  // Blockchain configuration
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  
  // Server configuration
  port: parseInt(process.env.PORT || '3000', 10),
  
  // Data directory
  dataDir: process.env.DATA_DIR || './data',

  // Validate required configuration
  validate(): void {
    if (!this.privateKey) {
      throw new Error('PRIVATE_KEY is required in .env file');
    }
    if (!this.polymarketApiKey) {
      throw new Error('POLYMARKET_API_KEY is required in .env file');
    }
  }
};
