import { ArbOpportunity } from './arbScanner.js';
import { DetectedHedge } from './entityManager.js';

// ============================================================================
// TYPES
// ============================================================================

/** A recommended hedge action */
export interface HedgeRecommendation {
  id: string;
  type: 'reduce_exposure' | 'full_hedge' | 'arb_capture';
  priority: 'high' | 'medium' | 'low';
  description: string;
  market: string;
  
  // What to do
  action: 'BUY' | 'SELL';
  platform: 'polymarket' | 'kalshi';
  outcome: string;
  size: number;           // Shares to trade
  estimatedCost: number;  // USDC cost
  estimatedPrice: number; // Per-share price
  
  // Context
  currentExposure?: {
    side: string;
    size: number;
    value: number;
  };
  expectedResult: {
    newExposure: number;
    profitIfCorrect: number;
    lossIfWrong: number;
    maxLoss: number;
  };
  
  // Execution
  tokenId?: string;       // Polymarket token ID (for one-click)
  kalshiTicker?: string;  // Kalshi ticker (for reference)
  executable: boolean;    // Can we auto-execute this?
  paperMode: boolean;     // In paper mode (simulation only)
}

/** Result of executing a hedge */
export interface HedgeExecutionResult {
  recommendationId: string;
  success: boolean;
  txHash?: string;
  executedPrice?: number;
  executedSize?: number;
  error?: string;
  paperMode: boolean;
  timestamp: string;
}

/** Configuration for hedge calculator */
export interface HedgeConfig {
  paperMode: boolean;           // Simulate trades instead of executing
  maxHedgeSizeUsd: number;      // Max USD per hedge trade
  autoExecuteArb: boolean;      // Auto-execute arb opportunities
  minArbSpreadPercent: number;  // Min spread to auto-execute
  maxArbSizeUsd: number;        // Max USD per arb trade
}

const DEFAULT_CONFIG: HedgeConfig = {
  paperMode: true,              // Paper mode ON by default (safety)
  maxHedgeSizeUsd: 50,
  autoExecuteArb: false,
  minArbSpreadPercent: 5,
  maxArbSizeUsd: 25,
};

// ============================================================================
// HEDGE CALCULATOR
// ============================================================================

export class HedgeCalculator {
  private config: HedgeConfig;
  private recommendations: HedgeRecommendation[] = [];
  private executionHistory: HedgeExecutionResult[] = [];

  constructor(config?: Partial<HedgeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate hedge recommendations from detected hedges.
   * Analyzes entity hedges and suggests actions to reduce risk.
   */
  generateHedgeRecommendations(hedges: DetectedHedge[]): HedgeRecommendation[] {
    const recommendations: HedgeRecommendation[] = [];

    for (const hedge of hedges) {
      // Only generate recommendations for partially hedged positions
      if (hedge.hedgeRatio >= 0.95) continue; // Already well-hedged

      const netSize = hedge.netExposureSize;
      if (netSize < 1) continue; // Negligible

      const isLongYes = hedge.netExposure === 'YES';
      const hedgeSize = Math.min(netSize, this.config.maxHedgeSizeUsd);

      recommendations.push({
        id: `hedge-${hedge.conditionId}-${Date.now()}`,
        type: 'reduce_exposure',
        priority: netSize > 100 ? 'high' : (netSize > 25 ? 'medium' : 'low'),
        description: `Reduce ${hedge.netExposure} exposure on "${hedge.marketTitle}" by ${hedgeSize.toFixed(1)} shares`,
        market: hedge.marketTitle,
        action: isLongYes ? 'SELL' : 'BUY',
        platform: 'polymarket',
        outcome: isLongYes ? 'YES' : 'NO',
        size: hedgeSize,
        estimatedCost: hedgeSize * 0.5, // Rough estimate
        estimatedPrice: 0.5,
        currentExposure: {
          side: hedge.netExposure,
          size: netSize,
          value: netSize * 0.5,
        },
        expectedResult: {
          newExposure: netSize - hedgeSize,
          profitIfCorrect: hedgeSize * 0.5,
          lossIfWrong: hedgeSize * 0.5,
          maxLoss: hedgeSize * 0.5,
        },
        executable: true,
        paperMode: this.config.paperMode,
      });
    }

    this.recommendations = recommendations;
    return recommendations;
  }

  /**
   * Generate arbitrage recommendations from detected opportunities.
   */
  generateArbRecommendations(opportunities: ArbOpportunity[]): HedgeRecommendation[] {
    const recommendations: HedgeRecommendation[] = [];

    for (const opp of opportunities) {
      if (opp.stale) continue; // Skip stale data
      if (opp.spreadPercent < this.config.minArbSpreadPercent) continue;

      const size = Math.min(this.config.maxArbSizeUsd, 100); // Cap at $100
      const cheaperPlatform = opp.direction === 'buy_poly_sell_kalshi' ? 'polymarket' : 'kalshi';
      const cheaperPrice = cheaperPlatform === 'polymarket' ? opp.polymarketPrice : opp.kalshiPrice;

      // Buy on cheaper platform
      recommendations.push({
        id: `arb-buy-${opp.id}-${Date.now()}`,
        type: 'arb_capture',
        priority: opp.spreadPercent > 10 ? 'high' : (opp.spreadPercent > 5 ? 'medium' : 'low'),
        description: `ARB: Buy ${opp.outcome} on ${cheaperPlatform} at $${cheaperPrice.toFixed(2)} (${opp.spreadPercent.toFixed(1)}% spread)`,
        market: opp.eventTitle,
        action: 'BUY',
        platform: cheaperPlatform as 'polymarket' | 'kalshi',
        outcome: opp.outcome,
        size: size / cheaperPrice,
        estimatedCost: size,
        estimatedPrice: cheaperPrice,
        expectedResult: {
          newExposure: size / cheaperPrice,
          profitIfCorrect: opp.estimatedProfit * (size / 100),
          lossIfWrong: size,
          maxLoss: size,
        },
        tokenId: cheaperPlatform === 'polymarket' ? opp.polymarketTokenId : undefined,
        kalshiTicker: cheaperPlatform === 'kalshi' ? opp.kalshiTicker : undefined,
        executable: cheaperPlatform === 'polymarket', // Can only auto-execute on Polymarket
        paperMode: this.config.paperMode,
      });
    }

    return recommendations;
  }

  /**
   * "Execute" a hedge recommendation.
   * In paper mode, logs the trade. In live mode, delegates to TradeExecutor.
   */
  async executeRecommendation(
    recommendation: HedgeRecommendation,
    executeFn?: (tokenId: string, side: 'BUY' | 'SELL', size: number) => Promise<{ success: boolean; txHash?: string; error?: string }>
  ): Promise<HedgeExecutionResult> {
    const result: HedgeExecutionResult = {
      recommendationId: recommendation.id,
      success: false,
      paperMode: this.config.paperMode || recommendation.paperMode,
      timestamp: new Date().toISOString(),
    };

    if (this.config.paperMode || recommendation.paperMode) {
      // Paper mode: simulate success
      result.success = true;
      result.executedPrice = recommendation.estimatedPrice;
      result.executedSize = recommendation.size;
      console.log(`[HedgeCalc] PAPER TRADE: ${recommendation.action} ${recommendation.size.toFixed(2)} shares of ${recommendation.outcome} on ${recommendation.platform} @ $${recommendation.estimatedPrice.toFixed(2)}`);
    } else if (recommendation.executable && recommendation.tokenId && executeFn) {
      // Live execution on Polymarket
      try {
        const execResult = await executeFn(recommendation.tokenId, recommendation.action, recommendation.size);
        result.success = execResult.success;
        result.txHash = execResult.txHash;
        result.error = execResult.error;
        result.executedPrice = recommendation.estimatedPrice;
        result.executedSize = recommendation.size;
      } catch (err: any) {
        result.error = err.message;
      }
    } else {
      result.error = recommendation.platform === 'kalshi'
        ? 'Kalshi execution not supported — manual trade required'
        : 'No execution function provided or recommendation not executable';
    }

    this.executionHistory.push(result);
    return result;
  }

  /**
   * Get current recommendations.
   */
  getRecommendations(): HedgeRecommendation[] {
    return [...this.recommendations];
  }

  /**
   * Get execution history.
   */
  getExecutionHistory(): HedgeExecutionResult[] {
    return [...this.executionHistory];
  }

  /**
   * Get config.
   */
  getConfig(): HedgeConfig {
    return { ...this.config };
  }

  /**
   * Update config.
   */
  updateConfig(updates: Partial<HedgeConfig>): void {
    Object.assign(this.config, updates);
  }

  /**
   * Get status.
   */
  getStatus() {
    return {
      config: this.getConfig(),
      recommendationCount: this.recommendations.length,
      executionHistoryCount: this.executionHistory.length,
      lastExecutions: this.executionHistory.slice(-10),
    };
  }
}
