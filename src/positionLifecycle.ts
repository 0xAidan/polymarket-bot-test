import * as ethers from 'ethers';
import { config } from './config.js';
import { PolymarketApi } from './polymarketApi.js';
import { Storage } from './storage.js';

// Polymarket contract addresses on Polygon
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';

// Minimal ABIs for the functions we need
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 amount) external',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
];

const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external',
];

/** Represents a position that can be redeemed or merged */
export interface RedeemablePosition {
  conditionId: string;
  tokenId: string;
  outcome: string;
  size: number;
  currentPrice: number;
  marketTitle: string;
  marketSlug: string;
  negRisk: boolean;
  redeemable: boolean;
  mergeable: boolean;
  estimatedPayout: number;
}

/** Result of a redeem/merge operation */
export interface RedemptionResult {
  conditionId: string;
  tokenId: string;
  marketTitle: string;
  action: 'redeem' | 'merge';
  success: boolean;
  txHash?: string;
  error?: string;
  amountRecovered: number;
}

/** Configuration for the position lifecycle manager */
export interface LifecycleConfig {
  autoRedeemEnabled: boolean;
  autoMergeEnabled: boolean;
  checkIntervalMs: number;
  minRedeemValue: number; // Min USDC value to bother redeeming
}

const DEFAULT_CONFIG: LifecycleConfig = {
  autoRedeemEnabled: false,
  autoMergeEnabled: false,
  checkIntervalMs: 300_000, // 5 minutes
  minRedeemValue: 0.10,
};

/**
 * PositionLifecycleManager handles auto-redemption and auto-merge
 * of resolved Polymarket positions.
 */
export class PositionLifecycleManager {
  private api: PolymarketApi;
  private provider: ethers.providers.JsonRpcProvider;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastCheckTime: number = 0;
  private lastResults: RedemptionResult[] = [];
  private lifecycleConfig: LifecycleConfig;

  // Stats
  private totalRedemptions = 0;
  private totalMerges = 0;
  private totalRecovered = 0;

  constructor() {
    this.api = new PolymarketApi();
    this.provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    this.lifecycleConfig = { ...DEFAULT_CONFIG };
  }

  /**
   * Start the lifecycle manager with periodic checks.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Load saved config
    await this.loadConfig();

    console.log('[Lifecycle] Position lifecycle manager started');
    console.log(`[Lifecycle]   Auto-redeem: ${this.lifecycleConfig.autoRedeemEnabled ? 'ON' : 'OFF'}`);
    console.log(`[Lifecycle]   Auto-merge: ${this.lifecycleConfig.autoMergeEnabled ? 'ON' : 'OFF'}`);
    console.log(`[Lifecycle]   Check interval: ${this.lifecycleConfig.checkIntervalMs / 1000}s`);

    // Run initial check
    if (this.lifecycleConfig.autoRedeemEnabled || this.lifecycleConfig.autoMergeEnabled) {
      this.scheduleCheck();
    }
  }

  /**
   * Stop the lifecycle manager.
   */
  stop(): void {
    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log('[Lifecycle] Position lifecycle manager stopped');
  }

  /**
   * Schedule periodic position checks.
   */
  private scheduleCheck(): void {
    if (this.checkInterval) clearInterval(this.checkInterval);

    this.checkInterval = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        await this.checkAndProcess();
      } catch (err: any) {
        console.error('[Lifecycle] Check failed:', err.message);
      }
    }, this.lifecycleConfig.checkIntervalMs);

    // Also run immediately
    this.checkAndProcess().catch(err => console.error('[Lifecycle] Initial check failed:', err.message));
  }

  /**
   * Check for redeemable/mergeable positions and process them.
   */
  async checkAndProcess(): Promise<RedemptionResult[]> {
    this.lastCheckTime = Date.now();
    const results: RedemptionResult[] = [];

    try {
      // Get our positions
      const positions = await this.getRedeemablePositions();

      if (positions.length === 0) {
        console.log('[Lifecycle] No redeemable or mergeable positions found');
        return results;
      }

      console.log(`[Lifecycle] Found ${positions.length} position(s) to process`);

      for (const pos of positions) {
        // Skip if below minimum value
        if (pos.estimatedPayout < this.lifecycleConfig.minRedeemValue) {
          console.log(`[Lifecycle] Skipping ${pos.marketTitle} — payout $${pos.estimatedPayout.toFixed(2)} below min $${this.lifecycleConfig.minRedeemValue}`);
          continue;
        }

        if (pos.redeemable && this.lifecycleConfig.autoRedeemEnabled) {
          const result = await this.redeemPosition(pos);
          results.push(result);
          if (result.success) {
            this.totalRedemptions++;
            this.totalRecovered += result.amountRecovered;
          }
        }

        if (pos.mergeable && this.lifecycleConfig.autoMergeEnabled) {
          const result = await this.mergePosition(pos);
          results.push(result);
          if (result.success) {
            this.totalMerges++;
            this.totalRecovered += result.amountRecovered;
          }
        }
      }

      this.lastResults = results;
      return results;
    } catch (err: any) {
      console.error('[Lifecycle] Error during check:', err.message);
      return results;
    }
  }

  /**
   * Get positions that are redeemable or mergeable.
   * Uses the Polymarket Data API to find resolved markets.
   */
  async getRedeemablePositions(): Promise<RedeemablePosition[]> {
    const redeemable: RedeemablePosition[] = [];

    try {
      // Fetch our positions from the Data API
      const walletAddress = config.userWalletAddress;
      if (!walletAddress) return redeemable;

      const positions = await this.api.getUserPositions(walletAddress);
      if (!positions || positions.length === 0) return redeemable;

      for (const pos of positions) {
        const size = parseFloat(pos.size || '0');
        if (size <= 0) continue;

        const curPrice = parseFloat(pos.curPrice || pos.currentPrice || '0');
        const outcome = pos.outcome || 'Unknown';
        const conditionId = pos.conditionId || '';
        const tokenId = pos.asset || '';

        // A position is "resolved" when the market is closed and the price is 0 or 1
        // Price = 1 means winning position (redeemable)
        // Price = 0 means losing position
        // Check for resolved status
        const isResolved = curPrice === 0 || curPrice === 1 || curPrice >= 0.999 || curPrice <= 0.001;
        const isWinning = curPrice >= 0.999;

        if (isResolved && isWinning) {
          redeemable.push({
            conditionId,
            tokenId,
            outcome,
            size,
            currentPrice: curPrice,
            marketTitle: pos.title || pos.marketSlug || 'Unknown Market',
            marketSlug: pos.slug || '',
            negRisk: pos.negRisk === true,
            redeemable: true,
            mergeable: false,
            estimatedPayout: size * curPrice,
          });
        }
      }

      return redeemable;
    } catch (err: any) {
      console.error('[Lifecycle] Error fetching redeemable positions:', err.message);
      return redeemable;
    }
  }

  /**
   * Redeem a winning position on-chain.
   */
  async redeemPosition(pos: RedeemablePosition): Promise<RedemptionResult> {
    const baseResult: RedemptionResult = {
      conditionId: pos.conditionId,
      tokenId: pos.tokenId,
      marketTitle: pos.marketTitle,
      action: 'redeem',
      success: false,
      amountRecovered: 0,
    };

    try {
      if (!config.privateKey) {
        return { ...baseResult, error: 'No private key configured' };
      }

      const signer = new ethers.Wallet(config.privateKey, this.provider);
      const conditionIdBytes = pos.conditionId;

      if (pos.negRisk) {
        // NegRisk markets use the NegRisk Adapter
        const negRisk = new ethers.Contract(NEG_RISK_ADAPTER_ADDRESS, NEG_RISK_ABI, signer);
        const amounts = [ethers.utils.parseUnits(pos.size.toString(), 6), 0]; // [yesAmount, noAmount]

        console.log(`[Lifecycle] Redeeming negRisk position: ${pos.marketTitle} (${pos.size} shares)`);
        const tx = await negRisk.redeemPositions(conditionIdBytes, amounts);
        const receipt = await tx.wait();

        return {
          ...baseResult,
          success: true,
          txHash: receipt.hash,
          amountRecovered: pos.estimatedPayout,
        };
      } else {
        // Standard CTF redemption
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);
        const parentCollectionId = ethers.constants.HashZero;
        const indexSets = [1, 2]; // Both outcomes for binary market

        console.log(`[Lifecycle] Redeeming CTF position: ${pos.marketTitle} (${pos.size} shares)`);
        const tx = await ctf.redeemPositions(USDC_ADDRESS, parentCollectionId, conditionIdBytes, indexSets);
        const receipt = await tx.wait();

        return {
          ...baseResult,
          success: true,
          txHash: receipt.hash,
          amountRecovered: pos.estimatedPayout,
        };
      }
    } catch (err: any) {
      console.error(`[Lifecycle] Redeem failed for ${pos.marketTitle}:`, err.message);
      return { ...baseResult, error: err.message };
    }
  }

  /**
   * Merge positions where we hold both YES and NO tokens.
   */
  async mergePosition(pos: RedeemablePosition): Promise<RedemptionResult> {
    const baseResult: RedemptionResult = {
      conditionId: pos.conditionId,
      tokenId: pos.tokenId,
      marketTitle: pos.marketTitle,
      action: 'merge',
      success: false,
      amountRecovered: 0,
    };

    try {
      if (!config.privateKey) {
        return { ...baseResult, error: 'No private key configured' };
      }

      const signer = new ethers.Wallet(config.privateKey, this.provider);
      const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);

      const parentCollectionId = ethers.constants.HashZero;
      const conditionIdBytes = pos.conditionId;
      const indexSets = [1, 2];
      const mergeAmount = ethers.utils.parseUnits(pos.size.toString(), 6);

      console.log(`[Lifecycle] Merging position: ${pos.marketTitle} (${pos.size} shares)`);
      const tx = await ctf.mergePositions(USDC_ADDRESS, parentCollectionId, conditionIdBytes, indexSets, mergeAmount);
      const receipt = await tx.wait();

      return {
        ...baseResult,
        success: true,
        txHash: receipt.hash,
        amountRecovered: pos.size, // Merge returns USDC equal to the merge amount
      };
    } catch (err: any) {
      console.error(`[Lifecycle] Merge failed for ${pos.marketTitle}:`, err.message);
      return { ...baseResult, error: err.message };
    }
  }

  /**
   * Get the current status of the lifecycle manager.
   */
  getStatus() {
    return {
      running: this.isRunning,
      config: { ...this.lifecycleConfig },
      lastCheckTime: this.lastCheckTime,
      lastResults: this.lastResults,
      stats: {
        totalRedemptions: this.totalRedemptions,
        totalMerges: this.totalMerges,
        totalRecovered: this.totalRecovered,
      },
    };
  }

  /**
   * Update lifecycle configuration.
   */
  async updateConfig(updates: Partial<LifecycleConfig>): Promise<void> {
    Object.assign(this.lifecycleConfig, updates);
    await this.saveConfig();

    // Restart interval if enabled
    if (this.isRunning) {
      if (this.lifecycleConfig.autoRedeemEnabled || this.lifecycleConfig.autoMergeEnabled) {
        this.scheduleCheck();
      } else if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }
    }
  }

  /**
   * Manual trigger to redeem all eligible positions.
   */
  async redeemAll(): Promise<RedemptionResult[]> {
    const positions = await this.getRedeemablePositions();
    const results: RedemptionResult[] = [];

    for (const pos of positions) {
      if (pos.redeemable) {
        const result = await this.redeemPosition(pos);
        results.push(result);
        if (result.success) {
          this.totalRedemptions++;
          this.totalRecovered += result.amountRecovered;
        }
      }
    }

    this.lastResults = results;
    return results;
  }

  // ============================================================
  // PERSISTENCE
  // ============================================================

  private async loadConfig(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      if (cfg.lifecycleConfig) {
        this.lifecycleConfig = { ...DEFAULT_CONFIG, ...cfg.lifecycleConfig };
      }
    } catch {
      // Use defaults
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      const cfg = await Storage.loadConfig();
      cfg.lifecycleConfig = this.lifecycleConfig;
      await Storage.saveConfig(cfg);
    } catch (err: any) {
      console.error('[Lifecycle] Failed to save config:', err.message);
    }
  }
}
