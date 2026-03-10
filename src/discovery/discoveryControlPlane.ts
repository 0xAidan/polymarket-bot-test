import { getDatabase } from '../database.js';
import { getLatestDiscoveryRunLog } from './runLog.js';
import { getWalletReasons } from './discoveryScorer.js';
import { getWalletCandidateFocusSummary } from './walletSeedEngine.js';
import {
  cleanupOldSignals,
  cleanupStalePositions,
  getDiscoveryConfig,
  getTotalTradeCount,
  getTotalWalletCount,
  purgeAllDiscoveryData,
  purgeOldTrades,
  updateDiscoveryConfig,
} from './statsStore.js';
import { DiscoveryConfig, DiscoveryStatus } from './types.js';

const roundPct = (value: number): number => Math.round(value * 10) / 10;

const buildDiscoveryState = (input: {
  hasValidation: boolean;
  failedGates: string[];
  supportingReasonCount: number;
  warningReasonCount: number;
}): 'Qualified' | 'Watchlist Candidate' | 'Rejected' | 'Needs Validation' => {
  if (!input.hasValidation) return 'Needs Validation';
  if (input.failedGates.length > 0) return 'Rejected';
  if (input.supportingReasonCount < 2 || input.warningReasonCount > 0) return 'Watchlist Candidate';
  return 'Qualified';
};

const buildWhyNotTracked = (input: {
  isTracked: boolean;
  discoveryState: 'Qualified' | 'Watchlist Candidate' | 'Rejected' | 'Needs Validation';
  failedGates: string[];
}): string | undefined => {
  if (input.isTracked) return 'Already promoted into tracked wallets.';
  if (input.discoveryState === 'Needs Validation') {
    return 'Waiting for official wallet validation before it can be promoted.';
  }
  if (input.discoveryState === 'Rejected') {
    return `Still failing: ${input.failedGates.join(', ')}.`;
  }
  if (input.discoveryState === 'Watchlist Candidate') {
    return 'Needs stronger evidence before manual promotion.';
  }
  return 'Ready for manual promotion into tracked wallets.';
};

const buildWhatChanged = (row: Record<string, unknown>): string => {
  const currentScore = Number(row.final_score ?? 0);
  const previousScore = row.previous_final_score === null || row.previous_final_score === undefined
    ? undefined
    : Number(row.previous_final_score);
  const currentProfitability = Boolean(row.passed_profitability_gate);
  const currentFocus = Boolean(row.passed_focus_gate);
  const currentCopyability = Boolean(row.passed_copyability_gate);
  const previousProfitability = row.previous_passed_profitability_gate === null || row.previous_passed_profitability_gate === undefined
    ? undefined
    : Boolean(row.previous_passed_profitability_gate);
  const previousFocus = row.previous_passed_focus_gate === null || row.previous_passed_focus_gate === undefined
    ? undefined
    : Boolean(row.previous_passed_focus_gate);
  const previousCopyability = row.previous_passed_copyability_gate === null || row.previous_passed_copyability_gate === undefined
    ? undefined
    : Boolean(row.previous_passed_copyability_gate);

  if (previousScore === undefined) {
    return currentScore > 0 ? 'Scored for the first time this run.' : 'Seeded this run and waiting for the first score.';
  }

  if (previousProfitability !== undefined && previousProfitability !== currentProfitability) {
    return currentProfitability ? 'Now passes the profitability gate.' : 'Lost the profitability gate since the last run.';
  }
  if (previousFocus !== undefined && previousFocus !== currentFocus) {
    return currentFocus ? 'Now passes the focus gate.' : 'Lost the focus gate since the last run.';
  }
  if (previousCopyability !== undefined && previousCopyability !== currentCopyability) {
    return currentCopyability ? 'Now passes the copyability gate.' : 'Lost the copyability gate since the last run.';
  }

  const delta = roundPct(currentScore - previousScore);
  if (Math.abs(delta) >= 3) {
    const direction = delta > 0 ? 'improved' : 'fell';
    return `Score ${direction} from ${previousScore.toFixed(1)} to ${currentScore.toFixed(1)}.`;
  }

  return 'Revalidated with no material score change.';
};

export class DiscoveryControlPlane {
  getConfig(): DiscoveryConfig {
    return getDiscoveryConfig();
  }

  async updateConfig(updates: Partial<DiscoveryConfig>): Promise<DiscoveryConfig> {
    updateDiscoveryConfig(updates);
    return getDiscoveryConfig();
  }

  getStatus(): DiscoveryStatus {
    const cfg = getDiscoveryConfig();
    const latestRun = getLatestDiscoveryRunLog();
    const latestRunCreatedAtMs = latestRun
      ? (latestRun.createdAt < 1_000_000_000_000 ? latestRun.createdAt * 1000 : latestRun.createdAt)
      : undefined;
    const runningThresholdMs = Math.max((cfg.statsIntervalMs || 300_000) * 3, 180_000);
    const isFreshRun = Boolean(
      latestRunCreatedAtMs && (Date.now() - latestRunCreatedAtMs) <= runningThresholdMs
    );
    const db = getDatabase();
    const scoredWallets = db.prepare('SELECT COUNT(*) AS count FROM discovery_wallet_scores').get() as { count: number };
    const candidateWallets = db.prepare('SELECT COUNT(DISTINCT address) AS count FROM discovery_wallet_candidates').get() as { count: number };
    const marketPoolCount = (db.prepare('SELECT COUNT(*) AS count FROM discovery_market_pool').get() as { count: number }).count;

    return {
      enabled: cfg.enabled,
      chainListener: {
        connected: false,
        lastEventAt: undefined,
        reconnectCount: 0,
      },
      apiPoller: {
        running: isFreshRun,
        lastPollAt: latestRunCreatedAtMs,
        marketsMonitored: marketPoolCount,
      },
      stats: {
        totalWallets: scoredWallets.count || candidateWallets.count || getTotalWalletCount(),
        totalTrades: latestRun?.candidateCount ?? getTotalTradeCount(),
        uptimeMs: latestRun?.durationMs ?? 0,
      },
      latestRun,
      budgets: {
        cycleIntervalMs: cfg.statsIntervalMs,
        targetGammaRequestsPerCycle: 30,
        targetDataRequestsPerCycle: 150,
        targetClobRequestsPerCycle: 40,
        actualGammaRequestsPerCycle: latestRun?.gammaRequestCount ?? 0,
        actualDataRequestsPerCycle: latestRun?.dataRequestCount ?? 0,
        actualClobRequestsPerCycle: latestRun?.clobRequestCount ?? 0,
        estimatedCostUsd: latestRun?.estimatedCostUsd ?? 0,
        targetMarketCount: cfg.marketCount,
        pollIntervalMs: cfg.pollIntervalMs,
        acceptanceMetrics: latestRun ? {
          categoryPurityPct: latestRun.categoryPurityPct ?? 0,
          copyabilityPassPct: latestRun.copyabilityPassPct ?? 0,
          walletsWithTwoReasonsPct: latestRun.walletsWithTwoReasonsPct ?? 0,
          freeModeNoAlchemy: latestRun.freeModeNoAlchemy !== false,
        } : undefined,
      },
    } as DiscoveryStatus;
  }

  getWallets(
    sort: 'volume' | 'trades' | 'recent' | 'score' | 'roi' = 'volume',
    limit = 50,
    offset = 0,
    filters?: { minScore?: number; heat?: string; hasSignals?: boolean }
  ) {
    const db = getDatabase();
    const orderByMap: Record<string, string> = {
      volume: 'seed_metric DESC, s.final_score DESC',
      trades: 'v.trade_activity_count DESC, s.final_score DESC',
      recent: 's.updated_at DESC',
      score: 's.final_score DESC',
      roi: 'v.realized_pnl DESC, s.final_score DESC',
    };

    let whereClause = 'WHERE 1=1';
    const params: Array<string | number> = [];
    if (filters?.minScore !== undefined) {
      whereClause += ' AND s.final_score >= ?';
      params.push(filters.minScore);
    }
    if (filters?.hasSignals) {
      whereClause += ' AND EXISTS (SELECT 1 FROM discovery_wallet_reasons r WHERE r.address = s.address)';
    }

    params.push(limit, offset);

    const rows = db.prepare(`
      SELECT
        seed.address,
        s.profitability_score,
        s.focus_score,
        s.copyability_score,
        s.early_score,
        s.consistency_score,
        s.conviction_score,
        s.noise_penalty,
        s.passed_profitability_gate,
        s.passed_focus_gate,
        s.passed_copyability_gate,
        s.final_score,
        s.previous_final_score,
        s.previous_updated_at,
        s.previous_passed_profitability_gate,
        s.previous_passed_focus_gate,
        s.previous_passed_copyability_gate,
        s.updated_at,
        v.profile_name,
        v.pseudonym,
        v.realized_pnl,
        v.realized_win_rate,
        v.trade_activity_count,
        v.open_positions_count,
        v.last_validated_at,
        tw.active AS tracked_active,
        COALESCE(seed.seed_metric, 0) AS seed_metric,
        COALESCE(seed.seed_count, 0) AS seed_count,
        COALESCE(seed.last_candidate_at, 0) AS last_candidate_at
      FROM (
        SELECT address, MAX(source_metric) AS seed_metric, COUNT(*) AS seed_count
             , MAX(updated_at) AS last_candidate_at
        FROM discovery_wallet_candidates
        GROUP BY address
      ) seed
      LEFT JOIN discovery_wallet_scores s ON s.address = seed.address
      LEFT JOIN discovery_wallet_validation v ON v.address = seed.address
      LEFT JOIN tracked_wallets tw ON tw.address = seed.address
      ${whereClause}
      ORDER BY ${orderByMap[sort] || orderByMap.score}
      LIMIT ? OFFSET ?
    `).all(...params) as Array<Record<string, unknown>>;

    const wallets = rows.map((row) => {
      const address = String(row.address);
      const focusSummary = getWalletCandidateFocusSummary(address);
      const reasons = getWalletReasons(address);
      const supportingReasons = reasons.filter((reason) => reason.reasonType === 'supporting').map((reason) => reason.message);
      const warningReasons = reasons.filter((reason) => reason.reasonType !== 'supporting').map((reason) => reason.message);
      const reasonCodes = reasons.map((reason) => reason.reasonCode).sort();
      const finalScore = Number(row.final_score ?? 0);
      const heatIndicator = finalScore >= 75
        ? 'HOT'
        : finalScore >= 60
          ? 'WARMING'
          : finalScore >= 45
            ? 'STEADY'
            : finalScore >= 30
              ? 'COOLING'
              : 'COLD';
      const failedGates = [
        row.final_score === null || row.final_score === undefined
          ? null
          : (Number(row.passed_profitability_gate) ? null : 'profitability'),
        row.final_score === null || row.final_score === undefined
          ? null
          : (Number(row.passed_focus_gate) ? null : 'focus'),
        row.final_score === null || row.final_score === undefined
          ? null
          : (Number(row.passed_copyability_gate) ? null : 'copyability'),
      ].filter(Boolean) as string[];
      const hasValidation = Number(row.last_validated_at ?? 0) > 0;
      const discoveryState = buildDiscoveryState({
        hasValidation,
        failedGates,
        supportingReasonCount: supportingReasons.length,
        warningReasonCount: warningReasons.length,
      });
      const updatedAt = Number(row.updated_at ?? row.last_validated_at ?? row.last_candidate_at ?? 0);

      return {
        address,
        pseudonym: row.pseudonym ? String(row.pseudonym) : (row.profile_name ? String(row.profile_name) : undefined),
        whaleScore: finalScore,
        finalScore,
        heatIndicator,
        roiPct: null,
        totalPnl: Number(row.realized_pnl ?? 0),
        tradeCount7d: Number(row.trade_activity_count ?? 0),
        volume7d: Number(row.seed_metric ?? 0),
        lastActive: updatedAt,
        updatedAt,
        lastValidatedAt: Number(row.last_validated_at ?? 0),
        activePositions: Number(row.open_positions_count ?? 0),
        isTracked: Boolean(row.tracked_active),
        whySurfaced: supportingReasons[0] ?? (hasValidation
          ? 'Surfaced from wallet-seeded discovery signals.'
          : 'Surfaced from wallet seeds and queued for validation.'),
        whyNotTracked: buildWhyNotTracked({
          isTracked: Boolean(row.tracked_active),
          discoveryState,
          failedGates,
        }),
        whatChanged: buildWhatChanged(row),
        discoveryState,
        focusCategory: focusSummary.focusCategory,
        sourceChannels: focusSummary.sourceChannels,
        supportingMarkets: focusSummary.supportingMarkets,
        reasonCodes,
        separateScores: {
          profitability: Number(row.profitability_score ?? 0),
          focus: Number(row.focus_score ?? 0),
          copyability: Number(row.copyability_score ?? 0),
          early: Number(row.early_score ?? 0),
          consistency: Number(row.consistency_score ?? 0),
          conviction: Number(row.conviction_score ?? 0),
          noisePenalty: Number(row.noise_penalty ?? 0),
        },
        failedGates,
        supportingReasons,
        warningReasons,
      };
    });

    if (!filters?.heat) return wallets;
    return wallets.filter((wallet) => wallet.heatIndicator === filters.heat);
  }

  purgeData(olderThanDays: number): number {
    return purgeOldTrades(olderThanDays);
  }

  resetData() {
    const deleted = purgeAllDiscoveryData();
    cleanupOldSignals(0);
    cleanupStalePositions(0);
    const db = getDatabase();
    const tx = db.transaction(() => {
      const marketPool = db.prepare('DELETE FROM discovery_market_pool').run().changes;
      const tokenMap = db.prepare('DELETE FROM discovery_token_map').run().changes;
      const candidates = db.prepare('DELETE FROM discovery_wallet_candidates').run().changes;
      const validation = db.prepare('DELETE FROM discovery_wallet_validation').run().changes;
      const scores = db.prepare('DELETE FROM discovery_wallet_scores').run().changes;
      const reasons = db.prepare('DELETE FROM discovery_wallet_reasons').run().changes;
      const runs = db.prepare('DELETE FROM discovery_run_log').run().changes;
      return { marketPool, tokenMap, candidates, validation, scores, reasons, runs };
    });

    return {
      ...deleted,
      ...tx(),
    };
  }

  async restart(): Promise<void> {
    throw new Error('Discovery runtime is managed by the dedicated discovery worker process.');
  }
}
