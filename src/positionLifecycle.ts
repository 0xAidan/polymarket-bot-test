import * as ethers from 'ethers';
import { config } from './config.js';
import { PolymarketApi } from './polymarketApi.js';
import { Storage } from './storage.js';
import { getTradingWallets } from './walletManager.js';
import { getSigner, isWalletUnlocked } from './secureKeyManager.js';
import { RelayClient, RelayerTxType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

const RELAYER_URL = 'https://relayer-v2.polymarket.com/';
const POLYGON_CHAIN_ID = 137;

// Polymarket contract addresses on Polygon
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 amount) external',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
];

const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external',
];

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
  walletId: string;
  proxyWallet: string;
}

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

export interface LifecycleConfig {
  autoRedeemEnabled: boolean;
  autoMergeEnabled: boolean;
  checkIntervalMs: number;
  minRedeemValue: number;
}

const DEFAULT_CONFIG: LifecycleConfig = {
  autoRedeemEnabled: false,
  autoMergeEnabled: false,
  checkIntervalMs: 60_000,
  minRedeemValue: 0.10,
};

export class PositionLifecycleManager {
  private api: PolymarketApi;
  private provider: ethers.providers.JsonRpcProvider;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastCheckTime: number = 0;
  private lastResults: RedemptionResult[] = [];
  private lifecycleConfig: LifecycleConfig;

  private totalRedemptions = 0;
  private totalMerges = 0;
  private totalRecovered = 0;

  constructor() {
    this.api = new PolymarketApi();
    this.provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    this.lifecycleConfig = { ...DEFAULT_CONFIG };
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.loadConfig();

    console.log('[Lifecycle] Position lifecycle manager started');
    console.log(`[Lifecycle]   Auto-redeem: ${this.lifecycleConfig.autoRedeemEnabled ? 'ON' : 'OFF'}`);
    console.log(`[Lifecycle]   Auto-merge: ${this.lifecycleConfig.autoMergeEnabled ? 'ON' : 'OFF'}`);
    console.log(`[Lifecycle]   Check interval: ${this.lifecycleConfig.checkIntervalMs / 1000}s`);

    if (this.lifecycleConfig.autoRedeemEnabled || this.lifecycleConfig.autoMergeEnabled) {
      this.scheduleCheck();
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log('[Lifecycle] Position lifecycle manager stopped');
  }

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

    this.checkAndProcess().catch(err => console.error('[Lifecycle] Initial check failed:', err.message));
  }

  async checkAndProcess(): Promise<RedemptionResult[]> {
    this.lastCheckTime = Date.now();
    const results: RedemptionResult[] = [];

    try {
      if (!isWalletUnlocked()) {
        console.log('[Lifecycle] Auto-check skipped — wallets are locked');
        return results;
      }

      const positions = await this.getRedeemablePositions();

      if (positions.length === 0) {
        console.log('[Lifecycle] Auto-check: no redeemable or mergeable positions');
        return results;
      }

      console.log(`[Lifecycle] Auto-check: found ${positions.length} position(s) to process`);

      for (const pos of positions) {
        if (pos.estimatedPayout < this.lifecycleConfig.minRedeemValue) {
          console.log(`[Lifecycle] Skipping ${pos.marketTitle} — payout $${pos.estimatedPayout.toFixed(2)} below min $${this.lifecycleConfig.minRedeemValue}`);
          continue;
        }

        if (pos.redeemable && this.lifecycleConfig.autoRedeemEnabled) {
          console.log(`[Lifecycle] Auto-redeeming: ${pos.marketTitle} (~$${pos.estimatedPayout.toFixed(2)})`);
          const result = await this.redeemPosition(pos);
          results.push(result);
          if (result.success) {
            this.totalRedemptions++;
            this.totalRecovered += result.amountRecovered;
            console.log(`[Lifecycle] ✓ Redeemed ${pos.marketTitle} — tx ${result.txHash}`);
          } else {
            console.error(`[Lifecycle] ✗ Redeem failed: ${pos.marketTitle} — ${result.error}`);
          }
        }

        if (pos.mergeable && this.lifecycleConfig.autoMergeEnabled) {
          console.log(`[Lifecycle] Auto-merging: ${pos.marketTitle}`);
          const result = await this.mergePosition(pos);
          results.push(result);
          if (result.success) {
            this.totalMerges++;
            this.totalRecovered += result.amountRecovered;
            console.log(`[Lifecycle] ✓ Merged ${pos.marketTitle} — tx ${result.txHash}`);
          } else {
            console.error(`[Lifecycle] ✗ Merge failed: ${pos.marketTitle} — ${result.error}`);
          }
        }
      }

      this.lastResults = results;
      return results;
    } catch (err: any) {
      console.error('[Lifecycle] Error during auto-check:', err.message);
      return results;
    }
  }

  /**
   * Get positions that are redeemable or mergeable.
   * Uses the Data API's redeemable/mergeable filters.
   * Queries with the PROXY wallet address (not EOA) because that's
   * how Polymarket indexes positions.
   * Filters out $0-value positions (losing bets that technically
   * resolve but yield nothing).
   */
  async getRedeemablePositions(): Promise<RedeemablePosition[]> {
    const results: RedeemablePosition[] = [];

    try {
      const wallets = getTradingWallets();

      if (wallets.length === 0) {
        console.log('[Lifecycle] No trading wallets configured');
        return results;
      }

      for (const wallet of wallets) {
        if (!wallet.address) continue;

        try {
          const proxyAddress = await this.api.getProxyWalletAddress(wallet.address);
          const queryAddress = proxyAddress || wallet.address;
          console.log(`[Lifecycle] Checking wallet ${wallet.id}: EOA=${wallet.address.substring(0, 10)}... → query=${queryAddress.substring(0, 10)}...`);

          const redeemablePositions = await this.api.getFilteredPositions(queryAddress, {
            redeemable: true,
            sizeThreshold: 0,
          });

          const mergeablePositions = await this.api.getFilteredPositions(queryAddress, {
            mergeable: true,
            sizeThreshold: 0,
          });

          const seen = new Set<string>();

          for (const pos of redeemablePositions) {
            const tokenId = pos.asset || '';
            if (seen.has(tokenId)) continue;
            seen.add(tokenId);

            const size = typeof pos.size === 'number' ? pos.size : parseFloat(pos.size || '0');
            if (size <= 0) continue;

            const currentValue = typeof pos.currentValue === 'number' ? pos.currentValue : parseFloat(pos.currentValue || '0');
            if (currentValue <= 0) continue;

            results.push({
              conditionId: pos.conditionId || '',
              tokenId,
              outcome: pos.outcome || 'Unknown',
              size,
              currentPrice: typeof pos.curPrice === 'number' ? pos.curPrice : parseFloat(pos.curPrice || '1'),
              marketTitle: pos.title || pos.slug || 'Unknown Market',
              marketSlug: pos.slug || pos.eventSlug || '',
              negRisk: pos.negativeRisk === true || pos.negRisk === true,
              redeemable: true,
              mergeable: false,
              estimatedPayout: currentValue,
              walletId: wallet.id,
              proxyWallet: queryAddress,
            });
          }

          for (const pos of mergeablePositions) {
            const tokenId = pos.asset || '';
            if (seen.has(tokenId)) continue;
            seen.add(tokenId);

            const size = typeof pos.size === 'number' ? pos.size : parseFloat(pos.size || '0');
            if (size <= 0) continue;

            results.push({
              conditionId: pos.conditionId || '',
              tokenId,
              outcome: pos.outcome || 'Unknown',
              size,
              currentPrice: typeof pos.curPrice === 'number' ? pos.curPrice : parseFloat(pos.curPrice || '0'),
              marketTitle: pos.title || pos.slug || 'Unknown Market',
              marketSlug: pos.slug || pos.eventSlug || '',
              negRisk: pos.negativeRisk === true || pos.negRisk === true,
              redeemable: false,
              mergeable: true,
              estimatedPayout: size,
              walletId: wallet.id,
              proxyWallet: queryAddress,
            });
          }

          if (redeemablePositions.length > 0 || mergeablePositions.length > 0) {
            console.log(`[Lifecycle] Wallet ${wallet.id}: ${redeemablePositions.length} redeemable (${results.filter(r => r.walletId === wallet.id && r.redeemable).length} with value), ${mergeablePositions.length} mergeable`);
          }
        } catch (walletErr: any) {
          console.error(`[Lifecycle] Error fetching positions for wallet ${wallet.id} (${wallet.address?.substring(0, 10)}...):`, walletErr.message);
        }
      }

      return results;
    } catch (err: any) {
      console.error('[Lifecycle] Error fetching redeemable positions:', err.message);
      return results;
    }
  }

  // ============================================================
  // GASLESS EXECUTION VIA POLYMARKET RELAYER
  // ============================================================

  /**
   * Create a RelayClient for a given wallet. The relayer submits
   * transactions on-chain and pays gas — the wallet only signs.
   */
  private createRelayClient(signer: ethers.Wallet): RelayClient {
    const connectedSigner = signer.connect(this.provider);

    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: config.polymarketBuilderApiKey,
        secret: config.polymarketBuilderSecret,
        passphrase: config.polymarketBuilderPassphrase,
      },
    });

    return new RelayClient(
      RELAYER_URL,
      POLYGON_CHAIN_ID,
      connectedSigner as any,
      builderConfig,
      RelayerTxType.SAFE,
    );
  }

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
      if (!isWalletUnlocked()) {
        return { ...baseResult, error: 'Wallets are locked — unlock wallets first' };
      }

      if (!config.polymarketBuilderApiKey || !config.polymarketBuilderSecret) {
        return { ...baseResult, error: 'Builder API credentials required for gasless redemption' };
      }

      let baseSigner: ethers.Wallet;
      try {
        baseSigner = getSigner(pos.walletId);
      } catch {
        return { ...baseResult, error: `Wallet "${pos.walletId}" not found or not unlocked` };
      }

      let targetContract: string;
      let callData: string;

      if (pos.negRisk) {
        const iface = new ethers.utils.Interface(NEG_RISK_ABI);
        const amounts = [ethers.utils.parseUnits(pos.size.toString(), 6), 0];
        callData = iface.encodeFunctionData('redeemPositions', [pos.conditionId, amounts]);
        targetContract = NEG_RISK_ADAPTER_ADDRESS;
      } else {
        const iface = new ethers.utils.Interface(CTF_ABI);
        callData = iface.encodeFunctionData('redeemPositions', [
          USDC_ADDRESS,
          ethers.constants.HashZero,
          pos.conditionId,
          [1, 2],
        ]);
        targetContract = CTF_ADDRESS;
      }

      console.log(`[Lifecycle] Redeeming via relayer: ${pos.marketTitle} (${pos.size} shares, ~$${pos.estimatedPayout.toFixed(2)})`);

      const relayClient = this.createRelayClient(baseSigner);
      const response = await relayClient.execute(
        [{ to: targetContract, data: callData, value: '0' }],
        `Redeem: ${pos.marketTitle}`,
      );
      const result = await response.wait();

      if (!result) {
        return { ...baseResult, error: 'Relayer transaction failed or timed out' };
      }

      console.log(`[Lifecycle] Redeemed: ${pos.marketTitle} — tx ${result.transactionHash}`);

      return {
        ...baseResult,
        success: true,
        txHash: result.transactionHash,
        amountRecovered: pos.estimatedPayout,
      };
    } catch (err: any) {
      console.error(`[Lifecycle] Redeem failed for ${pos.marketTitle}:`, err.message);
      return { ...baseResult, error: err.message };
    }
  }

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
      if (!isWalletUnlocked()) {
        return { ...baseResult, error: 'Wallets are locked — unlock wallets first' };
      }

      if (!config.polymarketBuilderApiKey || !config.polymarketBuilderSecret) {
        return { ...baseResult, error: 'Builder API credentials required for gasless merge' };
      }

      let baseSigner: ethers.Wallet;
      try {
        baseSigner = getSigner(pos.walletId);
      } catch {
        return { ...baseResult, error: `Wallet "${pos.walletId}" not found or not unlocked` };
      }

      const iface = new ethers.utils.Interface(CTF_ABI);
      const mergeAmount = ethers.utils.parseUnits(pos.size.toString(), 6);
      const callData = iface.encodeFunctionData('mergePositions', [
        USDC_ADDRESS,
        ethers.constants.HashZero,
        pos.conditionId,
        [1, 2],
        mergeAmount,
      ]);

      console.log(`[Lifecycle] Merging via relayer: ${pos.marketTitle} (${pos.size} shares)`);

      const relayClient = this.createRelayClient(baseSigner);
      const response = await relayClient.execute(
        [{ to: CTF_ADDRESS, data: callData, value: '0' }],
        `Merge: ${pos.marketTitle}`,
      );
      const result = await response.wait();

      if (!result) {
        return { ...baseResult, error: 'Relayer transaction failed or timed out' };
      }

      console.log(`[Lifecycle] Merged: ${pos.marketTitle} — tx ${result.transactionHash}`);

      return {
        ...baseResult,
        success: true,
        txHash: result.transactionHash,
        amountRecovered: pos.size,
      };
    } catch (err: any) {
      console.error(`[Lifecycle] Merge failed for ${pos.marketTitle}:`, err.message);
      return { ...baseResult, error: err.message };
    }
  }

  /**
   * Called externally when wallets are unlocked or when we want
   * to force an immediate check outside the scheduled interval.
   */
  async triggerCheck(): Promise<void> {
    if (!this.isRunning) return;
    if (!this.lifecycleConfig.autoRedeemEnabled && !this.lifecycleConfig.autoMergeEnabled) return;

    console.log('[Lifecycle] Triggered immediate check (e.g. wallets just unlocked)');
    try {
      const results = await this.checkAndProcess();
      if (results.length > 0) {
        const succeeded = results.filter(r => r.success).length;
        console.log(`[Lifecycle] Triggered check completed: ${succeeded}/${results.length} succeeded`);
      }
    } catch (err: any) {
      console.error('[Lifecycle] Triggered check failed:', err.message);
    }
  }

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

  async updateConfig(updates: Partial<LifecycleConfig>): Promise<void> {
    Object.assign(this.lifecycleConfig, updates);
    await this.saveConfig();

    if (this.isRunning) {
      if (this.lifecycleConfig.autoRedeemEnabled || this.lifecycleConfig.autoMergeEnabled) {
        this.scheduleCheck();
      } else if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }
    }
  }

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
