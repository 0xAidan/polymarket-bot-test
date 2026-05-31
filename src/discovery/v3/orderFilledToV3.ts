/**
 * Convert decoded on-chain OrderFilled logs into v3 DuckDB activity rows.
 * Reuses the chain listener decoder; writes maker + taker rows per fill.
 */
import { parseOrderFilledLog } from '../chainListener.js';
import type { OrderFilledEvent } from '../types.js';
import type { NormalizedV3Row } from './goldskyListener.js';

const TAKER_LOG_INDEX_OFFSET = 1_000_000_000;

export function orderFilledEventToV3Rows(
  event: OrderFilledEvent,
  logIndex: number,
  tsUnix: number,
): NormalizedV3Row[] {
  const makerAmountRaw = Number(event.makerAmountFilled);
  const takerAmountRaw = Number(event.takerAmountFilled);

  let makerSide: 'BUY' | 'SELL';
  let takerSide: 'BUY' | 'SELL';
  let conditionalTokenId: string;
  let usdcAmount: number;
  let tokenAmount: number;

  if (event.version === 'v2') {
    const isBuy = event.side === 0;
    makerSide = isBuy ? 'BUY' : 'SELL';
    takerSide = isBuy ? 'SELL' : 'BUY';
    conditionalTokenId = event.tokenId ?? '0';
    usdcAmount = isBuy ? makerAmountRaw : takerAmountRaw;
    tokenAmount = isBuy ? takerAmountRaw : makerAmountRaw;
  } else {
    const makerIsUsdcSide = event.makerAssetId === '0';
    makerSide = makerIsUsdcSide ? 'BUY' : 'SELL';
    takerSide = makerIsUsdcSide ? 'SELL' : 'BUY';
    conditionalTokenId = (makerIsUsdcSide ? event.takerAssetId : event.makerAssetId) ?? '0';
    usdcAmount = makerIsUsdcSide ? makerAmountRaw : takerAmountRaw;
    tokenAmount = makerIsUsdcSide ? takerAmountRaw : makerAmountRaw;
  }

  const shares = tokenAmount / 1e6;
  const usdNotional = usdcAmount / 1e6;
  const price = tokenAmount > 0 ? usdcAmount / tokenAmount : 0;
  const marketId = conditionalTokenId;

  const base = {
    market_id: marketId,
    condition_id: '',
    event_id: null as string | null,
    ts_unix: tsUnix,
    block_number: event.blockNumber,
    tx_hash: event.transactionHash,
    price_yes: price,
    usd_notional: usdNotional,
  };

  return [
    {
      ...base,
      proxy_wallet: event.maker.toLowerCase(),
      log_index: logIndex,
      role: 'maker',
      side: makerSide,
      signed_size: makerSide === 'BUY' ? shares : -shares,
      abs_size: shares,
    },
    {
      ...base,
      proxy_wallet: event.taker.toLowerCase(),
      log_index: logIndex + TAKER_LOG_INDEX_OFFSET,
      role: 'taker',
      side: takerSide,
      signed_size: takerSide === 'BUY' ? shares : -shares,
      abs_size: shares,
    },
  ];
}

export function orderFilledLogToV3Rows(
  log: Record<string, unknown>,
  tsUnix: number,
): NormalizedV3Row[] {
  const event = parseOrderFilledLog(log);
  if (!event) return [];
  const logIndexRaw = log.logIndex;
  const logIndex = typeof logIndexRaw === 'string'
    ? parseInt(logIndexRaw, 16)
    : Number(logIndexRaw ?? 0);
  return orderFilledEventToV3Rows(event, logIndex, tsUnix);
}
