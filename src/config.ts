import path from 'path';
import dotenv from 'dotenv';
import { createComponentLogger } from './logger.js';
import { isHostedMultiTenantMode } from './hostedMode.js';

dotenv.config();

const log = createComponentLogger('Config');

// Helper function to ensure URLs have a protocol prefix
function ensureProtocol(url: string, defaultUrl: string): string {
  if (!url) return defaultUrl;
  // If the URL doesn't start with http:// or https://, prepend https://
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    log.warn({ url }, 'URL is missing protocol, auto-prepending https://');
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

  // API authentication (static bearer token)
  authMode: (process.env.AUTH_MODE || (process.env.AUTH0_ISSUER_BASE_URL ? 'oidc' : 'legacy')).toLowerCase() as 'legacy' | 'oidc',
  authSessionSecret: process.env.AUTH_SESSION_SECRET || '',
  auth0IssuerBaseUrl: process.env.AUTH0_ISSUER_BASE_URL || '',
  auth0BaseUrl: process.env.AUTH0_BASE_URL || '',
  auth0ClientId: process.env.AUTH0_CLIENT_ID || '',
  auth0ClientSecret: process.env.AUTH0_CLIENT_SECRET || '',
  authSessionAbsoluteDurationHours: parseInt(process.env.AUTH_SESSION_ABSOLUTE_DURATION_HOURS || '168', 10),
  authSessionRollingDurationHours: parseInt(process.env.AUTH_SESSION_ROLLING_DURATION_HOURS || '24', 10),
  apiSecret: process.env.API_SECRET || '',
  // In production, fail closed by default if API_SECRET is missing.
  // Override with REQUIRE_API_SECRET=false only for controlled environments.
  requireApiSecret: (process.env.REQUIRE_API_SECRET || (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Server configuration
  port: parseInt(process.env.PORT || '3001', 10),
  discoveryWorkerPort: parseInt(process.env.DISCOVERY_WORKER_PORT || '3002', 10),
  discoveryWorkerUrl: ensureProtocol(
    process.env.DISCOVERY_WORKER_URL || `http://127.0.0.1:${parseInt(process.env.DISCOVERY_WORKER_PORT || '3002', 10)}`,
    `http://127.0.0.1:${parseInt(process.env.DISCOVERY_WORKER_PORT || '3002', 10)}`
  ),

  // Data directory
  dataDir: process.env.DATA_DIR || './data',

  // Monitoring configuration
  // REDUCED from 15s to 5s for faster trade detection when copy trading
  monitoringIntervalMs: parseInt(process.env.MONITORING_INTERVAL_MS || '5000', 10), // 5 seconds default for faster copy trading

  // Storage backend: 'json' (file-based, default) or 'sqlite'
  storageBackend: (process.env.STORAGE_BACKEND || 'json').toLowerCase() as 'json' | 'sqlite',

  // Kalshi API credentials (RSA-PSS authentication)
  kalshiApiKeyId: process.env.KALSHI_API_KEY_ID || '',
  kalshiPrivateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || '',
  kalshiPrivateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM || '',

  // Discovery Engine (.env values are defaults; runtime config in SQLite overrides)
  discoveryEnabled: process.env.DISCOVERY_ENABLED === 'true',
  discoveryAlchemyWsUrl: process.env.DISCOVERY_ALCHEMY_WS_URL || '',
  discoveryPollIntervalMs: parseInt(process.env.DISCOVERY_POLL_INTERVAL_MS || '30000', 10),
  discoveryMarketCount: parseInt(process.env.DISCOVERY_MARKET_COUNT || '50', 10),
  discoveryStatsIntervalMs: parseInt(process.env.DISCOVERY_STATS_INTERVAL_MS || '300000', 10),

  // Validate required configuration
  validate(): void {
    if (this.authMode === 'oidc') {
      if (!this.authSessionSecret) {
        throw new Error('AUTH_SESSION_SECRET is required when AUTH_MODE=oidc');
      }
      if (!this.auth0IssuerBaseUrl || !this.auth0BaseUrl || !this.auth0ClientId || !this.auth0ClientSecret) {
        throw new Error('AUTH0_ISSUER_BASE_URL, AUTH0_BASE_URL, AUTH0_CLIENT_ID, and AUTH0_CLIENT_SECRET are required when AUTH_MODE=oidc');
      }
    }

    if (isHostedMultiTenantMode()) {
      if (this.storageBackend !== 'sqlite') {
        throw new Error('Hosted multi-tenant mode requires STORAGE_BACKEND=sqlite');
      }
      if (this.privateKey) {
        log.error('Hosted mode misconfiguration detected: PRIVATE_KEY must be unset for tenant isolation');
        throw new Error('Hosted multi-tenant mode forbids PRIVATE_KEY in server env. Use tenant keystores only.');
      }
      if (process.env.NODE_ENV === 'production' && !path.isAbsolute(this.dataDir)) {
        throw new Error(
          'Hosted production requires an absolute DATA_DIR (e.g. /opt/polymarket-bot/data) so data survives deploys and restarts.'
        );
      }
      log.info('Hosted multi-tenant mode: server .env PRIVATE_KEY is not required; tenants use encrypted keystores.');
    } else if (!this.privateKey) {
      log.error('Wallet not configured — private key is missing or invalid. Restart the bot to configure.');
      throw new Error('PRIVATE_KEY is required. Restart the bot to configure.');
    }

    // Builder API credentials are REQUIRED for trading from cloud servers
    // Without Builder authentication, requests will be blocked by Cloudflare
    if (!this.polymarketBuilderApiKey || !this.polymarketBuilderSecret || !this.polymarketBuilderPassphrase) {
      log.warn('Builder API credentials not configured — order requests WILL be blocked by Cloudflare. Add POLYMARKET_BUILDER_API_KEY, POLYMARKET_BUILDER_SECRET, and POLYMARKET_BUILDER_PASSPHRASE to your .env file. Get them from https://polymarket.com/settings?tab=builder');
    } else {
      log.info('Builder API credentials configured');
    }
  }
};
