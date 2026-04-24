import axios from 'axios';
import { pathToFileURL } from 'url';
import { config } from '../config.js';
import { initDatabase } from '../database.js';
import {
  buildDiscoveryReasonRows,
  buildReasonPayloadV2,
  buildWalletScoreRow,
  replaceWalletReasons,
  upsertWalletScoreRow,
  upsertWalletScoreRowV2,
} from './discoveryScorer.js';
import { getDiscoveryMarketPool, buildDiscoveryMarketPoolEntries, upsertDiscoveryMarketPoolEntries } from './categorySeeder.js';
import { buildTokenMapEntries, getTokenIdsForConditionId, upsertTokenMapEntries } from './tokenMapper.js';
import {
  buildHolderSeedCandidates,
  buildLeaderboardSeedCandidates,
  buildMarketPositionSeedCandidates,
  buildTradeSeedCandidates,
  getCandidateAddressesForScoring,
  getCandidateAddressesNeedingValidation,
  getWalletCandidateFocusSummary,
  getWalletCandidatesByAddress,
  upsertWalletCandidates,
} from './walletSeedEngine.js';
import { buildWalletValidationRecord, getWalletValidation, upsertWalletValidation } from './walletValidator.js';
import { computeCopyabilityScore } from './copyabilityScorer.js';
import { computeEarlyEntryScore } from './earlyEntryScorer.js';
import { buildDiscoveryFeatureSnapshot } from './featureEngine.js';
import {
  classifyDiscoveryStrategy,
  computeConfidenceBucket,
  resolveDiscoverySurfaceBucket,
} from './strategyClassifier.js';
import {
  createCycleEvaluationSnapshot,
  insertDiscoveryCostSnapshots,
  insertDiscoveryEvaluationObservations,
  insertDiscoveryEvaluationSnapshot,
} from './evaluationEngine.js';
import { insertDiscoveryRunLog } from './runLog.js';
import { isDiscoveryV3Enabled } from './v3/featureFlag.js';
import { startDiscoveryV3Worker } from './v3/workerIntegration.js';
import { getDiscoveryConfig } from './statsStore.js';
import { DiscoveryStrategyClass, DiscoveryWalletScoreRow } from './types.js';
import { upsertWalletFeatureSnapshotV2 } from './v2DataStore.js';
import { evaluateAndPersistAllocationPolicies } from '../allocation/policyEngine.js';

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
const NOISE_CATEGORIES = new Set(['crypto']);

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));
const roundPct = (value: number): number => Math.round(value * 10) / 10;

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
    console.log('[DiscoveryWorker] Polling every', Math.round(intervalMs / 1000), 's');
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
    console.log('[DiscoveryWorker] Running cycle...');
    try {
    const startedAt = Date.now();
    const runTimestamp = this.now();
    let gammaRequestCount = 0;
    let dataRequestCount = 0;
    let clobRequestCount = 0;
    let copyabilityPassCount = 0;
    let walletsWithTwoReasonsCount = 0;
    const scoredRows: DiscoveryWalletScoreRow[] = [];
    const allocationInputs: Array<{
      address: string;
      discoveryScore: number;
      trustScore: number;
      copyabilityScore: number;
      confidenceBucket: 'low' | 'medium' | 'high';
      strategyClass: DiscoveryStrategyClass;
      cautionFlags: string[];
      updatedAt: number;
    }> = [];

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
    let validatedCount = 0;
    for (const address of addressesForValidation) {
      try {
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
        validatedCount += 1;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[DiscoveryWorker] Skipping validation for ${address}:`, message);
      }
    }
    if (addressesForValidation.length > 0) {
      console.log(`[DiscoveryWorker] Validated ${validatedCount}/${addressesForValidation.length} addresses`);
    }

    let qualifiedCount = 0;
    let rejectedCount = 0;
    const candidateAddresses = getCandidateAddressesForScoring(200);
    let categorizedCandidateCount = 0;
    for (const address of candidateAddresses) {
      const validation = getWalletValidation(address);
      if (!validation) continue;

      try {
        const focusSummary = getWalletCandidateFocusSummary(address);
        if (focusSummary.focusCategory && !NOISE_CATEGORIES.has(focusSummary.focusCategory)) {
          categorizedCandidateCount += 1;
        }
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

        const copyabilityScore = computeCopyabilityScore(validation, {
          averageSpreadBps,
          averageTopOfBookUsd,
        });
        const earlyScore = computeEarlyEntryScore({
          entryPrice: Number.isFinite(latestTradePrice) ? latestTradePrice : undefined,
          currentPrice,
        });
        const featureSnapshot = buildDiscoveryFeatureSnapshot({
          validation,
          candidates,
          focusCategory: focusSummary.focusCategory,
          latestTradePrice: Number.isFinite(latestTradePrice) ? latestTradePrice : undefined,
          currentPrice,
          averageSpreadBps,
          averageTopOfBookUsd,
        });
        const profitabilityScore = clamp(
          validation.realizedWinRate * 0.55 +
          (validation.realizedPnl > 0 ? Math.min(35, validation.realizedPnl / 20) : 0) +
          featureSnapshot.marketSelectionScore * 0.1,
        );
        const focusScore = clamp(
          featureSnapshot.categoryFocusScore * 0.7 +
          featureSnapshot.marketSelectionScore * 0.3,
        );
        const consistencyScore = featureSnapshot.consistencyScore;
        const convictionScore = featureSnapshot.convictionScore;
        const noisePenalty = featureSnapshot.integrityPenalty;
        const strategyClass = classifyDiscoveryStrategy({
          focusCategory: focusSummary.focusCategory,
          validation,
          copyabilityScore,
          earlyScore,
          noisePenalty,
        });
        const confidenceBucket = computeConfidenceBucket({
          observationCount: featureSnapshot.confidenceEvidenceCount,
          distinctMarkets: validation.marketsTouched,
          recencyHours: Math.max(1, (runTimestamp - validation.lastValidatedAt) / 3600),
          strategyClass,
        });

        upsertWalletFeatureSnapshotV2({
          address,
          runTimestamp,
          focusCategory: focusSummary.focusCategory,
          strategyClass,
          confidenceBucket,
          featureSnapshot,
          metrics: {
            averageSpreadBps,
            averageTopOfBookUsd,
            latestTradePrice: Number.isFinite(latestTradePrice) ? latestTradePrice : undefined,
            currentPrice,
          },
        });

        const row = buildWalletScoreRow({
          address,
          profitabilityScore,
          focusScore,
          copyabilityScore,
          earlyScore,
          consistencyScore,
          convictionScore,
          noisePenalty,
          trustScore: featureSnapshot.trustScore,
          strategyClass,
          confidenceBucket,
          scoreVersion: 2,
          updatedAt: runTimestamp,
        });
        row.surfaceBucket = resolveDiscoverySurfaceBucket({
          discoveryScore: row.finalScore,
          trustScore: row.trustScore ?? 0,
          copyabilityScore: row.copyabilityScore,
          strategyClass,
          failedGates: [
            row.passedProfitabilityGate ? null : 'profitability',
            row.passedFocusGate ? null : 'focus',
            row.passedCopyabilityGate ? null : 'copyability',
          ].filter(Boolean) as string[],
          confidenceBucket,
        });

        upsertWalletScoreRow(row);
        const reasons = buildDiscoveryReasonRows(row);
        replaceWalletReasons(address, reasons, runTimestamp);
        const reasonPayload = buildReasonPayloadV2(row, reasons);
        upsertWalletScoreRowV2(row, {
          ...reasonPayload,
          cautionFlags: [...reasonPayload.cautionFlags, ...featureSnapshot.cautionFlags]
            .filter((value, index, values) => values.indexOf(value) === index),
        });
        allocationInputs.push({
          address,
          discoveryScore: row.finalScore,
          trustScore: row.trustScore ?? featureSnapshot.trustScore,
          copyabilityScore: row.copyabilityScore,
          confidenceBucket,
          strategyClass,
          cautionFlags: [...reasonPayload.cautionFlags, ...featureSnapshot.cautionFlags]
            .filter((value, index, values) => values.indexOf(value) === index),
          updatedAt: row.updatedAt,
        });
        scoredRows.push(row);
        if (row.passedCopyabilityGate) {
          copyabilityPassCount += 1;
        }
        if (reasons.filter((reason) => reason.reasonType === 'supporting').length >= 2) {
          walletsWithTwoReasonsCount += 1;
        }

        if (row.passedProfitabilityGate && row.passedFocusGate && row.passedCopyabilityGate) {
          qualifiedCount++;
        } else {
          rejectedCount++;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[DiscoveryWorker] Skipping score for ${address}:`, message);
      }
    }

    const durationMs = Date.now() - startedAt;
    insertDiscoveryRunLog({
      phase: 'free-mode-cycle',
      gammaRequestCount,
      dataRequestCount,
      clobRequestCount,
      candidateCount: candidateAddresses.length,
      qualifiedCount,
      rejectedCount,
      durationMs,
      estimatedCostUsd: 0,
      categoryPurityPct: candidateAddresses.length > 0
        ? roundPct((categorizedCandidateCount / candidateAddresses.length) * 100)
        : 0,
      copyabilityPassPct: candidateAddresses.length > 0
        ? roundPct((copyabilityPassCount / candidateAddresses.length) * 100)
        : 0,
      walletsWithTwoReasonsPct: candidateAddresses.length > 0
        ? roundPct((walletsWithTwoReasonsCount / candidateAddresses.length) * 100)
        : 0,
      freeModeNoAlchemy: !cfg.alchemyWsUrl,
      notes: 'Category-first wallet-seeded discovery cycle',
      createdAt: runTimestamp,
    });

    insertDiscoveryEvaluationSnapshot(
      createCycleEvaluationSnapshot({
        runTimestamp,
        scoredRows,
      }),
    );
    insertDiscoveryEvaluationObservations(runTimestamp, scoredRows);
    insertDiscoveryCostSnapshots([
      {
        provider: 'gamma',
        endpoint: 'events+profile',
        requestCount: gammaRequestCount,
        estimatedCostUsd: 0,
        coverageCount: marketPoolEntries.length,
        runtimeMs: durationMs,
        createdAt: runTimestamp,
      },
      {
        provider: 'data',
        endpoint: 'leaderboard+wallet+activity',
        requestCount: dataRequestCount,
        estimatedCostUsd: 0,
        coverageCount: candidateAddresses.length,
        runtimeMs: durationMs,
        createdAt: runTimestamp,
      },
      {
        provider: 'clob',
        endpoint: 'spread+book',
        requestCount: clobRequestCount,
        estimatedCostUsd: 0,
        coverageCount: candidateAddresses.length,
        runtimeMs: durationMs,
        createdAt: runTimestamp,
      },
    ]);
    evaluateAndPersistAllocationPolicies(
      allocationInputs.map((input) => ({
        address: input.address,
        discoveryScore: input.discoveryScore,
        trustScore: input.trustScore,
        copyabilityScore: input.copyabilityScore,
        confidenceBucket: input.confidenceBucket,
        strategyClass: input.strategyClass,
        cautionFlags: input.cautionFlags,
        updatedAt: input.updatedAt,
      })),
      runTimestamp,
    );
    this.lastCompletedCycleAt = runTimestamp;
    console.log(`[DiscoveryWorker] Cycle complete in ${durationMs}ms (${qualifiedCount} qualified, ${rejectedCount} rejected)`);
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
      validateStatus: (status) => status === 200 || status === 404,
    });
    if (response.status === 404) return null;
    return response.data ?? null;
  }

  private async fetchTraded(address: string): Promise<Record<string, unknown> | null> {
    if (this.options.fetchTraded) {
      return this.options.fetchTraded(address);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/traded`, {
      params: { user: address },
      timeout: 10_000,
      validateStatus: (status) => status === 200 || status === 404,
    });
    if (response.status === 404) return null;
    return response.data ?? null;
  }

  private async fetchPositions(address: string): Promise<Array<Record<string, unknown>>> {
    if (this.options.fetchPositions) {
      return this.options.fetchPositions(address);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/positions`, {
      params: { user: address },
      timeout: 10_000,
      validateStatus: (status) => status === 200 || status === 404,
    });
    if (response.status === 404) return [];
    return response.data ?? [];
  }

  private async fetchClosedPositions(address: string): Promise<Array<Record<string, unknown>>> {
    if (this.options.fetchClosedPositions) {
      return this.options.fetchClosedPositions(address);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/closed-positions`, {
      params: { user: address },
      timeout: 10_000,
      validateStatus: (status) => status === 200 || status === 404,
    });
    if (response.status === 404) return [];
    return response.data ?? [];
  }

  private async fetchActivity(address: string): Promise<Array<Record<string, unknown>>> {
    if (this.options.fetchActivity) {
      return this.options.fetchActivity(address);
    }

    const response = await axios.get(`${config.polymarketDataApiUrl}/activity`, {
      params: { user: address },
      timeout: 10_000,
      validateStatus: (status) => status === 200 || status === 404,
    });
    if (response.status === 404) return [];
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
  const cfg = getDiscoveryConfig();
  console.log('[DiscoveryWorker] Started. Discovery enabled:', cfg.enabled, cfg.enabled ? '' : '(set DISCOVERY_ENABLED=true or enable in the app to run cycles)');
  await runner.start();
  return runner;
};

const main = async (): Promise<void> => {
  const runner = await startDiscoveryWorker(new DiscoveryWorkerRuntime());

  // Discovery v3 — flag-gated, additive. Legacy v1/v2 pipeline above keeps running.
  let v3Handle: Awaited<ReturnType<typeof startDiscoveryV3Worker>> = null;
  if (isDiscoveryV3Enabled()) {
    try {
      const sqlite = await initDatabase();
      v3Handle = await startDiscoveryV3Worker({ sqlite });
    } catch (err) {
      console.error('[DiscoveryWorker] v3 bootstrap failed:', (err as Error).message);
    }
  }

  const handleShutdown = async () => {
    if ('stop' in runner && typeof runner.stop === 'function') {
      await runner.stop();
    }
    if (v3Handle) await v3Handle.stop();
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
