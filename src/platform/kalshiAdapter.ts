import { PlatformAdapter, NormalizedPosition, NormalizedOrderResult, PlaceOrderRequest } from './types.js';
import { isKalshiConfigured, kalshiPlaceOrder, kalshiGetBalance, kalshiGetPositions, kalshiGetMarket } from '../kalshiClient.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('KalshiAdapter');

// ============================================================================
// Kalshi Platform Adapter
// Uses the native Kalshi SDK for data and execution.
// ============================================================================

export class KalshiAdapter implements PlatformAdapter {
  readonly platform = 'kalshi' as const;

  isConfigured(): boolean {
    return isKalshiConfigured();
  }

  canExecute(): boolean {
    return isKalshiConfigured();
  }

  async getMarketPrice(ticker: string): Promise<{ yesPrice: number; noPrice: number } | null> {
    try {
      if (!isKalshiConfigured()) return null;

      const data = await kalshiGetMarket(ticker);
      if (!data) return null;

      const midpoint = (bid: unknown, ask: unknown): number | null => {
        const bidValue = typeof bid === 'number' ? bid : Number.NaN;
        const askValue = typeof ask === 'number' ? ask : Number.NaN;
        if (Number.isFinite(bidValue) && Number.isFinite(askValue)) {
          return (bidValue + askValue) / 200;
        }
        return null;
      };

      const yesMidpoint = midpoint(data.yes_bid, data.yes_ask);
      const noMidpoint = midpoint(data.no_bid, data.no_ask);
      const lastPrice = typeof data.last_price === 'number' ? data.last_price / 100 : null;

      const yesPrice = yesMidpoint ?? lastPrice;
      const noPrice = noMidpoint ?? (yesPrice !== null ? 1 - yesPrice : null);
      if (yesPrice === null || noPrice === null) return null;

      return { yesPrice, noPrice };
    } catch (err: any) {
      log.error({ detail: err.message }, `[KalshiAdapter] Failed to get price for ${ticker}`)
      return null;
    }
  }

  async getPositions(accountId: string): Promise<NormalizedPosition[]> {
    if (!isKalshiConfigured()) return [];

    try {
      const positions = await kalshiGetPositions();
      return positions.map((p: any) => ({
        platform: 'kalshi' as const,
        marketId: p.ticker || p.market_ticker || '',
        marketTitle: p.title || p.market_ticker || 'Unknown',
        outcome: (p.position_side || 'yes').toUpperCase(),
        side: ((p.position_side || 'yes').toLowerCase() === 'no' ? 'NO' : 'YES') as 'YES' | 'NO',
        size: p.total_traded || p.quantity || 0,
        avgPrice: (p.average_price || 0) / 100,     // cents to 0-1
        currentPrice: (p.last_price || 0) / 100,     // cents to 0-1
      }));
    } catch (err: any) {
      log.error({ detail: err.message }, '[KalshiAdapter] Failed to get positions')
      return [];
    }
  }

  async placeOrder(order: PlaceOrderRequest): Promise<NormalizedOrderResult> {
    if (!isKalshiConfigured()) {
      return { platform: 'kalshi', success: false, error: 'Kalshi credentials not configured' };
    }

    try {
      // Convert 0-1 price to Kalshi cents (1-99)
      const priceInCents = Math.round(order.price * 100);
      const clampedPrice = Math.max(1, Math.min(99, priceInCents));

      const result = await kalshiPlaceOrder({
        ticker: order.marketId,
        side: order.side.toLowerCase() as 'yes' | 'no',
        action: order.action.toLowerCase() as 'buy' | 'sell',
        count: Math.round(order.size),
        yesPrice: order.side === 'YES' ? clampedPrice : undefined,
        noPrice: order.side === 'NO' ? clampedPrice : undefined,
        type: 'limit',
      });

      return {
        platform: 'kalshi',
        success: result.success,
        orderId: result.orderId,
        status: result.status,
        error: result.error,
      };
    } catch (err: any) {
      return { platform: 'kalshi', success: false, error: err.message };
    }
  }

  async getBalance(): Promise<number | null> {
    if (!isKalshiConfigured()) return null;
    const result = await kalshiGetBalance();
    return result ? result.availableBalance / 100 : null; // cents to dollars
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      canExecute: this.canExecute(),
      label: 'Kalshi',
    };
  }
}
