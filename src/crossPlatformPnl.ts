import { getAdapter, getConfiguredAdapters } from './platform/platformRegistry.js';
import type { NormalizedPosition, Platform } from './platform/types.js';
import { Storage } from './storage.js';

// ============================================================================
// Cross-Platform P&L Tracker
// Aggregates profit/loss across Polymarket and Kalshi
// ============================================================================

export interface PlatformPnl {
  platform: Platform;
  totalInvested: number;
  currentValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  positionCount: number;
  winRate: number;
}

export interface AggregatedPnl {
  platforms: PlatformPnl[];
  totalInvested: number;
  currentValue: number;
  totalPnl: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPositions: number;
  lastUpdated: string;
}

export interface MatchedMarket {
  eventTitle: string;
  polymarketSlug?: string;
  polymarketTokenId?: string;
  kalshiTicker?: string;
  polymarketPrice?: number;
  kalshiPrice?: number;
  priceDiff?: number;
  lastUpdated: string;
}

export class CrossPlatformPnlTracker {
  private matchedMarkets: MatchedMarket[] = [];
  private pnlHistory: AggregatedPnl[] = [];

  async init(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      this.matchedMarkets = cfg.matchedMarkets ?? [];
      this.pnlHistory = cfg.pnlHistory ?? [];
    } catch { /* defaults */ }
    console.log(`[CrossPlatformPnl] Loaded ${this.matchedMarkets.length} matched market(s)`);
  }

  /**
   * Calculate P&L across all configured platforms.
   */
  async calculatePnl(walletsByPlatform: Record<string, string[]>): Promise<AggregatedPnl> {
    const platformResults: PlatformPnl[] = [];

    for (const adapter of getConfiguredAdapters()) {
      const identifiers = walletsByPlatform[adapter.platform] || [];
      if (identifiers.length === 0) continue;

      let allPositions: NormalizedPosition[] = [];
      for (const id of identifiers) {
        try {
          const positions = await adapter.getPositions(id);
          allPositions.push(...positions);
        } catch { /* skip */ }
      }

      const totalInvested = allPositions.reduce((sum, p) => sum + (p.avgPrice * p.size), 0);
      const currentValue = allPositions.reduce((sum, p) => sum + (p.currentPrice * p.size), 0);
      const unrealizedPnl = currentValue - totalInvested;

      platformResults.push({
        platform: adapter.platform,
        totalInvested,
        currentValue,
        realizedPnl: 0,
        unrealizedPnl,
        totalPnl: unrealizedPnl,
        positionCount: allPositions.length,
        winRate: allPositions.length > 0
          ? allPositions.filter(p => p.currentPrice > p.avgPrice).length / allPositions.length
          : 0,
      });
    }

    const aggregated: AggregatedPnl = {
      platforms: platformResults,
      totalInvested: platformResults.reduce((s, p) => s + p.totalInvested, 0),
      currentValue: platformResults.reduce((s, p) => s + p.currentValue, 0),
      totalPnl: platformResults.reduce((s, p) => s + p.totalPnl, 0),
      unrealizedPnl: platformResults.reduce((s, p) => s + p.unrealizedPnl, 0),
      realizedPnl: platformResults.reduce((s, p) => s + p.realizedPnl, 0),
      totalPositions: platformResults.reduce((s, p) => s + p.positionCount, 0),
      lastUpdated: new Date().toISOString(),
    };

    // Save to history (keep last 100)
    this.pnlHistory.push(aggregated);
    if (this.pnlHistory.length > 100) this.pnlHistory = this.pnlHistory.slice(-100);
    await this.savePnlHistory();

    return aggregated;
  }

  /**
   * Smart Order Router: determine which platform gives the best price for a trade.
   */
  async smartRoute(params: {
    side: 'YES' | 'NO';
    action: 'BUY' | 'SELL';
    matchedMarket: MatchedMarket;
  }): Promise<{ platform: Platform; marketId: string; price: number; savings: number } | null> {
    const { side, action, matchedMarket } = params;

    const prices: Array<{ platform: Platform; marketId: string; price: number }> = [];

    if (matchedMarket.polymarketTokenId && matchedMarket.polymarketPrice != null) {
      prices.push({
        platform: 'polymarket',
        marketId: matchedMarket.polymarketTokenId,
        price: side === 'YES' ? matchedMarket.polymarketPrice : (1 - matchedMarket.polymarketPrice),
      });
    }

    if (matchedMarket.kalshiTicker && matchedMarket.kalshiPrice != null) {
      prices.push({
        platform: 'kalshi',
        marketId: matchedMarket.kalshiTicker,
        price: side === 'YES' ? matchedMarket.kalshiPrice : (1 - matchedMarket.kalshiPrice),
      });
    }

    if (prices.length === 0) return null;

    // For BUY: choose lowest price. For SELL: choose highest price.
    prices.sort((a, b) => action === 'BUY' ? a.price - b.price : b.price - a.price);

    const best = prices[0];
    const worst = prices[prices.length - 1];
    const savings = Math.abs(best.price - worst.price);

    return { ...best, savings };
  }

  /**
   * Get matched markets (events available on both platforms).
   */
  getMatchedMarkets(): MatchedMarket[] {
    return [...this.matchedMarkets];
  }

  /**
   * Update matched markets list (from Dome matching API or manual mapping).
   */
  async updateMatchedMarkets(markets: MatchedMarket[]): Promise<void> {
    this.matchedMarkets = markets;
    try {
      const cfg = await Storage.loadConfig();
      cfg.matchedMarkets = this.matchedMarkets;
      await Storage.saveConfig(cfg);
    } catch { /* ignore */ }
  }

  /**
   * Get P&L history for charting.
   */
  getPnlHistory(): AggregatedPnl[] {
    return [...this.pnlHistory];
  }

  getStatus() {
    const latest = this.pnlHistory[this.pnlHistory.length - 1];
    return {
      matchedMarkets: this.matchedMarkets.length,
      pnlSnapshots: this.pnlHistory.length,
      latestPnl: latest ? {
        totalPnl: latest.totalPnl,
        totalPositions: latest.totalPositions,
        lastUpdated: latest.lastUpdated,
      } : null,
    };
  }

  private async savePnlHistory(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      cfg.pnlHistory = this.pnlHistory.slice(-100);
      await Storage.saveConfig(cfg);
    } catch { /* ignore */ }
  }
}
