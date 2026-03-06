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
import { DiscoveredTrade, DiscoveryConfig, MarketCacheEntry } from './types.js';
import { refreshMarketCache } from './tradeEnricher.js';
import { getShortlistedMarkets } from './statsStore.js';
import { TradeIngestion } from './tradeIngestion.js';

const MARKET_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const MAX_TRADES_PER_MARKET = 100;
const REQUEST_DELAY_MS = 100; // 10 req/s to stay well within limits
const DEFAULT_REQUEST_BUDGET = 200;

export const buildRequestBudgetStatus = (
  metrics: {
    gammaRefreshRequests: number;
    tradePollRequests: number;
    verificationRequests: number;
  },
  budgetLimit = DEFAULT_REQUEST_BUDGET,
) => {
  const totalRequests = metrics.gammaRefreshRequests + metrics.tradePollRequests + metrics.verificationRequests;
  return {
    ...metrics,
    totalRequests,
    budgetLimit,
    withinBudget: totalRequests <= budgetLimit,
  };
};

export const buildMarketTradesRequestParams = (conditionId: string) => ({
  market: conditionId,
  limit: MAX_TRADES_PER_MARKET,
  takerOnly: false,
});

export const canStartPollCycle = (
  running: boolean,
  marketCount: number,
  pollInProgress: boolean,
): boolean => running && marketCount > 0 && !pollInProgress;

export const shouldStartApiPolling = (
  discoveryConfig: Pick<DiscoveryConfig, 'enabled' | 'broadPollingEnabled'>,
): boolean => discoveryConfig.enabled && discoveryConfig.broadPollingEnabled;

export class ApiPoller extends EventEmitter {
  private ingestion: TradeIngestion;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private marketRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private markets: MarketCacheEntry[] = [];
  private lastPollAt?: number;
  private pollIntervalMs: number;
  private marketCount: number;
  private pollInProgress = false;
  private requestMetrics = {
    gammaRefreshRequests: 0,
    tradePollRequests: 0,
    verificationRequests: 0,
  };

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

  getStatus(): {
    running: boolean;
    lastPollAt?: number;
    marketsMonitored: number;
    requestBudget: ReturnType<typeof buildRequestBudgetStatus>;
  } {
    return {
      running: this.running,
      lastPollAt: this.lastPollAt,
      marketsMonitored: this.markets.length,
      requestBudget: buildRequestBudgetStatus(this.requestMetrics),
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
      this.requestMetrics.gammaRefreshRequests += 1;
      const universe = await refreshMarketCache(this.marketCount);
      this.markets = getShortlistedMarkets(this.marketCount);
      if (this.markets.length === 0) {
        this.markets = universe.filter((market) => market.priorityTier === 'A' || market.priorityTier === 'B');
      }
      console.log(`[ApiPoller] Market cache refreshed: ${this.markets.length} markets`);
    } catch (err: any) {
      console.error('[ApiPoller] Failed to refresh markets:', err.message);
      this.emit('error', err);
    }
  }

  private async pollAllMarkets(): Promise<void> {
    if (!canStartPollCycle(this.running, this.markets.length, this.pollInProgress)) return;
    this.pollInProgress = true;

    let totalNew = 0;
    const now = Date.now();

    try {
      for (const market of this.markets) {
        if (!this.running) break;

        try {
          this.requestMetrics.tradePollRequests += 1;
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
    } finally {
      this.pollInProgress = false;
    }
  }

  private async fetchTradesForMarket(market: MarketCacheEntry): Promise<DiscoveredTrade[]> {
    const resp = await axios.get(`${config.polymarketDataApiUrl}/trades`, {
      params: buildMarketTradesRequestParams(market.conditionId),
      timeout: 10_000,
    });

    const rawTrades = resp.data || [];
    const now = Date.now();

    return rawTrades
      .map((t: any): DiscoveredTrade => mapApiTradeToDiscoveredTrade(t, market, now))
      .filter((t: DiscoveredTrade) => {
        const hasValidSide = t.side === 'BUY' || t.side === 'SELL';
        const hasValidSize = Number.isFinite(t.size) && t.size > 0;
        const hasValidPrice = Number.isFinite(t.price) && (t.price as number) > 0;
        return Boolean(t.maker && t.assetId && hasValidSide && hasValidSize && hasValidPrice);
      });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const resolveOutcomeLabel = (market: MarketCacheEntry, assetId: string): string | undefined => {
  if (!market.outcomes || market.outcomes.length === 0) return undefined;
  const tokenIdx = market.tokenIds.findIndex((tokenId) => tokenId === assetId);
  if (tokenIdx < 0 || tokenIdx >= market.outcomes.length) return undefined;
  return market.outcomes[tokenIdx];
};

export const mapApiTradeToDiscoveredTrade = (
  rawTrade: any,
  market: MarketCacheEntry,
  now = Date.now(),
): DiscoveredTrade => {
  const side = typeof rawTrade.side === 'string' ? rawTrade.side.toUpperCase() : '';
  const size = Number.parseFloat(String(rawTrade.size ?? '0'));
  const price = Number.parseFloat(String(rawTrade.price ?? '0'));
  const notionalUsd = Number.isFinite(size) && Number.isFinite(price) ? size * price : 0;
  const assetId = String(rawTrade.asset || rawTrade.tokenId || '');
  const outcome = String(rawTrade.outcome || resolveOutcomeLabel(market, assetId) || '');
  const detectedAt = rawTrade.timestamp
    ? (typeof rawTrade.timestamp === 'number' && rawTrade.timestamp < 1e12 ? rawTrade.timestamp * 1000 : Number(rawTrade.timestamp))
    : now;
  const txHash = String(rawTrade.transactionHash || rawTrade.id || rawTrade.tradeID || 'api');
  const eventKey = `${txHash}:${detectedAt}:${assetId}:${side}`;

  return {
    txHash: eventKey,
    eventKey,
    maker: String(rawTrade.proxyWallet || rawTrade.owner || rawTrade.maker || '').toLowerCase(),
    taker: '',
    assetId,
    conditionId: String(rawTrade.conditionId || market.conditionId || ''),
    marketSlug: rawTrade.slug || market.slug,
    marketTitle: rawTrade.title || market.title,
    outcome: outcome || undefined,
    side,
    size,
    price,
    notionalUsd,
    fee: 0,
    source: 'api',
    detectedAt,
  };
};
