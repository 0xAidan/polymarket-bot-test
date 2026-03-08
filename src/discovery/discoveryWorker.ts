import axios from 'axios';
import { pathToFileURL } from 'url';
import { config } from '../config.js';
import { initDatabase } from '../database.js';
import { buildDiscoveryReasonRows, buildWalletScoreRow, replaceWalletReasons, upsertWalletScoreRow } from './discoveryScorer.js';
import { getDiscoveryMarketPool, buildDiscoveryMarketPoolEntries, upsertDiscoveryMarketPoolEntries } from './categorySeeder.js';
import { buildTokenMapEntries, getTokenIdsForConditionId, upsertTokenMapEntries } from './tokenMapper.js';
import {
  buildHolderSeedCandidates,
  buildLeaderboardSeedCandidates,
  buildMarketPositionSeedCandidates,
  buildTradeSeedCandidates,
  getCandidateAddressesNeedingValidation,
  getWalletCandidateFocusSummary,
  getWalletCandidates,
  getWalletCandidatesByAddress,
  upsertWalletCandidates,
} from './walletSeedEngine.js';
import { buildWalletValidationRecord, getWalletValidation, upsertWalletValidation } from './walletValidator.js';
import { computeCopyabilityScore } from './copyabilityScorer.js';
import { computeEarlyEntryScore } from './earlyEntryScorer.js';
import { insertDiscoveryRunLog } from './runLog.js';
import { getDiscoveryConfig } from './statsStore.js';

type MarketContext = {
  averageSpreadBps: number;
  averageTopOfBookUsd: number;
  currentPrice?: number;
};

type DiscoveryWorkerOptions = {
  now?: () => number;
  cycleIntervalMs?: number;
  marketSeedLimit?: number;
  leaderboardCategories?: string[];
  leaderboardWindows?: string[];
  fetchActiveEvents?: () => Promise<any[]>;
  fetchLeaderboard?: (category: string, timePeriod: string) => Promise<any[]>;
  fetchMarketPositions?: (conditionId: string) => Promise<any[]>;
  fetchHolders?: (conditionId: string) => Promise<any[]>;
  fetchTrades?: (conditionId: string) => Promise<any[]>;
  fetchProfile?: (address: string) => Promise<Record<string, unknown> | null>;
  fetchTraded?: (address: string) => Promise<Record<string, unknown> | null>;
  fetchPositions?: (address: string) => Promise<Array<Record<string, unknown>>>;
  fetchClosedPositions?: (address: string) => Promise<Array<Record<string, unknown>>>;
  fetchActivity?: (address: string) => Promise<Array<Record<string, unknown>>>;
  fetchMarketContext?: (conditionId: string) => Promise<MarketContext>;
};

const DEFAULT_DISCOVERY_CYCLE_MS = 15 * 60 * 1000;
const DEFAULT_MARKET_SEED_LIMIT = 10;
const DEFAULT_LEADERBOARD_CATEGORIES = ['POLITICS', 'ECONOMICS', 'TECH', 'FINANCE'];
const DEFAULT_LEADERBOARD_WINDOWS = ['WEEK', 'MONTH'];

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));

export class DiscoveryWorkerRuntime {
  private readonly now: () => number;
  private readonly cycleIntervalMs?: number;
  private readonly marketSeedLimit: number;
  private readonly leaderboardCategories: string[];
  private readonly leaderboardWindows: string[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycleInFlight = false;
  private lastCompletedCycleAt = 0;

  constructor(private readonly options: DiscoveryWorkerOptions = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.cycleIntervalMs = options.cycleIntervalMs;
    this.marketSeedLimit = options.marketSeedLimit ?? DEFAULT_MARKET_SEED_LIMIT;
    this.leaderboardCategories = options.leaderboardCategories ?? DEFAULT_LEADERBOARD_CATEGORIES;
    this.leaderboardWindows = options.leaderboardWindows ?? DEFAULT_LEADERBOARD_WINDOWS;
  }

  async start(): Promise<void> {
    await this.tick();
    if (this.timer) return;
    const cfg = getDiscoveryConfig();
    const intervalMs = this.cycleIntervalMs ?? Math.max(10_000, cfg.pollIntervalMs || 30_000);
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.error('[DiscoveryWorker] Scheduled cycle failed:', error);
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runCycle(): Promise<void> {
    const cfg = getDiscoveryConfig();
    if (!cfg.enabled) {
      return;
    }

    if (this.cycleInFlight) {
      return;
    }

    this.cycleInFlight = true;
    try {
    const startedAt = Date.now();
    const runTimestamp = this.now();
    let gammaRequestCount = 0;
    let dataRequestCount = 0;
    let clobRequestCount = 0;

    const events = await (async () => {
      gammaRequestCount += 1;
      return this.fetchActiveEvents();
    })();

    const marketPoolEntries = buildDiscoveryMarketPoolEntries(events, runTimestamp);
    upsertDiscoveryMarketPoolEntries(marketPoolEntries);
    upsertTokenMapEntries(buildTokenMapEntries(marketPoolEntries));

    const seededCandidates = [];
    for (const category of this.leaderboardCategories) {
      for (const timePeriod of this.leaderboardWindows) {
        dataRequestCount += 1;
        const rows = await this.fetchLeaderboard(category, timePeriod);
        seededCandidates.push(
          ...buildLeaderboardSeedCandidates(rows, {
            category,
            timePeriod,
            detectedAt: runTimestamp,
          })
        );
      }
    }

    const seededMarkets = getDiscoveryMarketPool(Math.max(1, cfg.marketCount || this.marketSeedLimit));
    for (const market of seededMarkets) {
      dataRequestCount += 1;
      seededCandidates.push(
        ...buildMarketPositionSeedCandidates(await this.fetchMarketPositions(market.conditionId), {
          conditionId: market.conditionId,
          marketTitle: market.title,
          detectedAt: runTimestamp,
        })
      );

      dataRequestCount += 1;
      seededCandidates.push(
        ...buildHolderSeedCandidates(await this.fetchHolders(market.conditionId), {
          conditionId: market.conditionId,
          marketTitle: market.title,
          detectedAt: runTimestamp,
        })
      );

      dataRequestCount += 1;
      seededCandidates.push(
        ...buildTradeSeedCandidates(await this.fetchTrades(market.conditionId), {
          conditionId: market.conditionId,
          marketTitle: market.title,
          detectedAt: runTimestamp,
        })
      );
    }

    upsertWalletCandidates(seededCandidates);

    const addressesForValidation = getCandidateAddressesNeedingValidation(15, runTimestamp - 6 * 3600);
    for (const address of addressesForValidation) {
      dataRequestCount += 5;
      const [profile, traded, positions, closedPositions, activity] = await Promise.all([
        this.fetchProfile(address),
        this.fetchTraded(address),
        this.fetchPositions(address),
        this.fetchClosedPositions(address),
        this.fetchActivity(address),
      ]);

      upsertWalletValidation(buildWalletValidationRecord({
        address,
        profile,
        traded,
        positions,
        closedPositions,
        activity,
        validatedAt: runTimestamp,
      }));
    }

    let qualifiedCount = 0;
    let rejectedCount = 0;
    const candidateAddresses = [...new Set(getWalletCandidates(200).map((candidate) => candidate.address))];
    for (const address of candidateAddresses) {
      const validation = getWalletValidation(address);
      if (!validation) continue;

      const focusSummary = getWalletCandidateFocusSummary(address);
      const candidates = getWalletCandidatesByAddress(address);
      const marketContexts = await Promise.all(
        candidates
          .map((candidate) => candidate.conditionId)
          .filter((conditionId): conditionId is string => Boolean(conditionId))
          .slice(0, 3)
          .map(async (conditionId) => {
            clobRequestCount += 1;
            return this.fetchMarketContext(conditionId);
          })
      );

      const averageSpreadBps = marketContexts.length > 0
        ? marketContexts.reduce((sum, ctx) => sum + ctx.averageSpreadBps, 0) / marketContexts.length
        : 100;
      const averageTopOfBookUsd = marketContexts.length > 0
        ? marketContexts.reduce((sum, ctx) => sum + ctx.averageTopOfBookUsd, 0) / marketContexts.length
        : 0;

      const latestTradeCandidate = candidates.find((candidate) => candidate.sourceType === 'trades');
      const latestTradePrice = Number(latestTradeCandidate?.sourceMetadata?.price ?? NaN);
      const currentPrice = marketContexts.find((ctx) => Number.isFinite(ctx.currentPrice))?.currentPrice;

      const profitabilityScore = clamp((validation.realizedWinRate * 0.7) + (validation.realizedPnl / 25));
      const focusScore = clamp(
        (focusSummary.focusCategory ? 55 : 35) +
        Math.min(20, focusSummary.sourceChannels.length * 5) +
        Math.min(15, validation.marketsTouched * 3)
      );
      const copyabilityScore = computeCopyabilityScore(validation, {
        averageSpreadBps,
        averageTopOfBookUsd,
      });
      const earlyScore = computeEarlyEntryScore({
        entryPrice: Number.isFinite(latestTradePrice) ? latestTradePrice : undefined,
        currentPrice,
      });
      const consistencyScore = clamp(validation.realizedWinRate * 0.6 + validation.tradeActivityCount * 4);
      const convictionScore = clamp(Math.max(...candidates.map((candidate) => Number(candidate.sourceMetric ?? 0)), 0) / 100);
      const noisePenalty = clamp(
        (validation.makerRebateCount * 8) +
        (focusSummary.focusCategory ? 0 : 10),
        0,
        30
      );

      const row = buildWalletScoreRow({
        address,
        profitabilityScore,
        focusScore,
        copyabilityScore,
        earlyScore,
        consistencyScore,
        convictionScore,
        noisePenalty,
        updatedAt: runTimestamp,
      });

      upsertWalletScoreRow(row);
      replaceWalletReasons(address, buildDiscoveryReasonRows(row), runTimestamp);

      if (row.passedProfitabilityGate && row.passedFocusGate && row.passedCopyabilityGate) {
        qualifiedCount++;
      } else {
        rejectedCount++;
      }
    }

    insertDiscoveryRunLog({
      phase: 'free-mode-cycle',
      gammaRequestCount,
      dataRequestCount,
      clobRequestCount,
      candidateCount: candidateAddresses.length,
      qualifiedCount,
      rejectedCount,
      durationMs: Date.now() - startedAt,
      notes: 'Category-first wallet-seeded discovery cycle',
      createdAt: runTimestamp,
    });
    this.lastCompletedCycleAt = runTimestamp;
    } finally {
      this.cycleInFlight = false;
    }
  }

  private async tick(): Promise<void> {
    const cfg = getDiscoveryConfig();
    if (!cfg.enabled) return;
    if (this.lastCompletedCycleAt > 0) {
      const elapsedMs = (this.now() - this.lastCompletedCycleAt) * 1000;
      if (elapsedMs < cfg.statsIntervalMs) {
        return;
      }
    }
    await this.runCycle();
  }

  private async fetchActiveEvents(): Promise<any[]> {
    if (this.options.fetchActiveEvents) {
      return this.options.fetchActiveEvents();
    }

    const response = await axios.get(`${config.polymarketGammaApiUrl}/events`, {
      params: { active: true, closed: false, limit: 100, offset: 0 },
      timeout: 15_000,
    });
    return response.data ?? [];
  }

  private async fetchLeaderboard(category: string, timePeriod: string): Promise<any[]> {
    if (this.options.fetchLeaderboard) {
      return this.options.fetchLeaderboard(category, timePeriod);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/v1/leaderboard`, {
      params: { category, timePeriod },
      timeout: 10_000,
    });
    return response.data ?? [];
  }

  private async fetchMarketPositions(conditionId: string): Promise<any[]> {
    if (this.options.fetchMarketPositions) {
      return this.options.fetchMarketPositions(conditionId);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/v1/market-positions`, {
      params: { market: conditionId },
      timeout: 10_000,
    });
    return response.data ?? [];
  }

  private async fetchHolders(conditionId: string): Promise<any[]> {
    if (this.options.fetchHolders) {
      return this.options.fetchHolders(conditionId);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/holders`, {
      params: { market: conditionId },
      timeout: 10_000,
    });
    return response.data ?? [];
  }

  private async fetchTrades(conditionId: string): Promise<any[]> {
    if (this.options.fetchTrades) {
      return this.options.fetchTrades(conditionId);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/trades`, {
      params: { market: conditionId, limit: 20 },
      timeout: 10_000,
    });
    return response.data ?? [];
  }

  private async fetchProfile(address: string): Promise<Record<string, unknown> | null> {
    if (this.options.fetchProfile) {
      return this.options.fetchProfile(address);
    }

    const response = await axios.get(`${config.polymarketGammaApiUrl}/public-profile`, {
      params: { address },
      timeout: 10_000,
    });
    return response.data ?? null;
  }

  private async fetchTraded(address: string): Promise<Record<string, unknown> | null> {
    if (this.options.fetchTraded) {
      return this.options.fetchTraded(address);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/traded`, {
      params: { user: address },
      timeout: 10_000,
    });
    return response.data ?? null;
  }

  private async fetchPositions(address: string): Promise<Array<Record<string, unknown>>> {
    if (this.options.fetchPositions) {
      return this.options.fetchPositions(address);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/positions`, {
      params: { user: address },
      timeout: 10_000,
    });
    return response.data ?? [];
  }

  private async fetchClosedPositions(address: string): Promise<Array<Record<string, unknown>>> {
    if (this.options.fetchClosedPositions) {
      return this.options.fetchClosedPositions(address);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/closed-positions`, {
      params: { user: address },
      timeout: 10_000,
    });
    return response.data ?? [];
  }

  private async fetchActivity(address: string): Promise<Array<Record<string, unknown>>> {
    if (this.options.fetchActivity) {
      return this.options.fetchActivity(address);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/activity`, {
      params: { user: address },
      timeout: 10_000,
    });
    return response.data ?? [];
  }

  private async fetchMarketContext(conditionId: string): Promise<MarketContext> {
    if (this.options.fetchMarketContext) {
      return this.options.fetchMarketContext(conditionId);
    }

    const tokenIds = getTokenIdsForConditionId(conditionId);
    const snapshots = await Promise.all(tokenIds.slice(0, 2).map(async (tokenId) => {
      const [spreadResponse, bookResponse] = await Promise.all([
        axios.get(`${config.polymarketClobApiUrl}/spread`, { params: { token_id: tokenId }, timeout: 10_000 }).catch(() => ({ data: {} })),
        axios.get(`${config.polymarketClobApiUrl}/book`, { params: { token_id: tokenId }, timeout: 10_000 }).catch(() => ({ data: {} })),
      ]);

      const spreadValue = Number(spreadResponse.data?.spread ?? spreadResponse.data?.bidAskSpread ?? 0);
      const topBid = Number(bookResponse.data?.bids?.[0]?.price ?? 0);
      const topAsk = Number(bookResponse.data?.asks?.[0]?.price ?? 0);
      const topSize = Number(bookResponse.data?.bids?.[0]?.size ?? 0);
      const currentPrice = topBid > 0 && topAsk > 0 ? (topBid + topAsk) / 2 : undefined;

      return {
        spreadBps: spreadValue > 1 ? spreadValue : spreadValue * 10_000,
        topOfBookUsd: (currentPrice ?? 0) * topSize,
        currentPrice,
      };
    }));

    if (snapshots.length === 0) {
      return { averageSpreadBps: 100, averageTopOfBookUsd: 0 };
    }

    return {
      averageSpreadBps: snapshots.reduce((sum, snapshot) => sum + snapshot.spreadBps, 0) / snapshots.length,
      averageTopOfBookUsd: snapshots.reduce((sum, snapshot) => sum + snapshot.topOfBookUsd, 0) / snapshots.length,
      currentPrice: snapshots.find((snapshot) => Number.isFinite(snapshot.currentPrice))?.currentPrice,
    };
  }
}

export const startDiscoveryWorker = async (
  runner: Pick<DiscoveryWorkerRuntime, 'start'> = new DiscoveryWorkerRuntime(),
): Promise<Pick<DiscoveryWorkerRuntime, 'start'>> => {
  await initDatabase();
  await runner.start();
  return runner;
};

const main = async (): Promise<void> => {
  const runner = await startDiscoveryWorker(new DiscoveryWorkerRuntime());

  const handleShutdown = async () => {
    if ('stop' in runner && typeof runner.stop === 'function') {
      await runner.stop();
    }
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error('[DiscoveryWorker] Fatal error:', error);
    process.exit(1);
  });
}
