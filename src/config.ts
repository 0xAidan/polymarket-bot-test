import dotenv from 'dotenv';

dotenv.config();

// Helper function to ensure URLs have a protocol prefix
function ensureProtocol(url: string, defaultUrl: string): string {
  if (!url) return defaultUrl;
  // If the URL doesn't start with http:// or https://, prepend https://
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    console.warn(`[CONFIG] URL "${url}" is missing protocol, auto-prepending https://`);
    return `https://${url}`;
  }
  return url;
}

export const config = {
  // Wallet configuration
  privateKey: process.env.PRIVATE_KEY || '',
  userWalletAddress: '', // Will be derived from private key

  // Polymarket API configuration
  polymarketApiKey: process.env.POLYMARKET_API_KEY || '',
  polymarketApiUrl: ensureProtocol(process.env.POLYMARKET_API_URL || '', 'https://api.polymarket.com'),
  polymarketClobApiUrl: ensureProtocol(process.env.POLYMARKET_CLOB_API_URL || '', 'https://clob.polymarket.com'),
  polymarketDataApiUrl: ensureProtocol(process.env.POLYMARKET_DATA_API_URL || '', 'https://data-api.polymarket.com'),
  polymarketGammaApiUrl: ensureProtocol(process.env.POLYMARKET_GAMMA_API_URL || '', 'https://gamma-api.polymarket.com'),
  
  // Polymarket Builder API credentials (OPTIONAL - only for order attribution)
  // These are NOT required for trading, only for getting credit on Builder Leaderboard
  polymarketBuilderApiKey: process.env.POLYMARKET_BUILDER_API_KEY || '',
  polymarketBuilderSecret: process.env.POLYMARKET_BUILDER_SECRET || '',
  polymarketBuilderPassphrase: process.env.POLYMARKET_BUILDER_PASSPHRASE || '',

  // Blockchain configuration
  // Using Alchemy RPC for reliable balance fetching (needed for position threshold filter)
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  
  // Server configuration
  port: parseInt(process.env.PORT || '3001', 10),
  
  // Data directory
  dataDir: process.env.DATA_DIR || './data',

  // Monitoring configuration
  // REDUCED from 15s to 5s for faster trade detection when copy trading
  monitoringIntervalMs: parseInt(process.env.MONITORING_INTERVAL_MS || '5000', 10), // 5 seconds default for faster copy trading

  // Storage backend: 'json' (file-based, default) or 'sqlite'
  storageBackend: (process.env.STORAGE_BACKEND || 'json').toLowerCase() as 'json' | 'sqlite',

  // Dome API (prediction market aggregator)
  domeApiKey: process.env.DOME_API_KEY || '',

  // Kalshi API credentials (RSA-PSS authentication)
  kalshiApiKeyId: process.env.KALSHI_API_KEY_ID || '',
  kalshiPrivateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || '',
  kalshiPrivateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM || '',

  // Validate required configuration
  validate(): void {
    if (!this.privateKey) {
      console.error('\n❌ ERROR: Wallet not configured!\n');
      console.error('Your private key is missing or invalid.');
      console.error('Please restart the bot to run the setup wizard again.\n');
      throw new Error('PRIVATE_KEY is required. Restart the bot to configure.');
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
