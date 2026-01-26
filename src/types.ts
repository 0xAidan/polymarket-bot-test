/**
 * Trade sizing mode for per-wallet configuration
 * - undefined: Use global trade size, no filtering (copy ALL trades)
 * - 'fixed': Use wallet-specific USDC amount + optional threshold filter
 * - 'proportional': Match their portfolio % with your portfolio %
 */
export type TradeSizingMode = 'fixed' | 'proportional';

/**
 * Represents a wallet address being tracked
 */
export interface TrackedWallet {
  address: string;
  addedAt: Date;
  active: boolean;
  lastSeen?: Date;
  label?: string; // User-friendly label/name for the wallet
  autoBumpToMinimum?: boolean; // If true, auto-increase order size to meet market minimum (for high-value wallets)
  
  // Per-wallet trade configuration (all optional - undefined means use global defaults)
  tradeSizingMode?: TradeSizingMode; // undefined = use global size, no filter
  fixedTradeSize?: number;           // USDC amount when mode is 'fixed'
  thresholdEnabled?: boolean;        // Filter small trades (only when mode is 'fixed')
  thresholdPercent?: number;         // Threshold % (only when mode is 'fixed')
}

/**
 * Represents a detected trade from a tracked wallet
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
  autoBumpToMinimum?: boolean; // Inherited from wallet settings - auto-increase to market minimum
  
  // Inherited from wallet settings for per-wallet trade configuration
  tradeSizingMode?: TradeSizingMode;
  fixedTradeSize?: number;
  thresholdEnabled?: boolean;
  thresholdPercent?: number;
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
