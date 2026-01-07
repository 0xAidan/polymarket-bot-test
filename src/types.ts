/**
 * Represents a wallet address being tracked
 */
export interface TrackedWallet {
  address: string;
  addedAt: Date;
  active: boolean;
  lastSeen?: Date;
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
  timestamp: Date;
  transactionHash: string;
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
}

/**
 * Trade execution result
 */
export interface TradeResult {
  success: boolean;
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
  executionTimeMs: number;
  error?: string;
  orderId?: string;
  transactionHash?: string;
  detectedTxHash: string; // Original transaction that triggered this
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
