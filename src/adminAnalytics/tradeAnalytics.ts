import type { TradeMetrics } from '../types.js';
import type {
  AdminTradeRow,
  BucketPoint,
  OverviewSummary,
  SuccessRateBucket,
  TradeMetricsFileRow,
  VolumeBucket,
} from './adminAnalyticsTypes.js';
import type { ResolvedTimeRange } from './adminAnalyticsTypes.js';
import { tradeInRange } from './timeRange.js';

export const computeNotionalUsd = (amount: string | undefined, price: string | undefined): number => {
  const a = parseFloat(amount ?? '0');
  const p = parseFloat(price ?? '0');
  if (!Number.isFinite(a) || !Number.isFinite(p)) {
    return 0;
  }
  return Math.round(a * p * 100) / 100;
};

export const toTradeTimestampMs = (timestamp: Date | string): number => {
  if (timestamp instanceof Date) {
    return timestamp.getTime();
  }
  return new Date(timestamp).getTime();
};

export const filterTradesByRange = (
  trades: TradeMetricsFileRow[],
  range: ResolvedTimeRange,
): TradeMetricsFileRow[] => (
  trades.filter((trade) => tradeInRange(toTradeTimestampMs(trade.timestamp), range))
);

export const summarizeTrades = (
  trades: TradeMetricsFileRow[],
  walletsTracked = 0,
): OverviewSummary => {
  const successfulTrades = trades.filter((t) => t.success);
  const failedTrades = trades.filter((t) => !t.success);
  const now = Date.now();
  const ms24h = now - 24 * 60 * 60 * 1000;
  const ms7d = now - 7 * 24 * 60 * 60 * 1000;
  const ms30d = now - 30 * 24 * 60 * 60 * 1000;

  const tradesLast24h = trades.filter((t) => toTradeTimestampMs(t.timestamp) >= ms24h).length;
  const tradesLast7d = trades.filter((t) => toTradeTimestampMs(t.timestamp) >= ms7d).length;
  const tradesLast30d = trades.filter((t) => toTradeTimestampMs(t.timestamp) >= ms30d).length;

  const averageLatencyMs = trades.length > 0
    ? Math.round(trades.reduce((sum, t) => sum + (t.executionTimeMs ?? 0), 0) / trades.length)
    : 0;

  const successRate = trades.length > 0
    ? Math.round((successfulTrades.length / trades.length) * 10000) / 100
    : 0;

  const notionalUsd = trades.reduce(
    (sum, t) => sum + computeNotionalUsd(t.executedAmount ?? t.amount, t.executedPrice ?? t.price),
    0,
  );

  return {
    totalTrades: trades.length,
    successfulTrades: successfulTrades.length,
    failedTrades: failedTrades.length,
    successRate,
    averageLatencyMs,
    activeAccounts: 0,
    walletsTracked,
    tradesLast24h,
    tradesLast7d,
    tradesLast30d,
    notionalUsd: Math.round(notionalUsd * 100) / 100,
  };
};

const bucketMsForRange = (range: ResolvedTimeRange): number => {
  const span = range.toMs - range.fromMs;
  if (range.preset === '24h' || span <= 24 * 60 * 60 * 1000) {
    return 60 * 60 * 1000;
  }
  if (range.preset === '7d' || span <= 7 * 24 * 60 * 60 * 1000) {
    return 6 * 60 * 60 * 1000;
  }
  return 24 * 60 * 60 * 1000;
};

export const bucketTrades = (
  trades: TradeMetricsFileRow[],
  range: ResolvedTimeRange,
): {
  tradesByBucket: BucketPoint[];
  successRateByBucket: SuccessRateBucket[];
  volumeByBucket: VolumeBucket[];
} => {
  const bucketMs = bucketMsForRange(range);
  const buckets = new Map<number, TradeMetricsFileRow[]>();

  for (const trade of trades) {
    const ts = toTradeTimestampMs(trade.timestamp);
    const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
    const list = buckets.get(bucketStart) ?? [];
    list.push(trade);
    buckets.set(bucketStart, list);
  }

  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  const tradesByBucket: BucketPoint[] = [];
  const successRateByBucket: SuccessRateBucket[] = [];
  const volumeByBucket: VolumeBucket[] = [];

  for (const key of sortedKeys) {
    const bucketTradesList = buckets.get(key) ?? [];
    const success = bucketTradesList.filter((t) => t.success).length;
    const failed = bucketTradesList.length - success;
    const rate = bucketTradesList.length > 0
      ? Math.round((success / bucketTradesList.length) * 10000) / 100
      : 0;
    const notionalUsd = bucketTradesList.reduce(
      (sum, t) => sum + computeNotionalUsd(t.executedAmount ?? t.amount, t.executedPrice ?? t.price),
      0,
    );

    tradesByBucket.push({
      bucketStart: new Date(key).toISOString(),
      total: bucketTradesList.length,
      success,
      failed,
    });
    successRateByBucket.push({ bucketStart: new Date(key).toISOString(), rate });
    volumeByBucket.push({
      bucketStart: new Date(key).toISOString(),
      notionalUsd: Math.round(notionalUsd * 100) / 100,
    });
  }

  return { tradesByBucket, successRateByBucket, volumeByBucket };
};

export const toAdminTradeRow = (trade: TradeMetricsFileRow): AdminTradeRow => ({
  id: trade.id,
  timestamp: new Date(trade.timestamp).toISOString(),
  marketId: trade.marketId,
  marketTitle: trade.marketTitle ?? trade.marketName ?? null,
  outcome: trade.outcome,
  side: trade.tradeSideAction ?? null,
  amount: trade.executedAmount ?? trade.amount,
  price: trade.executedPrice ?? trade.price,
  notionalUsd: computeNotionalUsd(trade.executedAmount ?? trade.amount, trade.executedPrice ?? trade.price),
  status: trade.status ?? (trade.success ? 'executed' : 'failed'),
  success: trade.success,
  sourceWallet: trade.walletAddress,
  sourceWalletLabel: trade.walletLabel ?? null,
  executionTimeMs: trade.executionTimeMs ?? 0,
  error: trade.error ?? null,
  orderId: trade.orderId ?? null,
  detectedTxHash: trade.detectedTxHash ?? null,
  tokenId: trade.tokenId ?? null,
});

export const sortTradesDesc = (trades: TradeMetricsFileRow[]): TradeMetricsFileRow[] => (
  [...trades].sort((a, b) => toTradeTimestampMs(b.timestamp) - toTradeTimestampMs(a.timestamp))
);

export const mergePlatformTrades = (
  byTenant: Map<string, TradeMetricsFileRow[]>,
): TradeMetricsFileRow[] => {
  const merged: TradeMetricsFileRow[] = [];
  for (const trades of byTenant.values()) {
    merged.push(...trades);
  }
  return merged;
};
