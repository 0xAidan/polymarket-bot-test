import { DomeClient } from '@dome-api/sdk';
import { EventEmitter } from 'events';
import { config } from './config.js';
import { DetectedTrade, TrackedWallet } from './types.js';
import { Storage } from './storage.js';

/**
 * Dome WebSocket order event data shape (from SDK docs).
 */
interface DomeOrderEvent {
  token_id: string;
  token_label?: string;
  side: 'BUY' | 'SELL';
  market_slug: string;
  condition_id: string;
  shares: number;             // Raw base units (6 decimals, e.g. 1000000 = 1 share)
  shares_normalized: number;  // Human-readable shares (e.g. 1.0)
  price: number;
  tx_hash: string;
  title: string;
  timestamp: number;
  order_hash: string;
  user: string;
  taker?: string;
}

/**
 * DomeWebSocketMonitor wraps the Dome SDK WebSocket client.
 * Uses dome.polymarket.createWebSocket() from the SDK.
 *
 * Events emitted:
 *   'connected'    - WebSocket open
 *   'disconnected' - WebSocket closed
 *   'reconnected'  - Reconnected after drop
 *   'trade'        - DetectedTrade mapped from a Dome order event
 *   'error'        - Connection or subscription error
 */
export class DomeWebSocketMonitor extends EventEmitter {
  private ws: any = null;
  private dome: DomeClient | null = null;
  private subscriptionId: string | null = null;
  private trackedAddresses: string[] = [];
  private running = false;

  constructor() {
    super();
  }

  /**
   * Start the WebSocket connection and subscribe to tracked wallets.
   */
  async start(): Promise<void> {
    if (!config.domeApiKey) {
      console.log('[DomeWS] No DOME_API_KEY configured, skipping WebSocket');
      return;
    }

    if (this.running) return;
    this.running = true;

    // Load current tracked wallet addresses
    const wallets = await Storage.loadTrackedWallets();
    this.trackedAddresses = wallets
      .filter(w => w.active)
      .map(w => w.address.toLowerCase());

    if (this.trackedAddresses.length === 0) {
      console.log('[DomeWS] No active wallets to monitor via WebSocket');
      return;
    }

    this.connect();
  }

  private connect(): void {
    try {
      this.dome = new DomeClient({ apiKey: config.domeApiKey });

      this.ws = this.dome.polymarket.createWebSocket({
        reconnect: {
          enabled: true,
          maxAttempts: 50,
          delay: 3000,
        },
        onOpen: () => {
          console.log('[DomeWS] Connected to Dome WebSocket');
          this.emit('connected');
          this.subscribeToWallets().catch(err =>
            console.error('[DomeWS] Subscribe failed after connect:', err)
          );
        },
        onClose: () => {
          console.log('[DomeWS] Disconnected from Dome WebSocket');
          this.emit('disconnected');
        },
        onError: (error: any) => {
          console.error('[DomeWS] WebSocket error:', error);
          this.emit('error', error);
        },
      });

      // Listen for order events
      this.ws.on('order', (data: DomeOrderEvent) => {
        this.handleOrderEvent(data);
      });

      // Connect
      this.ws.connect().catch((err: any) => {
        console.error('[DomeWS] Failed to connect:', err);
        this.emit('error', err);
      });
    } catch (err) {
      console.error('[DomeWS] Failed to create WebSocket connection:', err);
      this.emit('error', err);
    }
  }

  private async subscribeToWallets(): Promise<void> {
    if (!this.ws || this.trackedAddresses.length === 0) return;

    try {
      const sub = await this.ws.subscribe({
        users: this.trackedAddresses,
      });

      this.subscriptionId = sub?.subscription_id ?? null;
      console.log(`[DomeWS] Subscribed to ${this.trackedAddresses.length} wallets (sub: ${this.subscriptionId})`);
    } catch (err) {
      console.error('[DomeWS] Failed to subscribe:', err);
      this.emit('error', err);
    }
  }

  /**
   * Map a Dome order event to a DetectedTrade and emit it.
   * Also enriches the trade with the matching wallet's per-wallet config.
   */
  private async handleOrderEvent(data: DomeOrderEvent): Promise<void> {
    if (!data || !data.user) return;

    const userAddress = data.user.toLowerCase();

    // Only process events from our tracked wallets
    if (!this.trackedAddresses.includes(userAddress)) return;

    // Load wallet config for enrichment
    const wallet = await Storage.getWallet(userAddress);

    // Determine outcome from token_label if available
    let outcome: 'YES' | 'NO' = 'YES';
    if (data.token_label) {
      outcome = data.token_label.toUpperCase() === 'NO' ? 'NO' : 'YES';
    }

    // CRITICAL FIX: Use shares_normalized (human-readable, e.g. 14.56) instead of shares
    // (raw base units with 6 decimals, e.g. 14560000). Previously used data.shares which
    // caused amounts to be 1,000,000x too large, breaking threshold filters and display.
    const normalizedShares = data.shares_normalized ?? (data.shares / 1_000_000);
    
    const trade: DetectedTrade = {
      walletAddress: userAddress,
      marketId: data.condition_id,
      outcome,
      amount: String(normalizedShares),
      price: String(data.price),
      side: data.side,
      timestamp: new Date(data.timestamp * 1000),
      transactionHash: data.tx_hash || data.order_hash,
      tokenId: data.token_id,

      // Enrichment from wallet config
      ...(wallet ? this.enrichFromWallet(wallet) : {}),
    };

    this.emit('trade', trade);
  }

  /**
   * Extract per-wallet trade config fields from a TrackedWallet.
   */
  private enrichFromWallet(wallet: TrackedWallet): Partial<DetectedTrade> {
    return {
      tradeSizingMode: wallet.tradeSizingMode,
      fixedTradeSize: wallet.fixedTradeSize,
      thresholdEnabled: wallet.thresholdEnabled,
      thresholdPercent: wallet.thresholdPercent,
      tradeSideFilter: wallet.tradeSideFilter,
      noRepeatEnabled: wallet.noRepeatEnabled,
      noRepeatPeriodHours: wallet.noRepeatPeriodHours,
      priceLimitsMin: wallet.priceLimitsMin,
      priceLimitsMax: wallet.priceLimitsMax,
      rateLimitEnabled: wallet.rateLimitEnabled,
      rateLimitPerHour: wallet.rateLimitPerHour,
      rateLimitPerDay: wallet.rateLimitPerDay,
      valueFilterEnabled: wallet.valueFilterEnabled,
      valueFilterMin: wallet.valueFilterMin,
      valueFilterMax: wallet.valueFilterMax,
      slippagePercent: wallet.slippagePercent,
    };
  }

  /**
   * Add a wallet address to the subscription.
   */
  async addWallet(address: string): Promise<void> {
    const lower = address.toLowerCase();
    if (this.trackedAddresses.includes(lower)) return;
    this.trackedAddresses.push(lower);
    await this.updateSubscription();
  }

  /**
   * Remove a wallet address from the subscription.
   */
  async removeWallet(address: string): Promise<void> {
    const lower = address.toLowerCase();
    this.trackedAddresses = this.trackedAddresses.filter(a => a !== lower);
    await this.updateSubscription();
  }

  /**
   * Update the WS subscription with the current wallet list.
   */
  private async updateSubscription(): Promise<void> {
    if (!this.ws || !this.subscriptionId) return;

    if (this.trackedAddresses.length === 0) {
      try {
        await this.ws.unsubscribe(this.subscriptionId);
        this.subscriptionId = null;
      } catch { /* noop */ }
      return;
    }

    try {
      // Use the SDK's update method for efficiency
      await this.ws.update(this.subscriptionId, {
        users: this.trackedAddresses,
      });
      console.log(`[DomeWS] Updated subscription to ${this.trackedAddresses.length} wallets`);
    } catch (err) {
      console.error('[DomeWS] Failed to update subscription:', err);
      // Fallback: unsubscribe and re-subscribe
      try {
        await this.ws.unsubscribe(this.subscriptionId);
        await this.subscribeToWallets();
      } catch { /* noop */ }
    }
  }

  /**
   * Stop the WebSocket monitor.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.ws) {
      if (this.subscriptionId) {
        try { await this.ws.unsubscribe(this.subscriptionId); } catch { /* noop */ }
      }
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }

    this.dome = null;
    this.subscriptionId = null;
    this.trackedAddresses = [];
  }

  /**
   * Get current monitoring status.
   */
  getStatus(): { connected: boolean; subscriptionId: string | null; trackedWallets: number } {
    return {
      connected: this.ws !== null && this.running,
      subscriptionId: this.subscriptionId,
      trackedWallets: this.trackedAddresses.length,
    };
  }
}
