import { PlatformAdapter, NormalizedPosition, NormalizedOrderResult, PlaceOrderRequest } from './types.js';
import { isKalshiConfigured, kalshiPlaceOrder, kalshiGetBalance, kalshiGetPositions } from '../kalshiClient.js';
import { domeGetKalshiMarkets, isDomeConfigured } from '../domeClient.js';

// ============================================================================
// Kalshi Platform Adapter
// Data via Dome SDK, execution via kalshi-typescript
// ============================================================================

export class KalshiAdapter implements PlatformAdapter {
  readonly platform = 'kalshi' as const;

  isConfigured(): boolean {
    return isDomeConfigured() || isKalshiConfigured();
  }

  canExecute(): boolean {
    return isKalshiConfigured();
  }

  async getMarketPrice(ticker: string): Promise<{ yesPrice: number; noPrice: number } | null> {
    // Use Dome SDK for Kalshi price data
    try {
      const { getDomeClient } = await import('../domeClient.js');
      const dome = getDomeClient();
      if (!dome) return null;

      const result = await dome.kalshi.markets.getMarketPrice({ market_ticker: ticker });
      const data = result as any;
      if (!data) return null;

      // Kalshi returns prices in cents; normalize to 0-1
      const yesPrice = (data.yes?.price ?? data.last_price ?? 0) / 100;
      const noPrice = (data.no?.price ?? (100 - (data.yes?.price ?? 50))) / 100;
      return { yesPrice, noPrice };
    } catch (err: any) {
      console.error(`[KalshiAdapter] Failed to get price for ${ticker}:`, err.message);
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
      console.error('[KalshiAdapter] Failed to get positions:', err.message);
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
