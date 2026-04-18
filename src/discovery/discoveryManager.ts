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
import { ApiPoller } from './apiPoller.js';
import { refreshPositionPrices, backfillPositions } from './positionTracker.js';
import { evaluatePeriodicSignals } from './signalEngine.js';
import { computeScoresAndHeat } from './walletScorer.js';
import { getDatabase } from '../database.js';

const DEFAULT_BACKFILL_MAX_TRADES = 250_000;
import {
  clearDiscoveryRuntimeHeartbeat,
  getCurrentDiscoveryRuntimeHeartbeat,
  saveDiscoveryRuntimeHeartbeat,
} from './discoveryRuntimeState.js';

type DiscoveryManagerMode = 'worker' | 'passive';

export class DiscoveryManager {
  private ingestion: TradeIngestion;
  private chainListener: ChainListener | null = null;
  private apiPoller: ApiPoller | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt?: number;
  private config: DiscoveryConfig;
  private priceRefreshRunning = false;
  private statsCycleRunning = false;
  private initialBackfillStarted = false;
  private mode: DiscoveryManagerMode;
  private configSignature: string;

  constructor(mode: DiscoveryManagerMode = 'worker') {
    // Use defaults here — DB may not be initialized yet.
    // Real config is loaded in start() after the DB is ready.
    this.mode = mode;
    this.config = { ...DEFAULT_DISCOVERY_CONFIG };
    this.configSignature = JSON.stringify(this.config);
    this.ingestion = new TradeIngestion();
  }

  isPassiveRuntime(): boolean {
    return this.mode === 'passive';
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    this.config = getDiscoveryConfig();
    this.configSignature = JSON.stringify(this.config);

    if (this.mode === 'passive') {
      console.log('[DiscoveryManager] Passive discovery manager ready (worker-owned runtime)');
      return;
    }

    if (!this.config.enabled) {
      console.log('[DiscoveryManager] Discovery is disabled, skipping start');
      clearDiscoveryRuntimeHeartbeat();
      return;
    }

    console.log('[DiscoveryManager] Starting discovery engine...');
    this.startedAt = Date.now();

    // Start ingestion pipeline
    this.ingestion.start();

    // Start chain listener (if Alchemy URL configured)
    if (this.config.alchemyWsUrl) {
      this.chainListener = new ChainListener(this.ingestion, this.config.alchemyWsUrl);
      await this.chainListener.start();
    } else {
      console.log('[DiscoveryManager] No Alchemy WS URL — chain listener disabled');
    }

    // Start API poller
    this.apiPoller = new ApiPoller(
      this.ingestion,
      this.config.pollIntervalMs,
      this.config.marketCount,
    );
    await this.apiPoller.start();

    // Start stats aggregation + scoring + price refresh + signals + retention
    this.statsTimer = setInterval(() => {
      void this.runStatsCycle();
    }, this.config.statsIntervalMs);

    // Defer heavy backfill so worker API can come up immediately.
    this.scheduleInitialBackfill();

    // Run an initial best-effort stats cycle
    try { await refreshPositionPrices(); } catch { /* best-effort */ }
    try { aggregateStats(); } catch { /* ok on empty db */ }
    try { computeScoresAndHeat(); } catch { /* ok on empty db */ }
    try { evaluatePeriodicSignals(); } catch { /* ok on empty db */ }
    this.refreshHeartbeat();

    console.log('[DiscoveryManager] Discovery engine started');
  }

  private scheduleInitialBackfill(): void {
    if (this.initialBackfillStarted) return;
    this.initialBackfillStarted = true;
    setTimeout(() => {
      try {
        const db = getDatabase();
        const row = db.prepare(
          `SELECT COUNT(*) as cnt FROM discovery_trades WHERE side IS NOT NULL AND price IS NOT NULL AND price > 0 AND condition_id IS NOT NULL`
        ).get() as { cnt: number };
        const maxTrades = Number.parseInt(process.env.DISCOVERY_BACKFILL_MAX_TRADES || '', 10);
        const threshold = Number.isFinite(maxTrades) && maxTrades > 0 ? maxTrades : DEFAULT_BACKFILL_MAX_TRADES;
        if ((row?.cnt || 0) > threshold) {
          console.warn(
            `[DiscoveryManager] Skipping automatic position backfill (${row.cnt} trades > ${threshold} threshold).`
          );
          return;
        }
        backfillPositions();
      } catch (err: any) {
        console.error('[DiscoveryManager] Initial backfill skipped due to error:', err?.message || err);
      }
    }, 0);
  }

  private async runStatsCycle(): Promise<void> {
    if (this.statsCycleRunning) return;
    this.statsCycleRunning = true;

    await this.syncConfigFromStorage();
    if (this.mode !== 'worker' || !this.startedAt) {
      this.statsCycleRunning = false;
      return;
    }

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
      this.refreshHeartbeat();
      this.statsCycleRunning = false;
    }
  }

  async stop(): Promise<void> {
    if (this.mode === 'passive') {
      return;
    }

    console.log('[DiscoveryManager] Stopping discovery engine...');

    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    this.chainListener?.stop();
    this.apiPoller?.stop();
    this.ingestion.stop();

    this.chainListener = null;
    this.apiPoller = null;
    this.startedAt = undefined;
    clearDiscoveryRuntimeHeartbeat();

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
    this.configSignature = JSON.stringify(this.config);

    if (this.mode !== 'worker') {
      return this.config;
    }

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
    this.config = this.getConfig();
    const fallbackChainStatus = this.chainListener?.getStatus() ?? { connected: false, reconnectCount: 0 };
    const fallbackPollerStatus = this.apiPoller?.getStatus() ?? { running: false, marketsMonitored: 0 };
    const runtimeHeartbeat = getCurrentDiscoveryRuntimeHeartbeat();
    const heartbeatIsFresh = !!runtimeHeartbeat &&
      runtimeHeartbeat.running &&
      Date.now() - runtimeHeartbeat.lastHeartbeatAt <= Math.max(this.config.statsIntervalMs * 2, 60_000);
    const chainStatus = heartbeatIsFresh && runtimeHeartbeat?.chainListener
      ? runtimeHeartbeat.chainListener
      : fallbackChainStatus;
    const pollerStatus = heartbeatIsFresh && runtimeHeartbeat?.apiPoller
      ? runtimeHeartbeat.apiPoller
      : fallbackPollerStatus;

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
      },
      stats: {
        totalWallets,
        totalTrades,
        uptimeMs: heartbeatIsFresh && runtimeHeartbeat
          ? Date.now() - runtimeHeartbeat.startedAt
          : this.startedAt
            ? Date.now() - this.startedAt
            : 0,
      },
    };
  }

  getWallets(
    sort: 'volume' | 'trades' | 'recent' | 'score' | 'roi' | 'trust' = 'trust',
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

  private async syncConfigFromStorage(): Promise<void> {
    const latestConfig = getDiscoveryConfig();
    const latestSignature = JSON.stringify(latestConfig);

    if (latestSignature === this.configSignature) {
      return;
    }

    const previousConfig = this.config;
    this.config = latestConfig;
    this.configSignature = latestSignature;

    if (this.mode !== 'worker') {
      return;
    }

    if (!latestConfig.enabled) {
      console.log('[DiscoveryManager] Discovery disabled via config update - stopping worker');
      await this.stop();
      return;
    }

    if (this.apiPoller) {
      this.apiPoller.updateConfig(latestConfig.pollIntervalMs, latestConfig.marketCount);
    }

    if (this.statsTimer && previousConfig.statsIntervalMs !== latestConfig.statsIntervalMs) {
      clearInterval(this.statsTimer);
      this.statsTimer = setInterval(() => {
        void this.runStatsCycle();
      }, latestConfig.statsIntervalMs);
    }

    if (latestConfig.alchemyWsUrl) {
      if (!this.chainListener) {
        this.chainListener = new ChainListener(this.ingestion, latestConfig.alchemyWsUrl);
        await this.chainListener.start();
      } else if (previousConfig.alchemyWsUrl !== latestConfig.alchemyWsUrl) {
        this.chainListener.updateUrl(latestConfig.alchemyWsUrl);
      }
    } else if (this.chainListener) {
      this.chainListener.stop();
      this.chainListener = null;
    }
  }

  private refreshHeartbeat(): void {
    if (this.mode !== 'worker' || !this.startedAt) {
      return;
    }

    saveDiscoveryRuntimeHeartbeat(undefined, {
      mode: 'discovery-worker',
      pid: process.pid,
      running: true,
      startedAt: this.startedAt,
      lastHeartbeatAt: Date.now(),
      chainListener: this.chainListener?.getStatus() ?? { connected: false, reconnectCount: 0 },
      apiPoller: this.apiPoller?.getStatus() ?? { running: false, marketsMonitored: 0 },
    });
  }
}
