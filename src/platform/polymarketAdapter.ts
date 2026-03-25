import { PlatformAdapter, NormalizedPosition, NormalizedOrderResult, PlaceOrderRequest } from './types.js';
import { config } from '../config.js';
import { PolymarketApi } from '../polymarketApi.js';

// ============================================================================
// Polymarket Platform Adapter
// Uses Polymarket APIs directly for data + TradeExecutor for execution.
// ============================================================================

export class PolymarketAdapter implements PlatformAdapter {
  readonly platform = 'polymarket' as const;
  private readonly api = new PolymarketApi();

  isConfigured(): boolean {
    return !!config.privateKey;
  }

  canExecute(): boolean {
    return !!config.privateKey;
  }

  async getMarketPrice(tokenId: string): Promise<{ yesPrice: number; noPrice: number } | null> {
    const bookData = await this.api.getOrderBook(tokenId);
    const token = bookData?.market?.tokens?.find((entry: any) => entry.token_id === tokenId);
    if (!token) return null;

    const yesPrice = Number.parseFloat(token.price);
    if (!Number.isFinite(yesPrice)) return null;

    return { yesPrice, noPrice: 1 - yesPrice };
  }

  async getPositions(walletAddress: string): Promise<NormalizedPosition[]> {
    const positions = await this.api.getUserPositions(walletAddress);
    return positions.map((p: any) => ({
      platform: 'polymarket' as const,
      marketId: p.asset || p.token_id || '',
      marketTitle: p.title || p.market_title || 'Unknown',
      outcome: p.outcome || (p.label === 'No' ? 'NO' : 'YES'),
      side: ((p.outcome || p.label || '').toUpperCase().includes('NO') ? 'NO' : 'YES') as 'YES' | 'NO',
      size: parseFloat(p.size || p.shares_normalized || '0'),
      avgPrice: parseFloat(p.avgPrice || p.avg_price || '0'),
      currentPrice: parseFloat(p.curPrice || p.cur_price || '0'),
      conditionId: p.conditionId || p.condition_id || '',
    }));
  }

  async placeOrder(order: PlaceOrderRequest): Promise<NormalizedOrderResult> {
    // Dynamically import TradeExecutor to avoid circular deps
    const { TradeExecutor } = await import('../tradeExecutor.js');
    const executor = new TradeExecutor();
    await executor.authenticate();

    const side = order.action === 'BUY'
      ? (await import('@polymarket/clob-client')).Side.BUY
      : (await import('@polymarket/clob-client')).Side.SELL;

    try {
      const result = await executor.executeTrade({
        marketId: '',
        outcome: order.side,
        amount: String(order.size),
        price: String(order.price),
        side: order.action,
        tokenId: order.marketId,
      });

      return {
        platform: 'polymarket',
        success: result.success,
        orderId: result.orderId,
        txHash: result.transactionHash,
        status: result.status,
        error: result.error,
      };
    } catch (err: any) {
      return { platform: 'polymarket', success: false, error: err.message };
    }
  }

  async getBalance(): Promise<number | null> {
    try {
      const { PolymarketClobClient } = await import('../clobClient.js');
      const client = new PolymarketClobClient();
      await client.initialize();
      return await client.getUsdcBalance();
    } catch {
      return null;
    }
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      canExecute: this.canExecute(),
      label: 'Polymarket',
    };
  }
}
