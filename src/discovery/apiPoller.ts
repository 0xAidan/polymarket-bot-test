/**
 * API Poller
 *
 * Fallback data source that polls the Polymarket Data API for recent trades
 * across the top N markets (by 24h volume). Refreshes the market list from
 * the Gamma API every 15 min.
 *
 * Detection latency: ~30s (poll interval).
 * Rate limits: Data API 200 req/10s, Gamma API is public/free.
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import { config } from '../config.js';
import { DiscoveredTrade, MarketCacheEntry } from './types.js';
import { refreshMarketCache } from './tradeEnricher.js';
import { TradeIngestion } from './tradeIngestion.js';

const MARKET_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const MAX_TRADES_PER_MARKET = 100;
const REQUEST_DELAY_MS = 100; // 10 req/s to stay well within limits

export class ApiPoller extends EventEmitter {
  private ingestion: TradeIngestion;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private marketRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private markets: MarketCacheEntry[] = [];
  private lastPollAt?: number;
  private pollIntervalMs: number;
  private marketCount: number;

  constructor(ingestion: TradeIngestion, pollIntervalMs: number, marketCount: number) {
    super();
    this.ingestion = ingestion;
    this.pollIntervalMs = pollIntervalMs;
    this.marketCount = marketCount;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log(`[ApiPoller] Starting — polling ${this.marketCount} markets every ${this.pollIntervalMs / 1000}s`);

    // Initial market list fetch
    await this.refreshMarkets();

    // Start polling trades
    this.pollTimer = setInterval(() => this.pollAllMarkets(), this.pollIntervalMs);

    // Refresh market list periodically
    this.marketRefreshTimer = setInterval(() => this.refreshMarkets(), MARKET_REFRESH_INTERVAL_MS);

    // Run first poll immediately
    this.pollAllMarkets();

    this.emit('started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.marketRefreshTimer) { clearInterval(this.marketRefreshTimer); this.marketRefreshTimer = null; }

    console.log('[ApiPoller] Stopped');
    this.emit('stopped');
  }

  getStatus(): { running: boolean; lastPollAt?: number; marketsMonitored: number } {
    return {
      running: this.running,
      lastPollAt: this.lastPollAt,
      marketsMonitored: this.markets.length,
    };
  }

  updateConfig(pollIntervalMs: number, marketCount: number): void {
    this.pollIntervalMs = pollIntervalMs;
    this.marketCount = marketCount;

    if (this.running) {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => this.pollAllMarkets(), this.pollIntervalMs);
    }
  }

  private async refreshMarkets(): Promise<void> {
    try {
      this.markets = await refreshMarketCache(this.marketCount);
      console.log(`[ApiPoller] Market cache refreshed: ${this.markets.length} markets`);
    } catch (err: any) {
      console.error('[ApiPoller] Failed to refresh markets:', err.message);
      this.emit('error', err);
    }
  }

  private async pollAllMarkets(): Promise<void> {
    if (!this.running || this.markets.length === 0) return;

    let totalNew = 0;
    const now = Date.now();

    for (const market of this.markets) {
      if (!this.running) break;

      try {
        const trades = await this.fetchTradesForMarket(market);
        if (trades.length > 0) {
          const newCount = await this.ingestion.ingestBatch(trades);
          totalNew += newCount;
        }
      } catch (err: any) {
        if (err.response?.status !== 404) {
          console.error(`[ApiPoller] Error polling market ${market.conditionId?.slice(0, 12)}:`, err.message);
        }
      }

      // Rate limit: small delay between markets
      await sleep(REQUEST_DELAY_MS);
    }

    this.lastPollAt = now;
    this.emit('poll', { marketsPolled: this.markets.length, newTrades: totalNew });
  }

  private async fetchTradesForMarket(market: MarketCacheEntry): Promise<DiscoveredTrade[]> {
    const resp = await axios.get(`${config.polymarketDataApiUrl}/trades`, {
      params: { market: market.conditionId, limit: MAX_TRADES_PER_MARKET },
      timeout: 10_000,
    });

    const rawTrades = resp.data || [];
    const now = Date.now();

    return rawTrades.map((t: any): DiscoveredTrade => ({
      txHash: t.transactionHash || t.id || `api-${t.timestamp}-${Math.random().toString(36).slice(2, 9)}`,
      maker: (t.maker || t.owner || '').toLowerCase(),
      taker: (t.taker || '').toLowerCase(),
      assetId: t.asset || t.tokenId || '',
      conditionId: market.conditionId,
      marketSlug: market.slug,
      marketTitle: market.title,
      side: t.side?.toUpperCase(),
      size: parseFloat(t.size || '0'),
      price: parseFloat(t.price || '0'),
      fee: 0,
      source: 'api' as const,
      detectedAt: t.timestamp ? (typeof t.timestamp === 'number' && t.timestamp < 1e12 ? t.timestamp * 1000 : Number(t.timestamp)) : now,
    })).filter((t: DiscoveredTrade) => t.maker && t.size > 0);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
