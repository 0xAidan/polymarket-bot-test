import { config } from './config.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('KalshiClient');

// ============================================================================
// Kalshi API client wrapper using kalshi-typescript SDK
// Handles RSA-PSS authentication and order execution
// ============================================================================

let kalshiConfig: any = null;
let portfolioApi: any = null;
let marketsApi: any = null;

/**
 * Check if Kalshi API is configured.
 */
export function isKalshiConfigured(): boolean {
  return !!(config.kalshiApiKeyId && (config.kalshiPrivateKeyPath || config.kalshiPrivateKeyPem));
}

/**
 * Lazily initialize the Kalshi SDK configuration.
 * Uses dynamic import because kalshi-typescript may not be installed.
 */
async function ensureInit(): Promise<{ portfolioApi: any; marketsApi: any }> {
  if (portfolioApi && marketsApi) return { portfolioApi, marketsApi };

  if (!isKalshiConfigured()) {
    throw new Error('Kalshi API credentials not configured (KALSHI_API_KEY_ID + key required)');
  }

  try {
    const kalshiSdk = await import('kalshi-typescript');
    const { Configuration, PortfolioApi, MarketApi } = kalshiSdk;

    const cfgOptions: any = {
      apiKey: config.kalshiApiKeyId,
      basePath: 'https://api.elections.kalshi.com/trade-api/v2',
    };

    if (config.kalshiPrivateKeyPath) {
      cfgOptions.privateKeyPath = config.kalshiPrivateKeyPath;
    } else if (config.kalshiPrivateKeyPem) {
      cfgOptions.privateKey = config.kalshiPrivateKeyPem;
    }

    kalshiConfig = new Configuration(cfgOptions);
    portfolioApi = new PortfolioApi(kalshiConfig);
    marketsApi = new MarketApi(kalshiConfig);

    log.info('[KalshiClient] Initialized successfully');
    return { portfolioApi, marketsApi };
  } catch (err: any) {
    log.error({ detail: err.message }, '[KalshiClient] Failed to initialize')
    throw err;
  }
}

// ============================================================================
// ORDER EXECUTION
// ============================================================================

export interface KalshiOrderParams {
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;       // Number of contracts
  yesPrice?: number;   // Price in cents (1-99)
  noPrice?: number;    // Price in cents (1-99)
  type?: 'market' | 'limit';
  clientOrderId?: string;
}

export interface KalshiOrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  error?: string;
}

/**
 * Place an order on Kalshi.
 */
export async function kalshiPlaceOrder(params: KalshiOrderParams): Promise<KalshiOrderResult> {
  try {
    const { portfolioApi: api } = await ensureInit();

    const orderBody: any = {
      ticker: params.ticker,
      side: params.side,
      action: params.action,
      count: params.count,
      type: params.type || 'limit',
    };

    if (params.yesPrice !== undefined) orderBody.yes_price = params.yesPrice;
    if (params.noPrice !== undefined) orderBody.no_price = params.noPrice;
    if (params.clientOrderId) orderBody.client_order_id = params.clientOrderId;

    const response = await api.createOrder({ createOrderRequest: orderBody });
    const order = response?.order || response;

    return {
      success: true,
      orderId: order?.order_id || order?.id,
      status: order?.status,
    };
  } catch (err: any) {
    log.error({ detail: err.message }, '[KalshiClient] Order placement failed')
    return { success: false, error: err.message };
  }
}

// ============================================================================
// ACCOUNT DATA
// ============================================================================

/**
 * Get Kalshi account balance.
 */
export async function kalshiGetBalance(): Promise<{ balance: number; availableBalance: number } | null> {
  try {
    const { portfolioApi: api } = await ensureInit();
    const result = await api.getBalance();
    return {
      balance: result?.balance ?? 0,
      availableBalance: result?.available_balance ?? result?.balance ?? 0,
    };
  } catch (err: any) {
    log.error({ detail: err.message }, '[KalshiClient] Failed to get balance')
    return null;
  }
}

/**
 * Get Kalshi open positions.
 */
export async function kalshiGetPositions(): Promise<any[]> {
  try {
    const { portfolioApi: api } = await ensureInit();
    const result = await api.getPositions({});
    return result?.market_positions || result?.positions || [];
  } catch (err: any) {
    log.error({ detail: err.message }, '[KalshiClient] Failed to get positions')
    return [];
  }
}

/**
 * Get a Kalshi market snapshot for price discovery.
 */
export async function kalshiGetMarket(ticker: string): Promise<any | null> {
  try {
    const { marketsApi: api } = await ensureInit();
    const result = await api.getMarket(ticker);
    return result?.data?.market || result?.market || result?.data || result || null;
  } catch (err: any) {
    log.error({ detail: err.message }, `[KalshiClient] Failed to get market ${ticker}`);
    return null;
  }
}

