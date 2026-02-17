/**
 * Trade sizing mode for per-wallet configuration
 * - undefined: Use global trade size, no filtering (copy ALL trades)
 * - 'fixed': Use wallet-specific USDC amount + optional threshold filter
 * - 'proportional': Match their portfolio % with your portfolio %
 */
export type TradeSizingMode = 'fixed' | 'proportional';

/**
 * Trade side filter options
 * - 'all': Copy both BUY and SELL trades
 * - 'buy_only': Only copy BUY trades
 * - 'sell_only': Only copy SELL trades
 */
export type TradeSideFilter = 'all' | 'buy_only' | 'sell_only';

/**
 * Represents a wallet address being tracked
 * ALL configuration is per-wallet - new wallets start with active=false and no settings
 */
export interface TrackedWallet {
  address: string;
  addedAt: Date;
  active: boolean;  // Default: false for new wallets
  lastSeen?: Date;
  label?: string; // User-friendly label/name for the wallet
  tags?: string[]; // Category tags e.g. "sports", "politics", "insider", "crypto"
  
  // ============================================================
  // TRADE SIZING MODE (Primary configuration)
  // ============================================================
  tradeSizingMode?: TradeSizingMode; // undefined = use global size, no filter
  fixedTradeSize?: number;           // USDC amount when mode is 'fixed'
  thresholdEnabled?: boolean;        // Filter small trades (only when mode is 'fixed')
  thresholdPercent?: number;         // Threshold % (only when mode is 'fixed')
  
  // ============================================================
  // TRADE SIDE FILTER
  // ============================================================
  tradeSideFilter?: TradeSideFilter; // 'all' | 'buy_only' | 'sell_only'
  
  // ============================================================
  // ADVANCED FILTERS (All per-wallet)
  // ============================================================
  
  // No Repeat Trades - Block repeat trades in same market+side
  noRepeatEnabled?: boolean;
  noRepeatPeriodHours?: number; // 0 = forever (until manually cleared)
  
  // Price Limits - Only copy trades within this price range
  priceLimitsMin?: number;  // Default: 0.01
  priceLimitsMax?: number;  // Default: 0.99
  
  // Rate Limiting - Limit trades per hour/day for this wallet
  rateLimitEnabled?: boolean;
  rateLimitPerHour?: number;  // Default: 10
  rateLimitPerDay?: number;   // Default: 50
  
  // Trade Value Filter - Filter by detected trade value
  valueFilterEnabled?: boolean;
  valueFilterMin?: number | null;  // null = no minimum
  valueFilterMax?: number | null;  // null = no maximum
  
  // Slippage - Per-wallet slippage override
  slippagePercent?: number;  // Default: 2%
}

/**
 * Represents a detected trade from a tracked wallet
 * Carries ALL per-wallet settings for use during trade processing
 */
export interface DetectedTrade {
  walletAddress: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  amount: string; // In wei or token units
  price: string; // Price per share
  side: 'BUY' | 'SELL'; // Whether the tracked wallet bought or sold
  timestamp: Date;
  transactionHash: string;
  tokenId?: string;   // Token ID for CLOB client (asset from positions API)
  negRisk?: boolean;  // Negative risk flag from position data
  
  // ============================================================
  // Inherited from wallet settings for per-wallet trade configuration
  // ============================================================
  
  // Trade sizing
  tradeSizingMode?: TradeSizingMode;
  fixedTradeSize?: number;
  thresholdEnabled?: boolean;
  thresholdPercent?: number;
  
  // Trade side filter
  tradeSideFilter?: TradeSideFilter;
  
  // Advanced filters (all per-wallet)
  noRepeatEnabled?: boolean;
  noRepeatPeriodHours?: number;
  priceLimitsMin?: number;
  priceLimitsMax?: number;
  rateLimitEnabled?: boolean;
  rateLimitPerHour?: number;
  rateLimitPerDay?: number;
  valueFilterEnabled?: boolean;
  valueFilterMin?: number | null;
  valueFilterMax?: number | null;
  slippagePercent?: number;
}

/**
 * Represents a trade to be executed
 */
export interface TradeOrder {
  marketId: string;
  outcome: 'YES' | 'NO';
  amount: string;
  price: string;
  side: 'BUY' | 'SELL';
  tokenId?: string;   // Token ID for CLOB client
  negRisk?: boolean;  // Negative risk flag
}

/**
 * Trade execution result
 */
export interface TradeResult {
  success: boolean;
  status?: 'executed' | 'pending' | 'failed' | 'rejected'; // Detailed status: rejected = pre-validation failure
  orderId?: string;
  transactionHash?: string;
  error?: string;
  executionTimeMs?: number; // Latency tracking
}

/**
 * Performance metrics for a single trade
 */
export interface TradeMetrics {
  id: string;
  timestamp: Date;
  walletAddress: string;
  marketId: string;
  outcome: 'YES' | 'NO';
  amount: string;
  price: string;
  success: boolean;
  status?: 'executed' | 'pending' | 'failed' | 'rejected'; // Detailed status: executed = filled, pending = on order book, failed = error, rejected = pre-validation failure
  executionTimeMs: number;
  error?: string;
  orderId?: string;
  transactionHash?: string;
  detectedTxHash: string; // Original transaction that triggered this
  tokenId?: string; // Token ID used for order execution
  executedAmount?: string; // Actual amount executed (may differ from detected amount)
  executedPrice?: string; // Actual price used
}

/**
 * System issue/error log entry
 */
export interface SystemIssue {
  id: string;
  timestamp: Date;
  severity: 'error' | 'warning' | 'info';
  category: 'trade_execution' | 'wallet_monitoring' | 'api_connection' | 'authentication' | 'other';
  message: string;
  details?: any;
  resolved: boolean;
}

/**
 * Performance statistics
 */
export interface PerformanceStats {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  successRate: number; // Percentage
  averageLatencyMs: number;
  totalVolume: string; // Total amount traded
  tradesLast24h: number;
  tradesLastHour: number;
  uptimeMs: number;
  lastTradeTime?: Date;
  issues: SystemIssue[];
  walletsTracked: number;
}

/**
 * Wallet performance stats
 */
export interface WalletStats {
  address: string;
  tradesCopied: number;
  successfulCopies: number;
  failedCopies: number;
  successRate: number;
  averageLatencyMs: number;
  lastActivity?: Date;
}

/**
 * Performance data point for charting
 */
export interface PerformanceDataPoint {
  timestamp: Date;
  balance: number;
  totalTrades: number;
  successfulTrades: number;
  cumulativeVolume: number;
  tradeId?: string;
  tradeDetails?: {
    marketId: string;
    outcome: 'YES' | 'NO';
    amount: string;
    price: string;
    success: boolean;
  };
}

// ============================================================================
// ADVANCED TRADE FILTER CONFIGURATION TYPES
// ============================================================================

/**
 * No repeat trades configuration
 * Prevents copying trades in markets where you already have a position
 */
export interface NoRepeatTradesConfig {
  enabled: boolean;
  blockPeriodHours: number; // How long to block repeats (1, 6, 12, 24, 48, 168)
}

/**
 * Price limits configuration
 * Replaces hard-coded MIN/MAX_EXECUTABLE_PRICE
 */
export interface PriceLimitsConfig {
  minPrice: number; // Default: 0.01, Range: 0.01-0.98
  maxPrice: number; // Default: 0.99, Range: 0.02-0.99
}

/**
 * Rate limiting configuration
 * Prevents excessive trade execution
 */
export interface RateLimitingConfig {
  enabled: boolean;
  maxTradesPerHour: number;  // Default: 10, Range: 1-100
  maxTradesPerDay: number;   // Default: 50, Range: 1-500
}

/**
 * Trade value filters configuration
 * Filter trades by USDC value
 */
export interface TradeValueFiltersConfig {
  enabled: boolean;
  minTradeValueUSD: number | null; // null = no minimum
  maxTradeValueUSD: number | null; // null = no maximum
}

/**
 * Executed position record for no-repeat-trades tracking
 */
export interface ExecutedPosition {
  marketId: string;
  side: 'YES' | 'NO';
  timestamp: number;
  walletAddress: string; // Which tracked wallet triggered this
}

/**
 * Configuration conflict detected by the system
 */
export interface ConfigConflict {
  type: 'warning' | 'error';
  code: string;
  message: string;
  affectedSettings: string[];
  suggestion?: string;
}

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
  valid: boolean;
  conflicts: ConfigConflict[];
}

/**
 * Rate limiting runtime state (in-memory tracking)
 * Used for both global and per-wallet rate limiting
 */
export interface RateLimitState {
  tradesThisHour: number;
  tradesThisDay: number;
  hourStartTime: number;
  dayStartTime: number;
}

/**
 * Per-wallet rate limit states (keyed by wallet address)
 */
export type PerWalletRateLimitStates = Map<string, RateLimitState>;

// ============================================================================
// MULTI-WALLET TYPES
// ============================================================================

/**
 * A trading wallet managed by the bot.
 * Each wallet has its own private key (stored encrypted), address, and config.
 */
export interface TradingWallet {
  id: string;                    // Unique ID (e.g. 'main', 'arb', 'test')
  label: string;                 // User-friendly name
  address: string;               // EOA address (derived from private key)
  proxyAddress?: string;         // Polymarket proxy wallet address
  isActive: boolean;             // Whether this wallet is enabled for trading
  createdAt: string;             // ISO timestamp

  // Dome Order Router credentials (stored encrypted in SQLite)
  domeUserId?: string;           // Dome userId for this wallet
  hasCredentials: boolean;       // Whether CLOB API creds are stored
}

/**
 * Copy assignment: which trading wallet(s) should receive copies
 * from a given tracked (monitored) wallet.
 */
export interface CopyAssignment {
  trackedWalletAddress: string;  // The monitored wallet
  tradingWalletId: string;       // Which of our trading wallets to copy to
  useOwnConfig: boolean;         // true = use trading wallet's config, false = inherit from tracked wallet
}

/**
 * Complete bot configuration (for API responses)
 */
export interface BotConfigSummary {
  // Global trade settings
  tradeSize: string;
  slippagePercent: number;
  
  // Filters
  noRepeatTrades: NoRepeatTradesConfig;
  priceLimits: PriceLimitsConfig;
  tradeSideFilter: TradeSideFilter;
  rateLimiting: RateLimitingConfig;
  tradeValueFilters: TradeValueFiltersConfig;
  
  // Stop-loss
  usageStopLoss: {
    enabled: boolean;
    maxCommitmentPercent: number;
  };
  
  // Monitoring
  monitoringIntervalMs: number;
}

