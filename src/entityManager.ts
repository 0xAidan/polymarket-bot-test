import { Storage } from './storage.js';
import { PolymarketApi } from './polymarketApi.js';
import { domeGetPositions, isDomeConfigured } from './domeClient.js';

// ============================================================================
// TYPES
// ============================================================================

/** A wallet entity groups multiple addresses under one identity */
export interface WalletEntity {
  id: string;
  label: string;
  walletAddresses: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** A position held by a wallet */
export interface WalletPosition {
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
  async createEntity(id: string, label: string, walletAddresses: string[], notes = ''): Promise<WalletEntity> {
    if (this.entities.find(e => e.id === id)) {
      throw new Error(`Entity "${id}" already exists`);
    }

    const entity: WalletEntity = {
      id,
      label,
      walletAddresses: walletAddresses.map(a => a.toLowerCase()),
      notes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.entities.push(entity);
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
      if (entity.walletAddresses.length < 2) continue;

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
    // Collect all positions across all wallets in this entity
    const allPositions: WalletPosition[] = [];

    for (const addr of entity.walletAddresses) {
      try {
        const positions = await this.getWalletPositions(addr);
        allPositions.push(...positions);
      } catch (err: any) {
        console.warn(`[EntityManager] Could not fetch positions for ${addr.slice(0, 10)}:`, err.message);
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
  // STATUS / QUERY
  // ============================================================

  /**
   * Get current status.
   */
  getStatus() {
    return {
      entityCount: this.entities.length,
      totalWalletsMapped: this.entities.reduce((s, e) => s + e.walletAddresses.length, 0),
      hedgesDetected: this.hedges.length,
      lastAnalysisTime: this.lastAnalysisTime,
    };
  }

  /**
   * Get all detected hedges.
   */
  getHedges(): DetectedHedge[] {
    return [...this.hedges];
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
