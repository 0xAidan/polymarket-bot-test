import { PlatformAdapter, NormalizedPosition, NormalizedOrderResult, PlaceOrderRequest } from './types.js';
import { domeGetMarketPrice, domeGetPositions, isDomeConfigured } from '../domeClient.js';
import { config } from '../config.js';

// ============================================================================
// Polymarket Platform Adapter
// Wraps existing Dome client (data) + TradeExecutor (execution)
// ============================================================================

export class PolymarketAdapter implements PlatformAdapter {
  readonly platform = 'polymarket' as const;

  isConfigured(): boolean {
    return isDomeConfigured() || !!config.privateKey;
  }

  canExecute(): boolean {
    return !!config.privateKey;
  }

  async getMarketPrice(tokenId: string): Promise<{ yesPrice: number; noPrice: number } | null> {
    const result = await domeGetMarketPrice(tokenId);
    if (!result) return null;
    const yesPrice = result.price;
    return { yesPrice, noPrice: 1 - yesPrice };
  }

  async getPositions(walletAddress: string): Promise<NormalizedPosition[]> {
    const positions = await domeGetPositions(walletAddress);
    return positions.map((p: any) => ({
      platform: 'polymarket' as const,
      marketId: p.token_id || p.asset || '',
      marketTitle: p.title || p.market_title || 'Unknown',
      outcome: p.outcome || (p.label === 'No' ? 'NO' : 'YES'),
      side: ((p.outcome || p.label || '').toUpperCase().includes('NO') ? 'NO' : 'YES') as 'YES' | 'NO',
      size: parseFloat(p.shares_normalized || p.size || '0'),
      avgPrice: parseFloat(p.avg_price || p.avgPrice || '0'),
      currentPrice: parseFloat(p.cur_price || p.curPrice || '0'),
      conditionId: p.condition_id || p.conditionId || '',
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
