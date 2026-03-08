interface TradeIdentityInput {
  marketId?: string | null;
  tokenId?: string | null;
  outcome?: string | null;
}

interface RawTradeIdentityInput {
  conditionId?: string | null;
  asset?: string | null;
}

export const normalizeOutcomeLabel = (
  outcome?: string | null,
  outcomeIndex?: number | null,
): string => {
  const normalized = (outcome || '').trim().toUpperCase();
  if (normalized) {
    return normalized;
  }

  if (outcomeIndex === 0) {
    return 'YES';
  }

  if (outcomeIndex === 1) {
    return 'NO';
  }

  if (outcomeIndex !== undefined && outcomeIndex !== null && Number.isFinite(outcomeIndex)) {
    return `OUTCOME_${outcomeIndex}`;
  }

  return 'UNKNOWN';
};

export const resolveTradeMarketId = ({ conditionId }: RawTradeIdentityInput): string | null => {
  const normalizedConditionId = (conditionId || '').trim();
  return normalizedConditionId || null;
};

export const buildPositionKey = ({ marketId, tokenId, outcome }: TradeIdentityInput): string => {
  const normalizedTokenId = (tokenId || '').trim();
  if (normalizedTokenId) {
    return `token:${normalizedTokenId}`;
  }

  const normalizedMarketId = (marketId || '').trim();
  const normalizedOutcome = normalizeOutcomeLabel(outcome);
  return `market:${normalizedMarketId}:${normalizedOutcome}`;
};
