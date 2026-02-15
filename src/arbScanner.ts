import { getDomeClient, isDomeConfigured, domeGetMarketPrice } from './domeClient.js';
import { Storage } from './storage.js';

// ============================================================================
// TYPES
// ============================================================================

/** A matched market pair across platforms */
export interface MatchedMarket {
  eventTitle: string;
  outcome: string;
  polymarket: {
    tokenId: string;
    slug: string;
    price: number;     // YES price on Polymarket
    lastUpdated: number;
  };
  kalshi: {
    ticker: string;
    eventTicker: string;
    price: number;     // YES price on Kalshi
    lastUpdated: number;
  };
}

/** Detected arbitrage opportunity */
export interface ArbOpportunity {
  id: string;
  eventTitle: string;
  outcome: string;
  spread: number;          // Price difference (always positive)
  spreadPercent: number;   // Percentage spread
  direction: 'buy_poly_sell_kalshi' | 'buy_kalshi_sell_poly';
  polymarketPrice: number;
  kalshiPrice: number;
  polymarketTokenId: string;
  kalshiTicker: string;
  estimatedProfit: number; // Per $100 deployed
  timestamp: number;
  stale: boolean;          // If prices are too old
}

/** Configuration for the arb scanner */
export interface ArbScannerConfig {
  enabled: boolean;
  scanIntervalMs: number;     // How often to scan (default 60s)
  minSpreadPercent: number;   // Minimum spread to flag (default 3%)
  maxStaleMs: number;         // Max age of price data before marking stale
  alertOnNewOpportunity: boolean;
}

const DEFAULT_CONFIG: ArbScannerConfig = {
  enabled: false,
  scanIntervalMs: 60_000,
  minSpreadPercent: 3,
  maxStaleMs: 120_000, // 2 minutes
  alertOnNewOpportunity: true,
};

// ============================================================================
// ARB SCANNER
// ============================================================================

export class ArbScanner {
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private config: ArbScannerConfig;

  // State
  private matchedMarkets: MatchedMarket[] = [];
  private opportunities: ArbOpportunity[] = [];
  private lastScanTime = 0;
  private scanCount = 0;
  private opportunitiesDetected = 0;

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Start the arb scanner.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    if (!isDomeConfigured()) {
      console.log('[ArbScanner] Dome API not configured — scanner disabled');
      return;
    }

    await this.loadConfig();

    if (!this.config.enabled) {
      console.log('[ArbScanner] Scanner is disabled in config');
      return;
    }

    this.isRunning = true;
    console.log(`[ArbScanner] Started — scanning every ${this.config.scanIntervalMs / 1000}s, min spread: ${this.config.minSpreadPercent}%`);

    this.scheduleScans();
  }

  /**
   * Stop the arb scanner.
   */
  stop(): void {
    this.isRunning = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    console.log('[ArbScanner] Stopped');
  }

  /**
   * Run a single scan cycle.
   */
  async scan(): Promise<ArbOpportunity[]> {
    this.lastScanTime = Date.now();
    this.scanCount++;

    try {
      // Step 1: Fetch matching markets from Dome
      await this.refreshMatchedMarkets();

      // Step 2: Compare prices and detect opportunities
      const newOpportunities = this.detectOpportunities();

      // Step 3: Update state
      this.opportunities = newOpportunities;

      if (newOpportunities.length > 0) {
        this.opportunitiesDetected += newOpportunities.length;
        console.log(`[ArbScanner] Found ${newOpportunities.length} opportunity(ies):`);
        for (const opp of newOpportunities) {
          console.log(`  - ${opp.eventTitle} (${opp.outcome}): ${opp.spreadPercent.toFixed(1)}% spread [Poly: $${opp.polymarketPrice.toFixed(2)} | Kalshi: $${opp.kalshiPrice.toFixed(2)}]`);
        }
      } else {
        console.log(`[ArbScanner] Scan #${this.scanCount} — no opportunities (${this.matchedMarkets.length} markets compared)`);
      }

      return newOpportunities;
    } catch (err: any) {
      console.error('[ArbScanner] Scan failed:', err.message);
      return [];
    }
  }

  /**
   * Refresh matched markets by fetching from Dome.
   */
  private async refreshMatchedMarkets(): Promise<void> {
    const dome = getDomeClient();
    if (!dome) return;

    try {
      // Use the matching markets endpoint to get cross-platform pairs
      const result = await dome.matchingMarkets.getMatchingMarkets({} as any);
      const matches = (result as any)?.matches ?? (result as any)?.data ?? [];

      if (!Array.isArray(matches) || matches.length === 0) {
        // Fallback: try to use the markets endpoint and manually match
        console.log('[ArbScanner] No matching markets from API, using cached data');
        return;
      }

      const now = Date.now();
      const updated: MatchedMarket[] = [];

      for (const match of matches) {
        const poly = match.polymarket;
        const kalshi = match.kalshi;

        if (!poly || !kalshi) continue;

        updated.push({
          eventTitle: match.event_title || match.title || 'Unknown Event',
          outcome: match.outcome || 'YES',
          polymarket: {
            tokenId: poly.token_id || poly.tokenId || '',
            slug: poly.slug || '',
            price: parseFloat(poly.price || poly.yes_price || '0'),
            lastUpdated: now,
          },
          kalshi: {
            ticker: kalshi.ticker || '',
            eventTicker: kalshi.event_ticker || '',
            price: parseFloat(kalshi.price || kalshi.yes_price || '0'),
            lastUpdated: now,
          },
        });
      }

      if (updated.length > 0) {
        this.matchedMarkets = updated;
        console.log(`[ArbScanner] Updated ${updated.length} matched market pairs`);
      }
    } catch (err: any) {
      console.error('[ArbScanner] Failed to refresh matched markets:', err.message);
    }
  }

  /**
   * Compare prices and detect arbitrage opportunities.
   */
  private detectOpportunities(): ArbOpportunity[] {
    const now = Date.now();
    const opportunities: ArbOpportunity[] = [];

    for (const market of this.matchedMarkets) {
      const polyPrice = market.polymarket.price;
      const kalshiPrice = market.kalshi.price;

      // Skip if prices are invalid
      if (polyPrice <= 0 || polyPrice >= 1 || kalshiPrice <= 0 || kalshiPrice >= 1) continue;

      const spread = Math.abs(polyPrice - kalshiPrice);
      const avgPrice = (polyPrice + kalshiPrice) / 2;
      const spreadPercent = (spread / avgPrice) * 100;

      // Check if above threshold
      if (spreadPercent < this.config.minSpreadPercent) continue;

      // Determine direction (buy cheap, sell expensive)
      const direction: ArbOpportunity['direction'] = polyPrice < kalshiPrice
        ? 'buy_poly_sell_kalshi'
        : 'buy_kalshi_sell_poly';

      // Estimated profit per $100 deployed (simplified)
      const estimatedProfit = spread * 100;

      // Check staleness
      const polyStale = (now - market.polymarket.lastUpdated) > this.config.maxStaleMs;
      const kalshiStale = (now - market.kalshi.lastUpdated) > this.config.maxStaleMs;

      opportunities.push({
        id: `${market.polymarket.tokenId}-${market.kalshi.ticker}`,
        eventTitle: market.eventTitle,
        outcome: market.outcome,
        spread,
        spreadPercent,
        direction,
        polymarketPrice: polyPrice,
        kalshiPrice: kalshiPrice,
        polymarketTokenId: market.polymarket.tokenId,
        kalshiTicker: market.kalshi.ticker,
        estimatedProfit,
        timestamp: now,
        stale: polyStale || kalshiStale,
      });
    }

    // Sort by spread (highest first)
    opportunities.sort((a, b) => b.spreadPercent - a.spreadPercent);

    return opportunities;
  }

  /**
   * Schedule periodic scans.
   */
  private scheduleScans(): void {
    if (this.scanInterval) clearInterval(this.scanInterval);

    this.scanInterval = setInterval(async () => {
      if (!this.isRunning) return;
      try { await this.scan(); }
      catch (err: any) { console.error('[ArbScanner] Scheduled scan error:', err.message); }
    }, this.config.scanIntervalMs);

    // Immediate first scan
    this.scan().catch(err => console.error('[ArbScanner] Initial scan error:', err.message));
  }

  /**
   * Get current status.
   */
  getStatus() {
    return {
      running: this.isRunning,
      config: { ...this.config },
      lastScanTime: this.lastScanTime,
      scanCount: this.scanCount,
      matchedMarketsCount: this.matchedMarkets.length,
      currentOpportunities: this.opportunities,
      stats: {
        totalOpportunitiesDetected: this.opportunitiesDetected,
      },
    };
  }

  /**
   * Get current opportunities.
   */
  getOpportunities(): ArbOpportunity[] {
    return [...this.opportunities];
  }

  /**
   * Get matched markets.
   */
  getMatchedMarkets(): MatchedMarket[] {
    return [...this.matchedMarkets];
  }

  /**
   * Update scanner config.
   */
  async updateConfig(updates: Partial<ArbScannerConfig>): Promise<void> {
    Object.assign(this.config, updates);
    await this.saveConfig();

    if (this.isRunning && this.config.enabled) {
      this.scheduleScans();
    } else if (!this.config.enabled) {
      this.stop();
    }
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  private async loadConfig(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      if (cfg.arbScannerConfig) {
        this.config = { ...DEFAULT_CONFIG, ...cfg.arbScannerConfig };
      }
    } catch { /* defaults */ }
  }

  private async saveConfig(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      cfg.arbScannerConfig = this.config;
      await Storage.saveConfig(cfg);
    } catch (err: any) {
      console.error('[ArbScanner] Failed to save config:', err.message);
    }
  }
}
