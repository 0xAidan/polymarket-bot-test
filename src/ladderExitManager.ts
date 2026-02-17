import { Storage } from './storage.js';

// ============================================================================
// TYPES
// ============================================================================

/** A ladder exit step: sell X shares when price hits Y */
export interface LadderStep {
  triggerPrice: number;   // Sell when price reaches this
  sellPercent: number;    // Percentage of remaining position to sell
  executed: boolean;
  executedAt?: string;
  executedPrice?: number;
  executedShares?: number;
}

/** A ladder exit configuration for a specific position */
export interface LadderExit {
  id: string;
  tokenId: string;
  conditionId: string;
  marketTitle: string;
  outcome: string;
  entryPrice: number;
  totalShares: number;
  remainingShares: number;
  steps: LadderStep[];
  isActive: boolean;
  createdAt: string;
  completedAt?: string;
}

/** Configuration for ladder exits */
export interface LadderExitConfig {
  enabled: boolean;
  liveMode: boolean;           // When true, execute real trades; when false, paper mode (log only)
  defaultStepCount: number;    // Default number of ladder steps
  defaultStartPercent: number; // First step: sell at entry + X%
  defaultStepSpread: number;   // Spread between steps (percentage points)
  defaultSellPercent: number;  // Percent of remaining to sell per step
}

const DEFAULT_LADDER_CONFIG: LadderExitConfig = {
  enabled: false,
  liveMode: false,             // Paper mode by default for safety
  defaultStepCount: 4,
  defaultStartPercent: 10,     // First take-profit at +10%
  defaultStepSpread: 10,       // Each step 10% apart
  defaultSellPercent: 25,      // Sell 25% of remaining at each step
};

// ============================================================================
// LADDER EXIT MANAGER
// ============================================================================

export class LadderExitManager {
  private ladders: LadderExit[] = [];
  private config: LadderExitConfig;

  constructor() {
    this.config = { ...DEFAULT_LADDER_CONFIG };
  }

  async init(): Promise<void> {
    await this.loadState();
    console.log(`[LadderExit] Loaded ${this.ladders.length} active ladder(s)`);
  }

  /**
   * Create a ladder exit for a position.
   */
  createLadder(
    tokenId: string,
    conditionId: string,
    marketTitle: string,
    outcome: string,
    entryPrice: number,
    totalShares: number,
    customSteps?: Partial<LadderStep>[]
  ): LadderExit {
    // Generate default steps if not provided
    let steps: LadderStep[];
    if (customSteps && customSteps.length > 0) {
      steps = customSteps.map(s => ({
        triggerPrice: s.triggerPrice ?? 0,
        sellPercent: s.sellPercent ?? this.config.defaultSellPercent,
        executed: false,
      }));
    } else {
      steps = [];
      for (let i = 0; i < this.config.defaultStepCount; i++) {
        const triggerPrice = Math.min(
          0.99,
          entryPrice + (this.config.defaultStartPercent + i * this.config.defaultStepSpread) / 100
        );
        steps.push({
          triggerPrice,
          sellPercent: this.config.defaultSellPercent,
          executed: false,
        });
      }
    }

    const ladder: LadderExit = {
      id: `ladder-${tokenId}-${Date.now()}`,
      tokenId,
      conditionId,
      marketTitle,
      outcome,
      entryPrice,
      totalShares,
      remainingShares: totalShares,
      steps,
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    this.ladders.push(ladder);
    this.saveState().catch(err => console.error('[LadderExit] Save failed:', err.message));
    return ladder;
  }

  /**
   * Check all active ladders against current prices.
   * Returns steps that should be executed.
   */
  checkLadders(priceMap: Map<string, number>): Array<{ ladder: LadderExit; step: LadderStep; sharesToSell: number }> {
    const toExecute: Array<{ ladder: LadderExit; step: LadderStep; sharesToSell: number }> = [];

    for (const ladder of this.ladders) {
      if (!ladder.isActive) continue;

      const currentPrice = priceMap.get(ladder.tokenId);
      if (currentPrice === undefined) continue;

      for (const step of ladder.steps) {
        if (step.executed) continue;
        if (currentPrice < step.triggerPrice) continue;

        // This step should be executed
        const sharesToSell = ladder.remainingShares * (step.sellPercent / 100);
        if (sharesToSell < 0.01) continue; // Skip negligible amounts

        toExecute.push({ ladder, step, sharesToSell });
      }
    }

    return toExecute;
  }

  /**
   * Mark a step as executed.
   */
  markStepExecuted(ladderId: string, stepIndex: number, executedPrice: number, executedShares: number): void {
    const ladder = this.ladders.find(l => l.id === ladderId);
    if (!ladder) return;

    const step = ladder.steps[stepIndex];
    if (!step) return;

    step.executed = true;
    step.executedAt = new Date().toISOString();
    step.executedPrice = executedPrice;
    step.executedShares = executedShares;

    ladder.remainingShares = Math.max(0, ladder.remainingShares - executedShares);

    // Check if all steps executed
    if (ladder.steps.every(s => s.executed) || ladder.remainingShares <= 0) {
      ladder.isActive = false;
      ladder.completedAt = new Date().toISOString();
    }

    this.saveState().catch(err => console.error('[LadderExit] Save failed:', err.message));
  }

  /**
   * Cancel a ladder.
   */
  cancelLadder(ladderId: string): void {
    const ladder = this.ladders.find(l => l.id === ladderId);
    if (ladder) {
      ladder.isActive = false;
      ladder.completedAt = new Date().toISOString();
      this.saveState().catch(err => console.error('[LadderExit] Save failed:', err.message));
    }
  }

  /**
   * Get all ladders.
   */
  getLadders(activeOnly = false): LadderExit[] {
    return activeOnly
      ? this.ladders.filter(l => l.isActive)
      : [...this.ladders];
  }

  /**
   * Get config.
   */
  getConfig(): LadderExitConfig { return { ...this.config }; }

  /**
   * Update config.
   */
  async updateConfig(updates: Partial<LadderExitConfig>): Promise<void> {
    Object.assign(this.config, updates);
    await this.saveState();
  }

  getStatus() {
    const active = this.ladders.filter(l => l.isActive);
    const completed = this.ladders.filter(l => !l.isActive);
    return {
      config: this.getConfig(),
      activeLadders: active.length,
      completedLadders: completed.length,
      totalStepsExecuted: this.ladders.reduce((s, l) => s + l.steps.filter(st => st.executed).length, 0),
    };
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  private async loadState(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      if (cfg.ladderExitConfig) this.config = { ...DEFAULT_LADDER_CONFIG, ...cfg.ladderExitConfig };
      if (cfg.ladderExits) this.ladders = cfg.ladderExits;
    } catch { /* defaults */ }
  }

  private async saveState(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      cfg.ladderExitConfig = this.config;
      cfg.ladderExits = this.ladders;
      await Storage.saveConfig(cfg);
    } catch (err: any) {
      console.error('[LadderExit] Failed to save:', err.message);
    }
  }
}
