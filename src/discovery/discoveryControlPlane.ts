import { getDatabase } from '../database.js';
import { getLatestDiscoveryEvaluationSnapshot } from './evaluationEngine.js';
import { getLatestDiscoveryRunLog } from './runLog.js';
import { getWalletReasons } from './discoveryScorer.js';
import { getWalletCandidateFocusSummary, getWalletCandidateFocusSummaryV2 } from './walletSeedEngine.js';
import { getAllocationPolicyState } from '../allocation/policyEngine.js';
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
import {
  DiscoveryConfig,
  DiscoveryConfidenceBucket,
  DiscoveryStatus,
  DiscoveryStrategyClass,
  DiscoverySurfaceBucket,
} from './types.js';

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

const aliasAdjectives = [
  'Silver', 'Blue', 'Quiet', 'Crimson', 'Golden', 'Rapid', 'Steady', 'Swift', 'Bold', 'Calm',
];
const aliasAnimals = [
  'Otter', 'Falcon', 'Panther', 'Fox', 'Wolf', 'Hawk', 'Lynx', 'Bear', 'Dolphin', 'Badger',
];

const hashAddress = (address: string): number => {
  let hash = 0;
  for (const char of address.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
};

const buildWalletAlias = (address: string): string => {
  const hash = hashAddress(address);
  const adjective = aliasAdjectives[hash % aliasAdjectives.length] ?? 'Sharp';
  const animal = aliasAnimals[Math.floor(hash / aliasAdjectives.length) % aliasAnimals.length] ?? 'Trader';
  return `${adjective} ${animal}`;
};

const parseJsonArray = (value: unknown): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value)) as unknown[];
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
};

const normalizeConfidence = (value: unknown): DiscoveryConfidenceBucket => {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'low';
};

const normalizeSurfaceBucket = (value: unknown): DiscoverySurfaceBucket => {
  const normalized = String(value ?? '').toLowerCase();
  const valid: DiscoverySurfaceBucket[] = ['emerging', 'trusted', 'copyable', 'watch_only', 'suppressed'];
  return valid.includes(normalized as DiscoverySurfaceBucket)
    ? normalized as DiscoverySurfaceBucket
    : 'watch_only';
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
    const latestEvaluation = getLatestDiscoveryEvaluationSnapshot();
    const latestRunCreatedAtMs = latestRun
      ? (latestRun.createdAt < 1_000_000_000_000 ? latestRun.createdAt * 1000 : latestRun.createdAt)
      : undefined;
    const runningThresholdMs = Math.max((cfg.statsIntervalMs || 300_000) * 3, 180_000);
    const isFreshRun = Boolean(
      latestRunCreatedAtMs && (Date.now() - latestRunCreatedAtMs) <= runningThresholdMs
    );
    const db = getDatabase();
    const scoredWallets = db.prepare('SELECT COUNT(*) AS count FROM discovery_wallet_scores').get() as { count: number };
    const scoredWalletsV2 = db.prepare('SELECT COUNT(*) AS count FROM discovery_wallet_scores_v2').get() as { count: number };
    const latestCandidateSnapshot = db.prepare(`
      SELECT MAX(snapshot_at) AS snapshot_at
      FROM discovery_wallet_candidates_v2
    `).get() as { snapshot_at?: number | null };
    const candidateWallets = Number(latestCandidateSnapshot.snapshot_at ?? 0) > 0
      ? (db.prepare(`
          SELECT COUNT(DISTINCT address) AS count
          FROM discovery_wallet_candidates_v2
          WHERE snapshot_at = ?
        `).get(Number(latestCandidateSnapshot.snapshot_at)) as { count: number })
      : cfg.readMode === 'v2-primary'
        ? ({ count: 0 } as { count: number })
        : (db.prepare('SELECT COUNT(DISTINCT address) AS count FROM discovery_wallet_candidates').get() as { count: number });
    const marketPoolCount = (db.prepare('SELECT COUNT(*) AS count FROM discovery_market_pool').get() as { count: number }).count;
    const evalObservationCount = (db.prepare('SELECT COUNT(*) AS count FROM discovery_eval_observations_v2').get() as { count: number }).count;
    const dualWriteCoveragePct = scoredWallets.count > 0
      ? roundPct((scoredWalletsV2.count / scoredWallets.count) * 100)
      : 100;
    const evaluationLift = latestEvaluation
      ? roundPct((latestEvaluation.precisionAtK - latestEvaluation.baselinePrecisionAtK) * 100)
      : 0;
    const readyForCutover = Boolean(
      latestEvaluation &&
      dualWriteCoveragePct >= 90 &&
      evalObservationCount >= 100 &&
      latestEvaluation.precisionAtK >= latestEvaluation.baselinePrecisionAtK
    );

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
        evaluation: latestEvaluation ? {
          precisionAtK: latestEvaluation.precisionAtK,
          meanAveragePrecision: latestEvaluation.meanAveragePrecision,
          ndcg: latestEvaluation.ndcg,
          baselinePrecisionAtK: latestEvaluation.baselinePrecisionAtK,
        } : undefined,
        migration: {
          dualWriteCoveragePct,
          evalObservationCount,
          evaluationLiftPctPoints: evaluationLift,
          readyForCutover,
          configuredReadMode: cfg.readMode,
          recommendedReadMode: readyForCutover ? 'v2-primary' : 'v2-with-v1-fallback',
          cutoverReadMode: cfg.readMode,
        },
      },
    } as DiscoveryStatus;
  }

  getWallets(
    sort: 'volume' | 'trades' | 'recent' | 'score' | 'roi' | 'trust' = 'trust',
    limit = 50,
    offset = 0,
    filters?: { minScore?: number; heat?: string; hasSignals?: boolean }
  ) {
    const db = getDatabase();
    const cfg = getDiscoveryConfig();
    const latestCandidateSnapshot = db.prepare(`
      SELECT MAX(snapshot_at) AS snapshot_at
      FROM discovery_wallet_candidates_v2
    `).get() as { snapshot_at?: number | null };
    const hasV2CandidateSnapshot = Number(latestCandidateSnapshot.snapshot_at ?? 0) > 0;
    const scoreOrderExpr = cfg.readMode === 'v2-primary'
      ? 'COALESCE(s2.discovery_score, 0)'
      : 'COALESCE(s2.discovery_score, s.final_score, 0)';
    const trustOrderExpr = cfg.readMode === 'v2-primary'
      ? 'COALESCE(s2.trust_score, 0)'
      : 'COALESCE(s2.trust_score, s.trust_score, 0)';
    const copyabilityOrderExpr = cfg.readMode === 'v2-primary'
      ? 'COALESCE(s2.copyability_score, 0)'
      : 'COALESCE(s2.copyability_score, s.copyability_score, 0)';
    const orderByMap: Record<string, string> = {
      volume: `seed_metric DESC, ${scoreOrderExpr} DESC`,
      trades: `v.trade_activity_count DESC, ${scoreOrderExpr} DESC`,
      recent: 'COALESCE(s2.updated_at, s.updated_at, seed.last_candidate_at) DESC',
      score: `${scoreOrderExpr} DESC`,
      roi: `v.realized_pnl DESC, ${scoreOrderExpr} DESC`,
      trust: `${trustOrderExpr} DESC, ${copyabilityOrderExpr} DESC, ${scoreOrderExpr} DESC`,
    };

    let whereClause = 'WHERE 1=1';
    const params: Array<string | number> = [];
    if (filters?.minScore !== undefined) {
      whereClause += ' AND COALESCE(s2.discovery_score, s.final_score, 0) >= ?';
      params.push(filters.minScore);
    }
    if (filters?.hasSignals) {
      whereClause += ' AND EXISTS (SELECT 1 FROM discovery_wallet_reasons r WHERE r.address = seed.address)';
    }

    params.push(limit, offset);

    const seedQuery = hasV2CandidateSnapshot
      ? `
        SELECT address, MAX(source_metric) AS seed_metric, COUNT(*) AS seed_count
             , MAX(updated_at) AS last_candidate_at
        FROM discovery_wallet_candidates_v2
        WHERE snapshot_at = ${Number(latestCandidateSnapshot.snapshot_at)}
        GROUP BY address
      `
      : cfg.readMode === 'v2-primary'
        ? `
        SELECT NULL AS address, 0 AS seed_metric, 0 AS seed_count, 0 AS last_candidate_at
        WHERE 1 = 0
      `
        : `
        SELECT address, MAX(source_metric) AS seed_metric, COUNT(*) AS seed_count
             , MAX(updated_at) AS last_candidate_at
        FROM discovery_wallet_candidates
        GROUP BY address
      `;

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
        s.trust_score,
        s.strategy_class,
        s.confidence_bucket,
        s.surface_bucket,
        s.score_version,
        s.updated_at,
        s2.discovery_score AS v2_discovery_score,
        s2.trust_score AS v2_trust_score,
        s2.copyability_score AS v2_copyability_score,
        s2.strategy_class AS v2_strategy_class,
        s2.confidence_bucket AS v2_confidence_bucket,
        s2.surface_bucket AS v2_surface_bucket,
        s2.primary_reason AS v2_primary_reason,
        s2.supporting_reasons_json AS v2_supporting_reasons_json,
        s2.caution_flags_json AS v2_caution_flags_json,
        s2.score_version AS v2_score_version,
        s2.updated_at AS v2_updated_at,
        f2.confidence_evidence_count AS v2_confidence_evidence_count,
        f2.source_channels_json AS v2_source_channels_json,
        f2.supporting_markets_json AS v2_supporting_markets_json,
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
        ${seedQuery}
      ) seed
      LEFT JOIN discovery_wallet_scores s ON s.address = seed.address
      LEFT JOIN discovery_wallet_scores_v2 s2 ON s2.address = seed.address
      LEFT JOIN discovery_wallet_features_v2 f2 ON f2.address = seed.address
      LEFT JOIN discovery_wallet_validation v ON v.address = seed.address
      LEFT JOIN tracked_wallets tw ON tw.address = seed.address
      ${whereClause}
      ORDER BY ${orderByMap[sort] || orderByMap.score}
      LIMIT ? OFFSET ?
    `).all(...params) as Array<Record<string, unknown>>;

    const wallets = rows.map((row) => {
      const address = String(row.address);
      const focusSummaryV2 = getWalletCandidateFocusSummaryV2(address);
      const focusSummary = (
        focusSummaryV2.focusCategory ||
        focusSummaryV2.supportingMarkets.length > 0 ||
        focusSummaryV2.sourceChannels.length > 0
      )
        ? focusSummaryV2
        : getWalletCandidateFocusSummary(address);
      const persistedSourceChannels = parseJsonArray(row.v2_source_channels_json);
      const persistedSupportingMarkets = parseJsonArray(row.v2_supporting_markets_json);
      const reasons = getWalletReasons(address);
      const reasonDetails = reasons.map((reason) => ({
        reasonType: reason.reasonType,
        reasonCode: reason.reasonCode,
        message: reason.message,
        createdAt: reason.createdAt,
      }));
      const supportingReasons = reasons.filter((reason) => reason.reasonType === 'supporting').map((reason) => reason.message);
      const warningReasons = reasons.filter((reason) => reason.reasonType !== 'supporting').map((reason) => reason.message);
      const reasonCodes = reasons.map((reason) => reason.reasonCode).sort();
      const discoveryScore = Number(cfg.readMode === 'v2-primary'
        ? (row.v2_discovery_score ?? 0)
        : (row.v2_discovery_score ?? row.final_score ?? 0));
      const trustScore = Number(cfg.readMode === 'v2-primary'
        ? (row.v2_trust_score ?? 0)
        : (row.v2_trust_score ?? row.trust_score ?? 0));
      const copyabilityScore = Number(cfg.readMode === 'v2-primary'
        ? (row.v2_copyability_score ?? 0)
        : (row.v2_copyability_score ?? row.copyability_score ?? 0));
      const strategyClass = String(
        cfg.readMode === 'v2-primary'
          ? (row.v2_strategy_class ?? 'unknown')
          : (row.v2_strategy_class ?? row.strategy_class ?? 'unknown'),
      ) as DiscoveryStrategyClass;
      const confidenceBucket = normalizeConfidence(
        cfg.readMode === 'v2-primary'
          ? (row.v2_confidence_bucket ?? 'low')
          : (row.v2_confidence_bucket ?? row.confidence_bucket)
      );
      const surfaceBucket = normalizeSurfaceBucket(
        cfg.readMode === 'v2-primary'
          ? (row.v2_surface_bucket ?? 'watch_only')
          : (row.v2_surface_bucket ?? row.surface_bucket)
      );
      const scoreVersion = Number(
        cfg.readMode === 'v2-primary'
          ? (row.v2_score_version ?? 2)
          : (row.v2_score_version ?? row.score_version ?? 1)
      );
      const heatIndicator = discoveryScore >= 75
        ? 'HOT'
        : discoveryScore >= 60
          ? 'WARMING'
          : discoveryScore >= 45
            ? 'STEADY'
            : discoveryScore >= 30
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
      const updatedAt = Number(
        row.v2_updated_at ?? row.updated_at ?? row.last_validated_at ?? row.last_candidate_at ?? 0,
      );
      const parsedSupportingReasons = parseJsonArray(row.v2_supporting_reasons_json);
      const parsedCautionFlags = parseJsonArray(row.v2_caution_flags_json);
      const displayName = row.pseudonym
        ? String(row.pseudonym)
        : (row.profile_name ? String(row.profile_name) : buildWalletAlias(address));
      const primaryReason = row.v2_primary_reason
        ? String(row.v2_primary_reason)
        : (supportingReasons[0] ?? (hasValidation
          ? 'Surfaced from wallet-seeded discovery signals.'
          : 'Surfaced from wallet seeds and queued for validation.'));
      const cautionFlags = parsedCautionFlags.length > 0 ? parsedCautionFlags : warningReasons;
      const finalSupportingReasons = parsedSupportingReasons.length > 0
        ? parsedSupportingReasons
        : supportingReasons;
      const freshnessMs = updatedAt > 0
        ? Math.max(0, Date.now() - (updatedAt < 1_000_000_000_000 ? updatedAt * 1000 : updatedAt))
        : null;
      const allocationState = getAllocationPolicyState(address);

      return {
        schemaVersion: 2,
        address,
        displayName,
        pseudonym: row.pseudonym ? String(row.pseudonym) : (row.profile_name ? String(row.profile_name) : undefined),
        strategyClass,
        discoveryScore,
        trustScore,
        copyabilityScore,
        confidence: confidenceBucket,
        surfaceBucket,
        scoreVersion,
        primaryReason,
        supportingReasonChips: finalSupportingReasons.slice(0, 3),
        cautionFlags,
        freshnessMs,
        whaleScore: discoveryScore,
        finalScore: discoveryScore,
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
        whySurfaced: primaryReason,
        allocationState: allocationState?.state,
        allocationWeight: allocationState?.targetWeight,
        whyNotTracked: buildWhyNotTracked({
          isTracked: Boolean(row.tracked_active),
          discoveryState,
          failedGates,
        }),
        whatChanged: buildWhatChanged(row),
        discoveryState,
        focusCategory: focusSummary.focusCategory,
        sourceChannels: persistedSourceChannels.length > 0 ? persistedSourceChannels : focusSummary.sourceChannels,
        supportingMarkets: persistedSupportingMarkets.length > 0 ? persistedSupportingMarkets : focusSummary.supportingMarkets,
        evidenceCount: Number(row.v2_confidence_evidence_count ?? 0),
        reasonCodes,
        reasonDetails,
        separateScores: {
          profitability: Number(row.profitability_score ?? 0),
          focus: Number(row.focus_score ?? 0),
          copyability: copyabilityScore,
          early: Number(row.early_score ?? 0),
          consistency: Number(row.consistency_score ?? 0),
          conviction: Number(row.conviction_score ?? 0),
          trust: trustScore,
          noisePenalty: Number(row.noise_penalty ?? 0),
        },
        failedGates,
        supportingReasons: finalSupportingReasons,
        warningReasons: cautionFlags,
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
      const scoresV2 = db.prepare('DELETE FROM discovery_wallet_scores_v2').run().changes;
      const reasons = db.prepare('DELETE FROM discovery_wallet_reasons').run().changes;
      const reasonsV2 = db.prepare('DELETE FROM discovery_wallet_reasons_v2').run().changes;
      const runs = db.prepare('DELETE FROM discovery_run_log').run().changes;
      const evaluations = db.prepare('DELETE FROM discovery_eval_snapshots_v2').run().changes;
      const evalObservations = db.prepare('DELETE FROM discovery_eval_observations_v2').run().changes;
      const costSnapshots = db.prepare('DELETE FROM discovery_cost_snapshots_v2').run().changes;
      const tradeFactsV2 = db.prepare('DELETE FROM discovery_trade_facts_v2').run().changes;
      const marketUniverseV2 = db.prepare('DELETE FROM discovery_market_universe_v2').run().changes;
      const walletFeaturesV2 = db.prepare('DELETE FROM discovery_wallet_features_v2').run().changes;
      const alertsV2 = db.prepare('DELETE FROM discovery_alerts_v2').run().changes;
      const watchlist = db.prepare('DELETE FROM discovery_watchlist').run().changes;
      const allocationStates = db.prepare('DELETE FROM allocation_policy_states').run().changes;
      const allocationTransitions = db.prepare('DELETE FROM allocation_policy_transitions').run().changes;
      const allocationConfig = db.prepare('DELETE FROM allocation_policy_config').run().changes;
      return {
        marketPool,
        tokenMap,
        candidates,
        validation,
        scores,
        scoresV2,
        reasons,
        reasonsV2,
        runs,
        evaluations,
        evalObservations,
        costSnapshots,
        tradeFactsV2,
        marketUniverseV2,
        walletFeaturesV2,
        alertsV2,
        watchlist,
        allocationStates,
        allocationTransitions,
        allocationConfig,
      };
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
