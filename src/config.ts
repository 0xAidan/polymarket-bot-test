import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Wallet configuration
  privateKey: process.env.PRIVATE_KEY || '',
  userWalletAddress: '', // Will be derived from private key

  // Polymarket API configuration
  polymarketApiKey: process.env.POLYMARKET_API_KEY || '',
  polymarketApiUrl: process.env.POLYMARKET_API_URL || 'https://api.polymarket.com',
  polymarketClobApiUrl: process.env.POLYMARKET_CLOB_API_URL || 'https://clob.polymarket.com',
  polymarketDataApiUrl: process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com',
  polymarketGammaApiUrl: process.env.POLYMARKET_GAMMA_API_URL || 'https://gamma-api.polymarket.com',

  // Blockchain configuration
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  
  // Server configuration
  port: parseInt(process.env.PORT || '3000', 10),
  
  // Data directory
  dataDir: process.env.DATA_DIR || './data',

  // Monitoring configuration
  monitoringIntervalMs: parseInt(process.env.MONITORING_INTERVAL_MS || '15000', 10), // 15 seconds default

  // Validate required configuration
  validate(): void {
    if (!this.privateKey) {
      console.error('\n❌ ERROR: Wallet not configured!\n');
      console.error('📝 To set up your wallet, run:');
      console.error('   npm run setup\n');
      console.error('Or create a .env file with your PRIVATE_KEY.');
      console.error('See README.md for instructions.\n');
      throw new Error('PRIVATE_KEY is required. Run "npm run setup" to configure.');
    }
    // Note: API key might be optional depending on Polymarket's auth requirements
    // Will implement wallet signature auth if needed
  }
};
