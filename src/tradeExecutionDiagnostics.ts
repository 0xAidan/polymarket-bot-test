export type TradeExecutionFailureClassification =
  | 'signature-auth'
  | 'order-payload'
  | 'market-state'
  | 'cloudflare-block'
  | 'unknown';

interface TradeExecutionFailureInput {
  errorMessage?: string;
  authProbeSucceeded: boolean;
}

interface TradeExecutionFailureSummary {
  classification: TradeExecutionFailureClassification;
  summary: string;
}

interface ClobConnectivityDiagnosisInput {
  allTestsPassed: boolean;
  anyCloudflareBlocks: boolean;
  authProbe?: {
    success: boolean;
    classification?: TradeExecutionFailureClassification;
    summary?: string;
  };
}

export const classifyTradeExecutionFailure = (
  input: TradeExecutionFailureInput,
): TradeExecutionFailureSummary => {
  const message = (input.errorMessage || '').toLowerCase();

  if (message.includes('cloudflare') || message.includes('403')) {
    return {
      classification: 'cloudflare-block',
      summary: 'Network or Cloudflare blocking is preventing authenticated CLOB access.',
    };
  }

  if (message.includes('market_closed') || message.includes('orderbook') && message.includes('does not exist')) {
    return {
      classification: 'market-state',
      summary: 'The market is closed or resolved, so the order cannot be submitted.',
    };
  }

  if (message.includes('invalid signature')) {
    return {
      classification: 'signature-auth',
      summary: 'The request signature is failing authentication before the order can be accepted.',
    };
  }

  if (input.authProbeSucceeded && message.includes('400')) {
    return {
      classification: 'order-payload',
      summary: 'Authenticated CLOB access works, so this failure is more likely a bad order payload or market-specific rejection.',
    };
  }

  return {
    classification: 'unknown',
    summary: 'The failure could not be classified precisely from the available evidence.',
  };
};

export const summarizeClobConnectivityDiagnosis = (
  input: ClobConnectivityDiagnosisInput,
): string => {
  if (input.anyCloudflareBlocks || input.authProbe?.classification === 'cloudflare-block') {
    return 'CLOUDFLARE BLOCKING DETECTED - Your server IP is blocked by Polymarket. Try running locally or using a different server.';
  }

  if (input.authProbe?.success) {
    return 'Authenticated CLOB access works - if trades still fail, inspect tokenID, price/size formatting, and market state.';
  }

  if (input.authProbe?.classification === 'signature-auth') {
    return 'Authenticated CLOB probe failed with a signature/auth error - inspect wallet mode, proxy funder, and credential freshness.';
  }

  if (input.authProbe && !input.authProbe.success) {
    return input.authProbe.summary || 'Authenticated CLOB probe failed for an unknown reason.';
  }

  if (input.allTestsPassed) {
    return 'CLOB API is accessible - credentials configured correctly';
  }

  return 'CLOB API unreachable - network or configuration issue';
};
