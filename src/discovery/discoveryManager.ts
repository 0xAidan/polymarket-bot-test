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
} from './statsStore.js';
import { TradeIngestion } from './tradeIngestion.js';
import { ChainListener } from './chainListener.js';
import { ApiPoller } from './apiPoller.js';

export class DiscoveryManager {
  private ingestion: TradeIngestion;
  private chainListener: ChainListener | null = null;
  private apiPoller: ApiPoller | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt?: number;
  private config: DiscoveryConfig;

  constructor() {
    this.config = getDiscoveryConfig();
    this.ingestion = new TradeIngestion();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    this.config = getDiscoveryConfig();

    if (!this.config.enabled) {
      console.log('[DiscoveryManager] Discovery is disabled, skipping start');
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

    // Start stats aggregation + retention cleanup
    this.statsTimer = setInterval(() => {
      try {
        aggregateStats();
        runRetentionCleanup();
      } catch (err) {
        console.error('[DiscoveryManager] Stats aggregation error:', err);
      }
    }, this.config.statsIntervalMs);

    // Run initial aggregation
    try { aggregateStats(); } catch { /* ok on empty db */ }

    console.log('[DiscoveryManager] Discovery engine started');
  }

  async stop(): Promise<void> {
    console.log('[DiscoveryManager] Stopping discovery engine...');

    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    this.chainListener?.stop();
    this.apiPoller?.stop();
    this.ingestion.stop();

    this.chainListener = null;
    this.apiPoller = null;
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
    return getDiscoveryConfig();
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
    const pollerStatus = this.apiPoller?.getStatus() ?? { running: false, marketsMonitored: 0 };

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
        totalWallets: getTotalWalletCount(),
        totalTrades: getTotalTradeCount(),
        uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      },
    };
  }

  getWallets(sort: 'volume' | 'trades' | 'recent' = 'volume', limit = 50, offset = 0) {
    return getTopWallets(sort, limit, offset);
  }

  purgeData(olderThanDays: number): number {
    return purgeOldTrades(olderThanDays);
  }
}
