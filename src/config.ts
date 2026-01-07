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
  
  // Polymarket Builder API credentials (OPTIONAL - only for order attribution)
  // These are NOT required for trading, only for getting credit on Builder Leaderboard
  polymarketBuilderApiKey: process.env.POLYMARKET_BUILDER_API_KEY || '',
  polymarketBuilderSecret: process.env.POLYMARKET_BUILDER_SECRET || '',
  polymarketBuilderPassphrase: process.env.POLYMARKET_BUILDER_PASSPHRASE || '',

  // Blockchain configuration
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  
  // Server configuration
  port: parseInt(process.env.PORT || '3001', 10),
  
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
    
    // Builder API credentials are REQUIRED for trading from cloud servers
    // Without Builder authentication, requests will be blocked by Cloudflare
    if (!this.polymarketBuilderApiKey || !this.polymarketBuilderSecret || !this.polymarketBuilderPassphrase) {
      console.error('\n⚠️  WARNING: Polymarket Builder API credentials not configured!\n');
      console.error('   Without Builder credentials, order requests WILL BE BLOCKED by Cloudflare.');
      console.error('   This is the #1 cause of trade execution failures.\n');
      console.error('   To fix this, add these to your .env file:');
      console.error('   POLYMARKET_BUILDER_API_KEY=your_key');
      console.error('   POLYMARKET_BUILDER_SECRET=your_secret');
      console.error('   POLYMARKET_BUILDER_PASSPHRASE=your_passphrase\n');
      console.error('   Get these from: https://polymarket.com/settings?tab=builder\n');
    } else {
      console.log('✓ Builder API credentials configured');
    }
  }
};
