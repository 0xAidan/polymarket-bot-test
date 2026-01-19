import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config.js';
import { Storage } from './storage.js';

type MarketExposureMap = Map<string, number>;

interface WalletExposureState {
  totalUsd: number;
  markets: MarketExposureMap;
}

interface ExposureFileFormat {
  [walletAddress: string]: {
    totalUsd: number;
    markets: Record<string, number>;
  };
}

const EXPOSURE_FILE = path.join(config.dataDir, 'exposure_tracker.json');

/**
 * Tracks exposure (USDC) per tracked wallet and per market.
 * Used to enforce max exposure caps without breaking existing behavior.
 */
export class ExposureTracker {
  private exposure = new Map<string, WalletExposureState>();
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    try {
      await Storage.ensureDataDir();
      const data = await fs.readFile(EXPOSURE_FILE, 'utf-8');
      const parsed = JSON.parse(data) as ExposureFileFormat;
      this.exposure.clear();
      for (const [wallet, state] of Object.entries(parsed)) {
        const markets = new Map<string, number>();
        for (const [marketId, value] of Object.entries(state.markets || {})) {
          markets.set(marketId, Number(value) || 0);
        }
        this.exposure.set(wallet.toLowerCase(), {
          totalUsd: Number(state.totalUsd) || 0,
          markets
        });
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.warn('[Exposure] Failed to load exposure tracker:', error.message);
      }
    } finally {
      this.loaded = true;
    }
  }

  private async save(): Promise<void> {
    try {
      await Storage.ensureDataDir();
      const output: ExposureFileFormat = {};
      for (const [wallet, state] of this.exposure.entries()) {
        const markets: Record<string, number> = {};
        for (const [marketId, value] of state.markets.entries()) {
          markets[marketId] = value;
        }
        output[wallet] = {
          totalUsd: state.totalUsd,
          markets
        };
      }
      await fs.writeFile(EXPOSURE_FILE, JSON.stringify(output, null, 2));
    } catch (error: any) {
      console.warn('[Exposure] Failed to save exposure tracker:', error.message);
    }
  }

  private getWalletState(walletAddress: string): WalletExposureState {
    const key = walletAddress.toLowerCase();
    const existing = this.exposure.get(key);
    if (existing) {
      return existing;
    }
    const fresh: WalletExposureState = { totalUsd: 0, markets: new Map() };
    this.exposure.set(key, fresh);
    return fresh;
  }

  async getExposure(walletAddress: string, marketId: string): Promise<{ walletUsd: number; marketUsd: number }> {
    await this.load();
    const walletState = this.getWalletState(walletAddress);
    const marketUsd = walletState.markets.get(marketId) || 0;
    return { walletUsd: walletState.totalUsd, marketUsd };
  }

  async getProjectedExposure(
    walletAddress: string,
    marketId: string,
    deltaUsd: number
  ): Promise<{ projectedWalletUsd: number; projectedMarketUsd: number }> {
    await this.load();
    const walletState = this.getWalletState(walletAddress);
    const currentMarketUsd = walletState.markets.get(marketId) || 0;
    const projectedWalletUsd = Math.max(0, walletState.totalUsd + deltaUsd);
    const projectedMarketUsd = Math.max(0, currentMarketUsd + deltaUsd);
    return { projectedWalletUsd, projectedMarketUsd };
  }

  async applyExposureDelta(walletAddress: string, marketId: string, deltaUsd: number): Promise<void> {
    await this.load();
    const walletState = this.getWalletState(walletAddress);
    const currentMarketUsd = walletState.markets.get(marketId) || 0;
    walletState.totalUsd = Math.max(0, walletState.totalUsd + deltaUsd);
    const nextMarketUsd = Math.max(0, currentMarketUsd + deltaUsd);
    if (nextMarketUsd === 0) {
      walletState.markets.delete(marketId);
    } else {
      walletState.markets.set(marketId, nextMarketUsd);
    }
    await this.save();
  }
}
