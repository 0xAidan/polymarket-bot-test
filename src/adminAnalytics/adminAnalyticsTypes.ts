import type { TradeMetrics } from '../types.js';

export type TimeRangePreset = '24h' | '7d' | '30d' | 'all';

export type ResolvedTimeRange = {
  preset: TimeRangePreset | 'custom';
  fromMs: number;
  toMs: number;
  from: string;
  to: string;
};

export type AdminTradeRow = {
  id: string;
  timestamp: string;
  marketId: string;
  marketTitle: string | null;
  outcome: string;
  side: string | null;
  amount: string;
  price: string;
  notionalUsd: number;
  status: string;
  success: boolean;
  sourceWallet: string;
  sourceWalletLabel: string | null;
  executionTimeMs: number;
  error: string | null;
  orderId: string | null;
  detectedTxHash: string | null;
  tokenId: string | null;
  position?: {
    positionKey: string | null;
    baselinePositionSize: number | null;
    tradeSideAction: string | null;
  };
};

export type TradeMetricsFileRow = TradeMetrics & {
  walletLabel?: string;
  marketName?: string;
  tradeSideAction?: string;
};

export type TenantListRow = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  ownerEmail: string | null;
  memberCount: number;
  createdAt: string;
  metrics: {
    totalTrades: number;
    successRate: number;
    averageLatencyMs: number;
    walletsTracked: number;
    tradesInRange: number;
    tradesLast24h: number;
    tradesLast7d: number;
  };
};

export type OverviewSummary = {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  successRate: number;
  averageLatencyMs: number;
  activeAccounts: number;
  walletsTracked: number;
  tradesLast24h: number;
  tradesLast7d: number;
  tradesLast30d: number;
  notionalUsd: number;
};

export type BucketPoint = {
  bucketStart: string;
  total: number;
  success: number;
  failed: number;
};

export type SuccessRateBucket = {
  bucketStart: string;
  rate: number;
};

export type VolumeBucket = {
  bucketStart: string;
  notionalUsd: number;
};

export const CSV_TRADE_COLUMNS = [
  'timestamp',
  'tenant_id',
  'tenant_name',
  'owner_email',
  'trade_id',
  'status',
  'success',
  'market_id',
  'market_title',
  'outcome',
  'side',
  'amount',
  'price',
  'notional_usd',
  'source_wallet',
  'source_wallet_label',
  'execution_time_ms',
  'error',
  'order_id',
  'detected_tx_hash',
  'token_id',
] as const;
