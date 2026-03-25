import { Side } from '@polymarket/clob-client';

import { DetectedTrade, TradeOrder } from './types.js';

type UnknownRecord = Record<string, unknown>;

interface ClobOrderParamsSummary {
  tokenID: string;
  price: number;
  size: number;
  side: Side;
  tickSize?: string;
  negRisk?: boolean;
}

interface TradeExecutionRuntimeSummary {
  signatureType: number;
  funderAddress: string;
  clobHost: string;
  builderAuthConfigured: boolean;
  retryAttempted: boolean;
}

interface TradeExecutionDiagnosticInput {
  stage: string;
  order: TradeOrder;
  clobOrderParams: ClobOrderParamsSummary;
  execution: TradeExecutionRuntimeSummary;
  errorMessage: string;
}

const isTradeRegressionDebugEnabled = (): boolean => {
  const value = (process.env.TRADE_DEBUG_LOGGING || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

const normalizeTimestamp = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
};

export const summarizeActivityTradeForDebug = (trade: UnknownRecord): UnknownRecord => ({
  source: 'activity',
  id: trade.id,
  conditionId: trade.conditionId,
  asset: trade.asset,
  outcome: trade.outcome,
  outcomeIndex: trade.outcomeIndex,
  side: trade.side,
  size: trade.size,
  price: trade.price,
  timestamp: normalizeTimestamp(trade.timestamp),
  title: trade.title,
  transactionHash: trade.transactionHash,
});

export const summarizeDetectedTradeForDebug = (trade: DetectedTrade): UnknownRecord => ({
  source: 'detected-trade',
  walletAddress: trade.walletAddress,
  marketId: trade.marketId,
  marketTitle: trade.marketTitle,
  outcome: trade.outcome,
  amount: trade.amount,
  price: trade.price,
  side: trade.side,
  timestamp: normalizeTimestamp(trade.timestamp),
  transactionHash: trade.transactionHash,
  tokenId: trade.tokenId,
  negRisk: trade.negRisk,
});

export const buildTradeExecutionDiagnosticContext = (
  input: TradeExecutionDiagnosticInput,
): UnknownRecord => ({
  source: 'trade-execution',
  stage: input.stage,
  order: {
    marketId: input.order.marketId,
    outcome: input.order.outcome,
    amount: input.order.amount,
    price: input.order.price,
    side: input.order.side,
    tokenId: input.order.tokenId,
    negRisk: input.order.negRisk,
    slippagePercent: input.order.slippagePercent,
  },
  clobOrderParams: {
    tokenID: input.clobOrderParams.tokenID,
    price: input.clobOrderParams.price,
    size: input.clobOrderParams.size,
    side: input.clobOrderParams.side === Side.BUY ? 'BUY' : 'SELL',
    tickSize: input.clobOrderParams.tickSize,
    negRisk: input.clobOrderParams.negRisk,
  },
  execution: input.execution,
  errorMessage: input.errorMessage,
});

export const logTradeRegressionDebug = (label: string, payload: UnknownRecord): void => {
  if (!isTradeRegressionDebugEnabled()) {
    return;
  }

  console.log(`[TradeDebug] ${label}: ${JSON.stringify(payload, null, 2)}`);
};
