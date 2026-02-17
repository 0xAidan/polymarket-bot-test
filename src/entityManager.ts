import { Storage } from './storage.js';
import { PolymarketApi } from './polymarketApi.js';
import { domeGetPositions, isDomeConfigured } from './domeClient.js';
import { getAdapter, getConfiguredAdapters } from './platform/platformRegistry.js';
import type { NormalizedPosition } from './platform/types.js';

// ============================================================================
// TYPES
// ============================================================================

/** A wallet/account linked to a specific platform */
export interface PlatformWallet {
  platform: 'polymarket' | 'kalshi';
  identifier: string;  // Polymarket: 0x address, Kalshi: account ID
  label?: string;
}

/** A wallet entity groups multiple addresses/accounts under one identity */
export interface WalletEntity {
  id: string;
  label: string;
  walletAddresses: string[];           // Legacy: Polymarket-only addresses
  platformWallets: PlatformWallet[];   // New: platform-aware wallet links
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** A position held by a wallet */
export interface WalletPosition {
  platform: 'polymarket' | 'kalshi';
  walletAddress: string;
  tokenId: string;
  conditionId: string;
  outcome: string;
  marketTitle: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  side: 'YES' | 'NO';
}

/** Detected hedge: same market, opposite sides, across wallets in an entity */
export interface DetectedHedge {
  entityId: string;
  entityLabel: string;
  conditionId: string;
  marketTitle: string;
  yesPositions: Array<{ walletAddress: string; size: number; avgPrice: number }>;
  noPositions: Array<{ walletAddress: string; size: number; avgPrice: number }>;
  totalYesSize: number;
  totalNoSize: number;
  hedgeRatio: number;  // 0-1, where 1 = perfectly hedged
  netExposure: 'YES' | 'NO' | 'NEUTRAL';
  netExposureSize: number;
  estimatedHedgeCost: number;
  detectedAt: string;
}

/** Cross-platform hedge: same event, positions on both Polymarket and Kalshi */
export interface CrossPlatformHedge {
  entityId: string;
  entityLabel: string;
  eventTitle: string;
  polymarketPosition: {
    walletAddress: string;
    side: string;
    size: number;
    price: number;
    marketSlug: string;
  };
  kalshiPosition: {
    ticker: string;
    side: string;
    size: number;
    price: number;
  };
  isHedged: boolean;
  netExposure: string;
  detectedAt: string;
}

// ============================================================================
// ENTITY MANAGER
// ============================================================================

export class EntityManager {
  private entities: WalletEntity[] = [];
  private api: PolymarketApi;
  private hedges: DetectedHedge[] = [];
  private crossPlatformHedges: CrossPlatformHedge[] = [];
  private lastAnalysisTime = 0;

  constructor() {
    this.api = new PolymarketApi();
  }

  /**
   * Initialize: load entities from storage.
   */
  async init(): Promise<void> {
    await this.loadEntities();
    console.log(`[EntityManager] Loaded ${this.entities.length} entity(ies)`);
  }

  // ============================================================
  // ENTITY CRUD
  // ============================================================

  /**
   * Create a new entity grouping multiple wallets.
   */
  async createEntity(id: string, label: string, walletAddresses: string[], notes = '', platformWallets?: PlatformWallet[]): Promise<WalletEntity> {
    if (this.entities.find(e => e.id === id)) {
      throw new Error(`Entity "${id}" already exists`);
    }

    // Build platform wallets: merge explicit + legacy addresses (default to polymarket)
    const pw: PlatformWallet[] = platformWallets ? [...platformWallets] : [];
    for (const addr of walletAddresses) {
      const lower = addr.toLowerCase();
      if (!pw.find(p => p.platform === 'polymarket' && p.identifier.toLowerCase() === lower)) {
        pw.push({ platform: 'polymarket', identifier: lower });
      }
    }

    const entity: WalletEntity = {
      id,
      label,
      walletAddresses: walletAddresses.map(a => a.toLowerCase()),
      platformWallets: pw,
      notes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.entities.push(entity);
    await this.saveEntities();
    return entity;
  }

  /**
   * Add a platform wallet link to an entity.
   */
  async addPlatformWallet(entityId: string, pw: PlatformWallet): Promise<WalletEntity> {
    const entity = this.entities.find(e => e.id === entityId);
    if (!entity) throw new Error(`Entity "${entityId}" not found`);
    if (!entity.platformWallets) entity.platformWallets = [];

    const id = pw.identifier.toLowerCase();
    if (entity.platformWallets.find(p => p.platform === pw.platform && p.identifier.toLowerCase() === id)) {
      throw new Error(`${pw.platform} wallet ${pw.identifier} already in entity "${entityId}"`);
    }

    entity.platformWallets.push({ ...pw, identifier: id });

    // Keep legacy array in sync for polymarket
    if (pw.platform === 'polymarket' && !entity.walletAddresses.includes(id)) {
      entity.walletAddresses.push(id);
    }

    entity.updatedAt = new Date().toISOString();
    await this.saveEntities();
    return entity;
  }

  /**
   * Remove a platform wallet link from an entity.
   */
  async removePlatformWallet(entityId: string, platform: 'polymarket' | 'kalshi', identifier: string): Promise<WalletEntity> {
    const entity = this.entities.find(e => e.id === entityId);
    if (!entity) throw new Error(`Entity "${entityId}" not found`);
    if (!entity.platformWallets) entity.platformWallets = [];

    const id = identifier.toLowerCase();
    const idx = entity.platformWallets.findIndex(p => p.platform === platform && p.identifier.toLowerCase() === id);
    if (idx === -1) throw new Error(`${platform} wallet ${identifier} not in entity "${entityId}"`);

    entity.platformWallets.splice(idx, 1);

    // Keep legacy array in sync
    if (platform === 'polymarket') {
      entity.walletAddresses = entity.walletAddresses.filter(a => a !== id);
    }

    entity.updatedAt = new Date().toISOString();
    await this.saveEntities();
    return entity;
  }

  /**
   * Remove an entity.
   */
  async removeEntity(id: string): Promise<void> {
    const idx = this.entities.findIndex(e => e.id === id);
    if (idx === -1) throw new Error(`Entity "${id}" not found`);

    this.entities.splice(idx, 1);
    await this.saveEntities();
  }

  /**
   * Add a wallet address to an entity.
   */
  async addWalletToEntity(entityId: string, walletAddress: string): Promise<WalletEntity> {
    const entity = this.entities.find(e => e.id === entityId);
    if (!entity) throw new Error(`Entity "${entityId}" not found`);

    const addr = walletAddress.toLowerCase();
    if (entity.walletAddresses.includes(addr)) {
      throw new Error(`Wallet ${walletAddress} already in entity "${entityId}"`);
    }

    entity.walletAddresses.push(addr);
    entity.updatedAt = new Date().toISOString();
    await this.saveEntities();
    return entity;
  }

  /**
   * Remove a wallet address from an entity.
   */
  async removeWalletFromEntity(entityId: string, walletAddress: string): Promise<WalletEntity> {
    const entity = this.entities.find(e => e.id === entityId);
    if (!entity) throw new Error(`Entity "${entityId}" not found`);

    const addr = walletAddress.toLowerCase();
    const idx = entity.walletAddresses.indexOf(addr);
    if (idx === -1) throw new Error(`Wallet ${walletAddress} not in entity "${entityId}"`);

    entity.walletAddresses.splice(idx, 1);
    entity.updatedAt = new Date().toISOString();
    await this.saveEntities();
    return entity;
  }

  /**
   * Get all entities.
   */
  getEntities(): WalletEntity[] {
    return [...this.entities];
  }

  /**
   * Get a specific entity.
   */
  getEntity(id: string): WalletEntity | undefined {
    return this.entities.find(e => e.id === id);
  }

  /**
   * Find which entity a wallet belongs to.
   */
  findEntityForWallet(walletAddress: string): WalletEntity | undefined {
    const addr = walletAddress.toLowerCase();
    return this.entities.find(e => e.walletAddresses.includes(addr));
  }

  // ============================================================
  // HEDGE DETECTION
  // ============================================================

  /**
   * Analyze all entities for hedging behavior.
   * Returns detected hedges where the same entity has opposing positions.
   */
  async analyzeHedges(): Promise<DetectedHedge[]> {
    const allHedges: DetectedHedge[] = [];
    this.lastAnalysisTime = Date.now();

    for (const entity of this.entities) {
      const totalWallets = (entity.platformWallets?.length ?? 0) || entity.walletAddresses.length;
      if (totalWallets < 2) continue;

      try {
        const hedges = await this.analyzeEntityHedges(entity);
        allHedges.push(...hedges);
      } catch (err: any) {
        console.error(`[EntityManager] Failed to analyze entity "${entity.id}":`, err.message);
      }
    }

    this.hedges = allHedges;

    if (allHedges.length > 0) {
      console.log(`[EntityManager] Detected ${allHedges.length} hedge(s) across ${this.entities.length} entities`);
    }

    return allHedges;
  }

  /**
   * Analyze hedges for a single entity.
   */
  private async analyzeEntityHedges(entity: WalletEntity): Promise<DetectedHedge[]> {
    // Collect all positions across ALL platforms for this entity
    const allPositions: WalletPosition[] = [];

    // Use platformWallets if available, otherwise fall back to legacy walletAddresses
    const wallets: PlatformWallet[] = entity.platformWallets?.length
      ? entity.platformWallets
      : entity.walletAddresses.map(a => ({ platform: 'polymarket' as const, identifier: a }));

    for (const pw of wallets) {
      try {
        if (pw.platform === 'kalshi') {
          // Fetch Kalshi positions via adapter
          const adapter = getAdapter('kalshi');
          const positions = await adapter.getPositions(pw.identifier);
          allPositions.push(...positions.map(p => ({
            platform: 'kalshi' as const,
            walletAddress: pw.identifier,
            tokenId: p.marketId,
            conditionId: p.marketId, // Use ticker as cross-ref key
            outcome: p.outcome,
            marketTitle: p.marketTitle,
            size: p.size,
            avgPrice: p.avgPrice,
            currentPrice: p.currentPrice,
            side: p.side,
          })));
        } else {
          // Polymarket: use existing method
          const positions = await this.getWalletPositions(pw.identifier);
          allPositions.push(...positions);
        }
      } catch (err: any) {
        console.warn(`[EntityManager] Could not fetch ${pw.platform} positions for ${pw.identifier.slice(0, 10)}:`, err.message);
      }
    }

    if (allPositions.length === 0) return [];

    // Group positions by conditionId (market)
    const marketGroups = new Map<string, WalletPosition[]>();
    for (const pos of allPositions) {
      const key = pos.conditionId;
      if (!marketGroups.has(key)) marketGroups.set(key, []);
      marketGroups.get(key)!.push(pos);
    }

    // For each market, check if there are opposing positions
    const hedges: DetectedHedge[] = [];

    for (const [conditionId, positions] of marketGroups) {
      const yesPositions = positions.filter(p => p.side === 'YES');
      const noPositions = positions.filter(p => p.side === 'NO');

      // Only a hedge if we have both YES and NO positions from different wallets
      if (yesPositions.length === 0 || noPositions.length === 0) continue;

      const yesWallets = new Set(yesPositions.map(p => p.walletAddress));
      const noWallets = new Set(noPositions.map(p => p.walletAddress));

      // Check if positions are from different wallets
      const hasCrossWalletHedge = ![...yesWallets].every(w => noWallets.has(w));
      if (!hasCrossWalletHedge && yesWallets.size === 1 && noWallets.size === 1 && [...yesWallets][0] === [...noWallets][0]) {
        // Same wallet holding both sides is a self-hedge, still interesting
      }

      const totalYesSize = yesPositions.reduce((s, p) => s + p.size, 0);
      const totalNoSize = noPositions.reduce((s, p) => s + p.size, 0);
      const hedgedAmount = Math.min(totalYesSize, totalNoSize);
      const maxSide = Math.max(totalYesSize, totalNoSize);
      const hedgeRatio = maxSide > 0 ? hedgedAmount / maxSide : 0;
      const netExposureSize = Math.abs(totalYesSize - totalNoSize);

      hedges.push({
        entityId: entity.id,
        entityLabel: entity.label,
        conditionId,
        marketTitle: positions[0].marketTitle,
        yesPositions: yesPositions.map(p => ({
          walletAddress: p.walletAddress,
          size: p.size,
          avgPrice: p.avgPrice,
        })),
        noPositions: noPositions.map(p => ({
          walletAddress: p.walletAddress,
          size: p.size,
          avgPrice: p.avgPrice,
        })),
        totalYesSize,
        totalNoSize,
        hedgeRatio,
        netExposure: totalYesSize > totalNoSize ? 'YES' : (totalNoSize > totalYesSize ? 'NO' : 'NEUTRAL'),
        netExposureSize,
        estimatedHedgeCost: this.estimateHedgeCost(yesPositions, noPositions),
        detectedAt: new Date().toISOString(),
      });
    }

    return hedges;
  }

  /**
   * Get positions for a wallet address.
   */
  private async getWalletPositions(walletAddress: string): Promise<WalletPosition[]> {
    // Try Dome first, fall back to Polymarket API
    if (isDomeConfigured()) {
      try {
        const domePositions = await domeGetPositions(walletAddress);
        return domePositions.map((p: any) => ({
          platform: 'polymarket' as const,
          walletAddress,
          tokenId: p.token_id || p.asset || '',
          conditionId: p.condition_id || p.conditionId || '',
          outcome: p.outcome || 'Unknown',
          marketTitle: p.title || p.market_title || 'Unknown',
          size: parseFloat(p.size || '0'),
          avgPrice: parseFloat(p.avg_price || p.avgPrice || '0'),
          currentPrice: parseFloat(p.cur_price || p.curPrice || '0'),
          side: (p.outcome || '').toUpperCase().includes('NO') ? 'NO' as const : 'YES' as const,
        }));
      } catch {
        // Fall through to Polymarket API
      }
    }

    const positions = await this.api.getUserPositions(walletAddress);
    return positions.map((p: any) => ({
      platform: 'polymarket' as const,
      walletAddress,
      tokenId: p.asset || '',
      conditionId: p.conditionId || '',
      outcome: p.outcome || 'Unknown',
      marketTitle: p.title || p.slug || 'Unknown',
      size: parseFloat(p.size || '0'),
      avgPrice: parseFloat(p.avgPrice || '0'),
      currentPrice: parseFloat(p.curPrice || '0'),
      side: (p.outcome || '').toUpperCase().includes('NO') ? 'NO' as const : 'YES' as const,
    }));
  }

  /**
   * Estimate the cost of the hedge (sum of avg prices * sizes for both sides).
   */
  private estimateHedgeCost(
    yesPositions: WalletPosition[],
    noPositions: WalletPosition[]
  ): number {
    const yesCost = yesPositions.reduce((s, p) => s + p.size * p.avgPrice, 0);
    const noCost = noPositions.reduce((s, p) => s + p.size * p.avgPrice, 0);
    return yesCost + noCost;
  }

  // ============================================================
  // CROSS-PLATFORM HEDGE DETECTION
  // ============================================================

  /**
   * Detect hedging across platforms for all entities.
   * Finds entities that have positions on both Polymarket and Kalshi for the same event.
   * Uses Dome's matching markets API when available.
   */
  async detectCrossPlatformHedges(): Promise<CrossPlatformHedge[]> {
    const results: CrossPlatformHedge[] = [];

    for (const entity of this.entities) {
      const platformWallets = entity.platformWallets || entity.walletAddresses.map(a => ({ platform: 'polymarket' as const, identifier: a }));

      const polyWallets = platformWallets.filter(w => w.platform === 'polymarket');
      const kalshiWallets = platformWallets.filter(w => w.platform === 'kalshi');

      if (polyWallets.length === 0 || kalshiWallets.length === 0) continue;

      // Gather positions from both platforms
      const polyPositions: WalletPosition[] = [];
      const kalshiPositions: WalletPosition[] = [];

      for (const pw of polyWallets) {
        try {
          const pos = await this.getWalletPositions(pw.identifier);
          polyPositions.push(...pos);
        } catch { /* skip */ }
      }

      for (const kw of kalshiWallets) {
        try {
          const adapter = getAdapter('kalshi');
          const pos = await adapter.getPositions(kw.identifier);
          kalshiPositions.push(...pos.map(p => ({
            platform: 'kalshi' as const,
            walletAddress: kw.identifier,
            tokenId: p.marketId,
            conditionId: p.marketId,
            outcome: p.outcome,
            marketTitle: p.marketTitle,
            size: p.size,
            avgPrice: p.avgPrice,
            currentPrice: p.currentPrice,
            side: p.side,
          })));
        } catch { /* skip */ }
      }

      if (polyPositions.length === 0 || kalshiPositions.length === 0) continue;

      // Try to match markets across platforms by title similarity
      for (const pp of polyPositions) {
        for (const kp of kalshiPositions) {
          const titleMatch = this.fuzzyTitleMatch(pp.marketTitle, kp.marketTitle);
          if (!titleMatch) continue;

          const isHedged = pp.side !== kp.side;
          results.push({
            entityId: entity.id,
            entityLabel: entity.label,
            eventTitle: pp.marketTitle,
            polymarketPosition: {
              walletAddress: pp.walletAddress,
              side: pp.side,
              size: pp.size,
              price: pp.currentPrice,
              marketSlug: pp.tokenId,
            },
            kalshiPosition: {
              ticker: kp.tokenId,
              side: kp.side,
              size: kp.size,
              price: kp.currentPrice,
            },
            isHedged,
            netExposure: isHedged
              ? (pp.size > kp.size ? `YES-heavy (${(pp.size - kp.size).toFixed(2)})` : `NO-heavy (${(kp.size - pp.size).toFixed(2)})`)
              : `Same side (${pp.side})`,
            detectedAt: new Date().toISOString(),
          });
        }
      }
    }

    this.crossPlatformHedges = results;
    if (results.length > 0) {
      console.log(`[EntityManager] Detected ${results.length} cross-platform hedge(s)`);
    }
    return results;
  }

  /**
   * Fuzzy match market titles across platforms.
   * Basic approach: normalize and check overlap of significant words.
   */
  private fuzzyTitleMatch(a: string, b: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 2);
    const wordsA = normalize(a);
    const wordsB = normalize(b);
    if (wordsA.length === 0 || wordsB.length === 0) return false;
    const overlap = wordsA.filter(w => wordsB.includes(w)).length;
    const minLen = Math.min(wordsA.length, wordsB.length);
    return overlap / minLen >= 0.5; // At least 50% word overlap
  }

  // ============================================================
  // STATUS / QUERY
  // ============================================================

  /**
   * Get current status.
   */
  getStatus() {
    const totalPlatformWallets = this.entities.reduce(
      (s, e) => s + (e.platformWallets?.length || e.walletAddresses.length), 0
    );
    return {
      entityCount: this.entities.length,
      totalWalletsMapped: totalPlatformWallets,
      polymarketWallets: this.entities.reduce(
        (s, e) => s + (e.platformWallets?.filter(p => p.platform === 'polymarket').length || e.walletAddresses.length), 0
      ),
      kalshiAccounts: this.entities.reduce(
        (s, e) => s + (e.platformWallets?.filter(p => p.platform === 'kalshi').length || 0), 0
      ),
      hedgesDetected: this.hedges.length,
      crossPlatformHedgesDetected: this.crossPlatformHedges.length,
      lastAnalysisTime: this.lastAnalysisTime,
    };
  }

  /**
   * Get all detected hedges.
   */
  getHedges(): DetectedHedge[] {
    return [...this.hedges];
  }

  /**
   * Get detected cross-platform hedges.
   */
  getCrossPlatformHedges(): CrossPlatformHedge[] {
    return [...this.crossPlatformHedges];
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  private async loadEntities(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      this.entities = cfg.walletEntities ?? [];
    } catch { /* defaults */ }
  }

  private async saveEntities(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      cfg.walletEntities = this.entities;
      await Storage.saveConfig(cfg);
    } catch (err: any) {
      console.error('[EntityManager] Failed to save entities:', err.message);
    }
  }
}
