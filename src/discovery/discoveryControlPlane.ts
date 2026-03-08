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
        running: Boolean(latestRun),
        lastPollAt: latestRun?.createdAt,
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
        targetMarketCount: cfg.marketCount,
        pollIntervalMs: cfg.pollIntervalMs,
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
        s.*,
        v.profile_name,
        v.pseudonym,
        v.realized_pnl,
        v.realized_win_rate,
        v.trade_activity_count,
        v.open_positions_count,
        v.last_validated_at,
        tw.active AS tracked_active,
        COALESCE(seed.seed_metric, 0) AS seed_metric,
        COALESCE(seed.seed_count, 0) AS seed_count
      FROM discovery_wallet_scores s
      LEFT JOIN discovery_wallet_validation v ON v.address = s.address
      LEFT JOIN tracked_wallets tw ON tw.address = s.address
      LEFT JOIN (
        SELECT address, MAX(source_metric) AS seed_metric, COUNT(*) AS seed_count
        FROM discovery_wallet_candidates
        GROUP BY address
      ) seed ON seed.address = s.address
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
      const finalScore = Number(row.final_score);
      const heatIndicator = finalScore >= 75
        ? 'HOT'
        : finalScore >= 60
          ? 'WARMING'
          : finalScore >= 45
            ? 'STEADY'
            : finalScore >= 30
              ? 'COOLING'
              : 'COLD';

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
        lastActive: Number(row.updated_at),
        updatedAt: Number(row.updated_at),
        lastValidatedAt: Number(row.last_validated_at ?? 0),
        activePositions: Number(row.open_positions_count ?? 0),
        isTracked: Boolean(row.tracked_active),
        whySurfaced: supportingReasons[0] ?? 'Surfaced from wallet-seeded discovery signals.',
        focusCategory: focusSummary.focusCategory,
        sourceChannels: focusSummary.sourceChannels,
        supportingMarkets: focusSummary.supportingMarkets,
        separateScores: {
          profitability: Number(row.profitability_score),
          focus: Number(row.focus_score),
          copyability: Number(row.copyability_score),
          early: Number(row.early_score),
          consistency: Number(row.consistency_score),
          conviction: Number(row.conviction_score),
          noisePenalty: Number(row.noise_penalty),
        },
        failedGates: [
          Number(row.passed_profitability_gate) ? null : 'profitability',
          Number(row.passed_focus_gate) ? null : 'focus',
          Number(row.passed_copyability_gate) ? null : 'copyability',
        ].filter(Boolean),
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
