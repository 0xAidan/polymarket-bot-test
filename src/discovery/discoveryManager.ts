/**
 * Discovery Manager
 *
 * Orchestrates the entire discovery engine: starts/stops the chain listener
 * and API poller, manages the enrichment queue, runs periodic stats
 * aggregation, and exposes health status. Single entry point for the
 * rest of the application.
 */

import {
  DiscoveryConfig,
  DiscoveryStatus,
  DEFAULT_DISCOVERY_CONFIG,
} from './types.js';
import {
  getDiscoveryConfig,
  updateDiscoveryConfig,
  aggregateStats,
  runRetentionCleanup,
  getTopWallets,
  getTotalWalletCount,
  getTotalTradeCount,
  purgeOldTrades,
  purgeAllDiscoveryData,
  cleanupOldSignals,
  cleanupStalePositions,
} from './statsStore.js';
import { TradeIngestion } from './tradeIngestion.js';
import { ChainListener } from './chainListener.js';
import { ApiPoller, shouldStartApiPolling } from './apiPoller.js';
import { refreshPositionPrices, backfillPositions } from './positionTracker.js';
import { evaluatePeriodicSignals } from './signalEngine.js';
import { computeScoresAndHeat } from './walletScorer.js';
import { initDiscoveryDatabase } from './discoveryDatabase.js';
import { refreshMarketCache } from './tradeEnricher.js';
import { getShortlistedMarkets } from './statsStore.js';
import { MarketStream } from './marketStream.js';

export class DiscoveryManager {
  private ingestion: TradeIngestion;
  private chainListener: ChainListener | null = null;
  private apiPoller: ApiPoller | null = null;
  private marketStream: MarketStream | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt?: number;
  private config: DiscoveryConfig;
  private priceRefreshRunning = false;
  private statsCycleRunning = false;

  constructor() {
    // Use defaults here — DB may not be initialized yet.
    // Real config is loaded in start() after the DB is ready.
    this.config = { ...DEFAULT_DISCOVERY_CONFIG };
    this.ingestion = new TradeIngestion();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    await initDiscoveryDatabase();
    this.config = getDiscoveryConfig();

    if (!this.config.enabled) {
      console.log('[DiscoveryManager] Discovery is disabled, skipping start');
      return;
    }

    console.log('[DiscoveryManager] Starting discovery engine...');
    this.startedAt = Date.now();

    // Start ingestion pipeline
    this.ingestion.start();

    try {
      await refreshMarketCache(this.config.marketCount);
      this.marketStream = new MarketStream();
      this.marketStream.updateMarkets(getShortlistedMarkets(this.config.marketCount));
      this.marketStream.start();
    } catch (err) {
      console.error('[DiscoveryManager] Failed to prepare market stream shortlist:', err);
      this.marketStream = null;
    }

    // Start chain listener (if Alchemy URL configured)
    if (this.config.alchemyWsUrl) {
      this.chainListener = new ChainListener(this.ingestion, this.config.alchemyWsUrl);
      await this.chainListener.start();
    } else {
      console.log('[DiscoveryManager] No Alchemy WS URL — chain listener disabled');
    }

    // Broad polling stays off by default during the freeze period.
    if (shouldStartApiPolling(this.config)) {
      this.apiPoller = new ApiPoller(
        this.ingestion,
        this.config.pollIntervalMs,
        this.config.marketCount,
      );
      await this.apiPoller.start();
    } else {
      this.apiPoller = null;
      console.log('[DiscoveryManager] Broad API polling is disabled');
    }

    // Start stats aggregation + scoring + price refresh + signals + retention
    this.statsTimer = setInterval(() => {
      void this.runStatsCycle();
    }, this.config.statsIntervalMs);

    // Backfill positions from existing trades, then run full stats cycle
    try { backfillPositions(); } catch { /* ok on empty db */ }
    try { await refreshPositionPrices(); } catch { /* best-effort */ }
    try { aggregateStats(); } catch { /* ok on empty db */ }
    try { computeScoresAndHeat(); } catch { /* ok on empty db */ }
    try { evaluatePeriodicSignals(); } catch { /* ok on empty db */ }

    console.log('[DiscoveryManager] Discovery engine started');
  }

  private async runStatsCycle(): Promise<void> {
    if (this.statsCycleRunning) return;
    this.statsCycleRunning = true;

    if (!this.priceRefreshRunning) {
      this.priceRefreshRunning = true;
      try {
        await refreshPositionPrices();
      } catch (err) {
        console.error('[DiscoveryManager] Price refresh error:', err);
      } finally {
        this.priceRefreshRunning = false;
      }
    }

    try {
      aggregateStats();
    } catch (err) {
      console.error('[DiscoveryManager] Stats aggregation error:', err);
    }
    try {
      computeScoresAndHeat();
    } catch (err) {
      console.error('[DiscoveryManager] Scoring error:', err);
    }
    try {
      evaluatePeriodicSignals();
    } catch (err) {
      console.error('[DiscoveryManager] Periodic signals error:', err);
    }
    try {
      runRetentionCleanup();
      cleanupOldSignals(30);
      cleanupStalePositions(90);
    } catch (err) {
      console.error('[DiscoveryManager] Retention cleanup error:', err);
    } finally {
      this.statsCycleRunning = false;
    }
  }

  async stop(): Promise<void> {
    console.log('[DiscoveryManager] Stopping discovery engine...');

    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    this.chainListener?.stop();
    this.apiPoller?.stop();
    this.marketStream?.stop();
    this.ingestion.stop();

    this.chainListener = null;
    this.apiPoller = null;
    this.marketStream = null;
    this.startedAt = undefined;

    console.log('[DiscoveryManager] Discovery engine stopped');
  }

  /**
   * Restart the engine (e.g. after config change).
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // -----------------------------------------------------------------------
  // Config management
  // -----------------------------------------------------------------------

  getConfig(): DiscoveryConfig {
    try {
      return getDiscoveryConfig();
    } catch {
      return { ...DEFAULT_DISCOVERY_CONFIG };
    }
  }

  async updateConfig(updates: Partial<DiscoveryConfig>): Promise<DiscoveryConfig> {
    updateDiscoveryConfig(updates);
    this.config = getDiscoveryConfig();

    // Live-update the poller if it's running (no restart needed)
    if (this.apiPoller) {
      this.apiPoller.updateConfig(
        this.config.pollIntervalMs,
        this.config.marketCount,
      );
    }

    // Update chain listener URL if changed
    if (updates.alchemyWsUrl !== undefined && this.chainListener) {
      this.chainListener.updateUrl(this.config.alchemyWsUrl);
    }

    return this.config;
  }

  // -----------------------------------------------------------------------
  // Status & data access
  // -----------------------------------------------------------------------

  getStatus(): DiscoveryStatus {
    const chainStatus = this.chainListener?.getStatus() ?? { connected: false, reconnectCount: 0 };
    const pollerStatus = this.apiPoller?.getStatus() ?? {
      running: false,
      marketsMonitored: 0,
      requestBudget: {
        gammaRefreshRequests: 0,
        tradePollRequests: 0,
        verificationRequests: 0,
        totalRequests: 0,
        budgetLimit: 200,
        withinBudget: true,
      },
    };

    let totalWallets = 0;
    let totalTrades = 0;
    try {
      totalWallets = getTotalWalletCount();
      totalTrades = getTotalTradeCount();
    } catch { /* DB not ready yet */ }

    return {
      enabled: this.config.enabled,
      chainListener: {
        connected: chainStatus.connected,
        lastEventAt: chainStatus.lastEventAt,
        reconnectCount: chainStatus.reconnectCount,
      },
      apiPoller: {
        running: pollerStatus.running,
        lastPollAt: pollerStatus.lastPollAt,
        marketsMonitored: pollerStatus.marketsMonitored,
        requestBudget: pollerStatus.requestBudget,
      },
      stats: {
        totalWallets,
        totalTrades,
        uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      },
    };
  }

  getWallets(
    sort: 'volume' | 'trades' | 'recent' | 'score' | 'roi' = 'volume',
    limit = 50,
    offset = 0,
    filters?: { minScore?: number; heat?: string; hasSignals?: boolean }
  ) {
    try {
      return getTopWallets(sort, limit, offset, filters);
    } catch {
      return [];
    }
  }

  purgeData(olderThanDays: number): number {
    try {
      return purgeOldTrades(olderThanDays);
    } catch {
      return 0;
    }
  }

  resetData(): {
    trades: number;
    wallets: number;
    positions: number;
    signals: number;
    marketCache: number;
    total: number;
  } {
    try {
      this.ingestion.resetState();
      return purgeAllDiscoveryData();
    } catch {
      return { trades: 0, wallets: 0, positions: 0, signals: 0, marketCache: 0, total: 0 };
    }
  }
}
