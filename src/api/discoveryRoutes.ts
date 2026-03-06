/**
 * Discovery API Routes
 *
 * REST endpoints for the discovery engine. Provides wallet listings,
 * runtime config management, engine restart, status, and data purge.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { initDiscoveryDatabase } from '../discovery/discoveryDatabase.js';
import { DiscoveryManager } from '../discovery/discoveryManager.js';
import { DiscoveryConfig, DiscoveryMarketCategory } from '../discovery/types.js';
import {
  fetchAuthoritativePositions,
  summarizeAuthoritativePositions,
  buildPositionVerificationSummary,
} from '../discovery/positionTracker.js';
import {
  markWalletTracked,
  getRecentSignals,
  getUnusualMarkets,
  dismissSignal,
  getPositionsByAddress,
  getSignalsForAddress,
} from '../discovery/statsStore.js';
import { computeDiscoveryWalletScore } from '../discovery/walletScorer.js';
import { classifyDiscoveryMarket } from '../discovery/marketClassifier.js';
import { buildDiscoveryCandidates } from '../discovery/candidateGenerator.js';
import { preRankDiscoveryCandidates } from '../discovery/preRanker.js';
import { reRankDiscoveryCandidates } from '../discovery/reRanker.js';
import { evaluateWalletVerificationGate } from '../discovery/verificationService.js';

/**
 * Mask an Alchemy WebSocket URL for safe display.
 * Shows `wss://polygon-mainnet.g.alchemy.com/v2/****abcd`
 */
const maskAlchemyUrl = (url: string): string => {
  if (!url) return '';
  const parts = url.split('/');
  const key = parts[parts.length - 1];
  if (key.length > 4) {
    parts[parts.length - 1] = '****' + key.slice(-4);
  }
  return parts.join('/');
};

const normalizeAlchemyWsUrl = (raw: string): string => {
  const value = (raw || '').trim();
  if (!value) return '';
  if (value.startsWith('ws://') || value.startsWith('wss://')) return value;
  return `wss://polygon-mainnet.g.alchemy.com/v2/${value}`;
};

export const applyAuthoritativeWalletSummary = <T extends { roiPct?: number | null; totalPnl?: number; activePositions?: number }>(
  wallet: T,
  positions: Array<unknown>
): T & { positionDataSource: 'verified' } => {
  if (positions.length === 0) {
    return {
      ...wallet,
      roiPct: null,
      totalPnl: 0,
      activePositions: 0,
      positionDataSource: 'verified',
    };
  }

  const summary = summarizeAuthoritativePositions(positions as any);
  return {
    ...wallet,
    roiPct: summary.roiPct,
    totalPnl: summary.totalPnl,
    activePositions: summary.activePositions,
    positionDataSource: 'verified',
  };
};

export const buildWalletPositionsResponse = (
  address: string,
  positions: any[],
  authoritativeSuccess: boolean,
) => {
  if (authoritativeSuccess) {
    return { success: true, address, positions, source: 'verified' as const };
  }

  return {
    success: true,
    address,
    positions: positions.map((position) => ({
      ...position,
      dataSource: position.dataSource ?? 'derived',
    })),
    source: 'derived' as const,
  };
};

export const applyDiscoveryWalletScore = <T extends {
  whaleScore?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  avgTradeSize?: number;
  uniqueMarkets7d?: number;
  roiPct?: number | null;
  totalPnl?: number;
  activePositions?: number;
}>(
  wallet: T,
  maxVolume: number,
): T & { whaleScore: number } => ({
  ...wallet,
  whaleScore: computeDiscoveryWalletScore(wallet, maxVolume),
});

export const sortWalletsForResponse = <T extends {
  whaleScore?: number;
  roiPct?: number | null;
  lastActive?: number;
  tradeCount7d?: number;
  volume7d?: number;
}>(
  wallets: T[],
  sort: 'volume' | 'trades' | 'recent' | 'score' | 'roi',
): T[] => {
  const sorted = [...wallets];
  sorted.sort((a, b) => {
    if (sort === 'score') return (b.whaleScore || 0) - (a.whaleScore || 0);
    if (sort === 'roi') return (b.roiPct ?? Number.NEGATIVE_INFINITY) - (a.roiPct ?? Number.NEGATIVE_INFINITY);
    if (sort === 'recent') return (b.lastActive || 0) - (a.lastActive || 0);
    if (sort === 'trades') return (b.tradeCount7d || 0) - (a.tradeCount7d || 0);
    return (b.volume7d || 0) - (a.volume7d || 0);
  });
  return sorted;
};

const DISCOVERY_CATEGORY_LABELS: Record<string, string> = {
  politics: 'Politics',
  macro: 'Macro',
  company: 'Company',
  legal: 'Legal',
  geopolitics: 'Geopolitics',
  entertainment: 'Entertainment',
  sports: 'Sports',
  crypto: 'Crypto',
  event: 'Real-world',
  other: 'Other',
};
const DISCOVERY_CATEGORY_PRIORITY: Record<string, number> = {
  politics: 0,
  macro: 1,
  company: 2,
  legal: 3,
  geopolitics: 4,
  event: 5,
  entertainment: 6,
  other: 7,
  sports: 8,
  crypto: 9,
};

export const buildDiscoveryWalletExplanation = <T extends {
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  lastSignalType?: string;
}>(
  wallet: T,
): string => {
  const focusLabel = DISCOVERY_CATEGORY_LABELS[wallet.focusCategory || 'event'] || 'Real-world';
  const parts: string[] = [`${focusLabel} focus`];
  const highInformationShare = Number(wallet.volume7d || 0) > 0
    ? Number(wallet.highInformationVolume7d || 0) / Number(wallet.volume7d || 0)
    : 0;

  if (highInformationShare >= 0.6) {
    parts.push('high-information flow');
  }
  if (Math.min(Number(wallet.volume7d || 0), Number(wallet.volumePrev7d || 0)) >= 5000) {
    parts.push('sustained weekly volume');
  }
  if (Number(wallet.tradeCount7d || 0) >= 8) {
    parts.push('repeated participation');
  }
  if (wallet.lastSignalType) {
    parts.push((wallet.lastSignalType || '').replace(/_/g, ' ').toLowerCase());
  }

  return parts.join(' + ');
};

export const shouldIncludeDiscoveryWallet = <T extends {
  whaleScore?: number;
  volume7d?: number;
  tradeCount7d?: number;
  lastSignalAt?: number;
  activePositions?: number;
  totalCost?: number;
}>(
  wallet: T,
): boolean => {
  return evaluateWalletVerificationGate(wallet).trustLevel !== 'suppressed';
};

export const matchesDiscoveryFocusFilter = <T extends {
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
}>(
  wallet: T,
  focus: 'all-real-world' | 'high-information',
): boolean => {
  if (focus !== 'high-information') {
    return wallet.focusCategory !== 'sports' && wallet.focusCategory !== 'crypto';
  }
  const volume7d = Number(wallet.volume7d || 0);
  const highInformationVolume7d = Number(wallet.highInformationVolume7d || 0);
  if (volume7d <= 0) return false;
  if (['politics', 'macro', 'company', 'legal', 'geopolitics'].includes(wallet.focusCategory || '')) return true;
  return highInformationVolume7d / volume7d >= 0.6;
};

const annotateDiscoveryWallet = <T extends {
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  lastSignalType?: string;
  trustLevel?: 'provisional' | 'verified';
  trustWarning?: string;
}>(
  wallet: T,
): T & { whySurfaced: string } => ({
  ...wallet,
  whySurfaced: buildDiscoveryWalletExplanation(wallet),
});

export const applyDiscoverySurfaceMetadata = <T extends Record<string, unknown>>(
  wallet: T,
  surfaceMode: 'provisional' | 'verified',
): T & { trustLevel: 'provisional' | 'verified'; trustWarning?: string } => ({
  ...wallet,
  trustLevel: (
    String((wallet as { trustLevel?: string }).trustLevel || '').trim() ||
    surfaceMode
  ) as 'provisional' | 'verified',
  trustWarning: surfaceMode === 'provisional'
    ? 'Current discovery output is provisional. Verify it before treating it as actionable.'
    : undefined,
});

const filterDiscoveryWalletsForPresentation = <T extends {
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  lastSignalType?: string;
  whaleScore?: number;
  lastSignalAt?: number;
  activePositions?: number;
  totalCost?: number;
}>(
  wallets: T[],
  focus: 'all-real-world' | 'high-information',
  includeAll: boolean,
  surfaceMode: 'provisional' | 'verified' = 'provisional',
): Array<T & { whySurfaced: string }> => {
  const rankedCandidates = reRankDiscoveryCandidates(
    preRankDiscoveryCandidates(
      buildDiscoveryCandidates(wallets)
    )
  );

  return rankedCandidates
    .map((wallet) => {
      const verification = evaluateWalletVerificationGate(wallet);
      return {
        ...wallet,
        trustLevel: verification.trustLevel === 'suppressed' ? 'provisional' : verification.trustLevel,
        suppressionReason: verification.reason,
      };
    })
    .map((wallet) => applyDiscoverySurfaceMetadata(wallet, surfaceMode))
    .map(annotateDiscoveryWallet)
    .filter((wallet) => matchesDiscoveryFocusFilter(wallet, focus))
    .filter((wallet) => includeAll || shouldIncludeDiscoveryWallet(wallet));
};

export const paginateDiscoveryWalletsForPresentation = <T extends {
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  lastSignalType?: string;
  whaleScore?: number;
  lastSignalAt?: number;
}>(
  wallets: T[],
  options: {
    focus: 'all-real-world' | 'high-information';
    includeAll: boolean;
    limit: number;
    offset: number;
    surfaceMode?: 'provisional' | 'verified';
  },
): Array<T & { whySurfaced: string }> => {
  return filterDiscoveryWalletsForPresentation(
    wallets,
    options.focus,
    options.includeAll,
    options.surfaceMode ?? 'provisional',
  )
    .slice(options.offset, options.offset + options.limit);
};

export const buildDiscoveryOverview = (
  wallets: Array<{
    address: string;
    whaleScore?: number;
    volume7d?: number;
    tradeCount7d?: number;
    lastSignalAt?: number;
    lastActive?: number;
    isTracked?: boolean;
    focusCategory?: DiscoveryMarketCategory;
  }>,
  signals: Array<{
    address: string;
    severity?: string;
    marketTitle?: string;
    detectedAt?: number;
  }>,
  days: number,
) => {
  const surfacedWallets = wallets.filter(shouldIncludeDiscoveryWallet);
  const surfacedCutoff = Date.now() - 24 * 3600 * 1000;
  const signalCutoff = Date.now() - days * 86400 * 1000;
  const highInformationCategories = new Set(['politics', 'macro', 'company', 'legal', 'geopolitics']);
  const surfacedToday = surfacedWallets.filter((wallet) => Number(wallet.lastActive || 0) >= surfacedCutoff);
  const highInformationWallets = surfacedWallets.filter((wallet) => highInformationCategories.has(wallet.focusCategory || ''));
  const strongSignalCounts = new Map<string, number>();

  for (const signal of signals) {
    if (Number(signal.detectedAt || 0) < signalCutoff) continue;
    if (signal.severity !== 'high' && signal.severity !== 'critical') continue;
    strongSignalCounts.set(signal.address, (strongSignalCounts.get(signal.address) ?? 0) + 1);
  }

  const surfacedByCategory = [...surfacedWallets.reduce((acc, wallet) => {
    const category = wallet.focusCategory || 'event';
    acc.set(category, (acc.get(category) ?? 0) + 1);
    return acc;
  }, new Map<string, number>()).entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (DISCOVERY_CATEGORY_PRIORITY[a.category] ?? 99) - (DISCOVERY_CATEGORY_PRIORITY[b.category] ?? 99));

  const signalCountsByCategory = [...signals.reduce((acc, signal) => {
    if (Number(signal.detectedAt || 0) < signalCutoff) return acc;
    const category = classifyDiscoveryMarket({ title: signal.marketTitle }).category || 'event';
    acc.set(category, (acc.get(category) ?? 0) + 1);
    return acc;
  }, new Map<string, number>()).entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (DISCOVERY_CATEGORY_PRIORITY[a.category] ?? 99) - (DISCOVERY_CATEGORY_PRIORITY[b.category] ?? 99));

  const topWalletsByDay = [...surfacedWallets.reduce((acc, wallet) => {
    const bucket = new Date(Number(wallet.lastActive || 0)).toISOString().slice(0, 10);
    const list = acc.get(bucket) ?? [];
    list.push({
      address: wallet.address,
      whaleScore: wallet.whaleScore || 0,
      focusCategory: wallet.focusCategory || 'event',
    });
    acc.set(bucket, list);
    return acc;
  }, new Map<string, Array<{ address: string; whaleScore: number; focusCategory: string }>>()).entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, days)
    .map(([day, dailyWallets]) => ({
      day,
      wallets: dailyWallets.sort((a, b) => b.whaleScore - a.whaleScore).slice(0, 5),
    }));

  return {
    quality: {
      walletsSurfacedToday: surfacedToday.length,
      highInformationWalletPct: surfacedWallets.length === 0
        ? 0
        : Math.round((highInformationWallets.length / surfacedWallets.length) * 100),
      walletsWithTwoStrongSignals: [...strongSignalCounts.values()].filter((count) => count >= 2).length,
      trackedWallets: surfacedWallets.filter((wallet) => wallet.isTracked).length,
    },
    surfacedByCategory,
    signalCountsByCategory,
    topWalletsByDay,
  };
};

export const buildDiscoveryOpportunityFeed = (wallets: Array<{
  address: string;
  focusCategory?: DiscoveryMarketCategory;
  trustLevel?: 'provisional' | 'verified';
  whySurfaced?: string;
  heatIndicator?: string;
  lastSignalType?: string;
  activePositions?: number;
  whaleScore?: number;
  volume7d?: number;
}>): {
  groups: Array<{
    id: string;
    title: string;
    items: Array<{
      address: string;
      focusCategory?: DiscoveryMarketCategory;
      trustLevel?: 'provisional' | 'verified';
      whySurfaced?: string;
      whaleScore?: number;
      volume7d?: number;
    }>;
  }>;
} => {
  const emerging = wallets.filter((wallet) => {
    const signalType = String(wallet.lastSignalType || '');
    if (signalType === 'CONVICTION_BUILD' || signalType === 'COORDINATED_ENTRY' || signalType === 'MARKET_PIONEER') return false;
    return wallet.heatIndicator === 'NEW' || wallet.heatIndicator === 'WARMING';
  }).slice(0, 6);

  const conviction = wallets.filter((wallet) => {
    return wallet.lastSignalType === 'CONVICTION_BUILD' || Number(wallet.activePositions || 0) >= 2;
  }).slice(0, 6);

  const coordinated = wallets.filter((wallet) => {
    return wallet.lastSignalType === 'COORDINATED_ENTRY' || wallet.lastSignalType === 'MARKET_PIONEER';
  }).slice(0, 6);

  return {
    groups: [
      { id: 'emerging', title: 'Emerging Wallets', items: emerging },
      { id: 'conviction', title: 'Conviction Builds', items: conviction },
      { id: 'coordinated', title: 'Coordinated Markets', items: coordinated },
    ],
  };
};

export const buildDiscoveryShadowComparison = (
  legacyWallets: Array<{ address: string; trustLevel?: 'provisional' | 'verified' }>,
  groupedFeed: ReturnType<typeof buildDiscoveryOpportunityFeed>,
) => ({
  legacyWalletCount: legacyWallets.length,
  groupedOpportunityCount: groupedFeed.groups.reduce((sum, group) => sum + group.items.length, 0),
  groups: groupedFeed.groups.map((group) => ({
    id: group.id,
    title: group.title,
    count: group.items.length,
  })),
});

/** Ensure DB is initialized before any discovery route (e.g. when user saves config before copy trader has started). */
const ensureDatabase = async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    await initDiscoveryDatabase();
    next();
  } catch (err: any) {
    next(err);
  }
};

export const createDiscoveryRoutes = (manager: DiscoveryManager): Router => {
  const router = Router();

  router.use(ensureDatabase);

  // -----------------------------------------------------------------------
  // GET /wallets — ranked list of discovered wallets (with filters)
  // -----------------------------------------------------------------------
  router.get('/wallets', (req: Request, res: Response) => {
    void (async () => {
      try {
        const discoveryConfig = manager.getConfig();
        const sort = (req.query.sort as 'volume' | 'trades' | 'recent' | 'score' | 'roi') || 'volume';
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const hydratePositions = req.query.hydratePositions === 'true';
        const includeAll = req.query.includeAll === 'true';
        const focus = req.query.focus === 'high-information' ? 'high-information' : 'all-real-world';
        const filters: { minScore?: number; heat?: string; hasSignals?: boolean } = {};
        if (req.query.minScore !== undefined) filters.minScore = parseFloat(req.query.minScore as string);
        if (req.query.heat) filters.heat = req.query.heat as string;
        if (req.query.hasSignals === 'true') filters.hasSignals = true;

        const rawBatchSize = Math.min(Math.max(limit * 3, 50), 200);
        const requiredCount = offset + limit;
        let rawOffset = 0;
        let filteredWallets: Array<any> = [];

        while (filteredWallets.length < requiredCount) {
          const batch = manager.getWallets(sort, rawBatchSize, rawOffset, filters);
          if (batch.length === 0) break;
          filteredWallets = filteredWallets.concat(
            filterDiscoveryWalletsForPresentation(batch as any[], focus, includeAll, discoveryConfig.surfaceMode)
          );
          rawOffset += batch.length;
          if (batch.length < rawBatchSize) break;
        }

        const wallets = filteredWallets.slice(offset, offset + limit);
        if (!hydratePositions || wallets.length === 0) {
          res.json({
            success: true,
            wallets,
            surfaceMode: discoveryConfig.surfaceMode,
            broadPollingEnabled: discoveryConfig.broadPollingEnabled,
          });
          return;
        }

        const hydratedWallets = await Promise.all(wallets.map(async (wallet) => {
          try {
            return applyAuthoritativeWalletSummary(wallet, await fetchAuthoritativePositions(wallet.address));
          } catch {
            return {
              ...wallet,
              positionDataSource: 'derived',
            };
          }
        }));

        res.json({
          success: true,
          wallets: hydratedWallets
            .map((wallet) => applyDiscoverySurfaceMetadata(wallet, discoveryConfig.surfaceMode))
            .map(annotateDiscoveryWallet),
          surfaceMode: discoveryConfig.surfaceMode,
          broadPollingEnabled: discoveryConfig.broadPollingEnabled,
        });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    })();
  });

  // -----------------------------------------------------------------------
  // GET /signals — recent signals with optional filters
  // -----------------------------------------------------------------------
  router.get('/signals', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const severity = req.query.severity as string | undefined;
      const signalType = req.query.signalType as string | undefined;
      const signals = getRecentSignals(limit, offset, { severity, signalType });
      res.json({ success: true, signals });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /signals/markets — unusual markets with insider/coordinated signals
  // -----------------------------------------------------------------------
  router.get('/signals/markets', (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const markets = getUnusualMarkets(days);
      res.json({ success: true, markets });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/summary', (req: Request, res: Response) => {
    try {
      const days = Math.min(parseInt(req.query.days as string) || 7, 14);
      const shadowMode = req.query.shadowMode === 'true';
      const discoveryConfig = manager.getConfig();
      const wallets = manager.getWallets('score', 1000, 0);
      const signals = getRecentSignals(500, 0);
      const surfacedWallets = filterDiscoveryWalletsForPresentation(
        wallets as any[],
        'all-real-world',
        false,
        discoveryConfig.surfaceMode,
      );
      const groupedFeed = buildDiscoveryOpportunityFeed(surfacedWallets as any[]);
      res.json({
        success: true,
        overview: buildDiscoveryOverview(wallets as any, signals as any, days),
        shadow: shadowMode ? buildDiscoveryShadowComparison(surfacedWallets as any[], groupedFeed) : undefined,
        surfaceMode: discoveryConfig.surfaceMode,
        broadPollingEnabled: discoveryConfig.broadPollingEnabled,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/feed', (req: Request, res: Response) => {
    try {
      const discoveryConfig = manager.getConfig();
      const focus = req.query.focus === 'high-information' ? 'high-information' : 'all-real-world';
      const verifiedOnly = req.query.verifiedOnly === 'true';
      const excludeSecondary = req.query.excludeSecondary !== 'false';
      const rawWallets = manager.getWallets('score', 200, 0);
      const filteredWallets = filterDiscoveryWalletsForPresentation(
        rawWallets as any[],
        focus,
        false,
        discoveryConfig.surfaceMode,
      )
        .filter((wallet) => !verifiedOnly || wallet.trustLevel === 'verified')
        .filter((wallet) => !excludeSecondary || (wallet.focusCategory !== 'sports' && wallet.focusCategory !== 'crypto'));

      res.json({
        success: true,
        feed: buildDiscoveryOpportunityFeed(filteredWallets as any[]),
        surfaceMode: discoveryConfig.surfaceMode,
        broadPollingEnabled: discoveryConfig.broadPollingEnabled,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /signals/:id/dismiss — dismiss a signal
  // -----------------------------------------------------------------------
  router.post('/signals/:id/dismiss', (req: Request, res: Response) => {
    try {
      dismissSignal(parseInt(req.params.id, 10));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /wallets/:address/positions — positions for a wallet
  // -----------------------------------------------------------------------
  router.get('/wallets/:address/positions', (req: Request, res: Response) => {
    void (async () => {
      try {
        const address = req.params.address.toLowerCase();
        try {
          const positions = await fetchAuthoritativePositions(address);
          res.json(buildWalletPositionsResponse(address, positions, true));
          return;
        } catch {
          /* fall back to derived positions below */
        }

        const positions = getPositionsByAddress(address);
        res.json(buildWalletPositionsResponse(address, positions, false));
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    })();
  });

  // -----------------------------------------------------------------------
  // GET /wallets/:address/signals — signals for a wallet
  // -----------------------------------------------------------------------
  router.get('/wallets/:address/signals', (req: Request, res: Response) => {
    try {
      const signals = getSignalsForAddress(req.params.address.toLowerCase());
      res.json({ success: true, signals });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /wallets/:address/verification — compare derived vs verified positions
  // -----------------------------------------------------------------------
  router.get('/wallets/:address/verification', (req: Request, res: Response) => {
    void (async () => {
      try {
        const address = req.params.address.toLowerCase();
        const derivedPositions = getPositionsByAddress(address);
        const verifiedPositions = await fetchAuthoritativePositions(address);
        res.json({
          success: true,
          summary: buildPositionVerificationSummary(derivedPositions, verifiedPositions),
          derivedPositions,
          verifiedPositions,
        });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    })();
  });

  // -----------------------------------------------------------------------
  // GET /config — current discovery config (Alchemy URL masked)
  // -----------------------------------------------------------------------
  router.get('/config', (req: Request, res: Response) => {
    try {
      const cfg = manager.getConfig();
      res.json({
        success: true,
        config: {
          ...cfg,
          alchemyWsUrl: maskAlchemyUrl(cfg.alchemyWsUrl),
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /config — update runtime config (persisted to SQLite)
  // -----------------------------------------------------------------------
  router.put('/config', async (req: Request, res: Response) => {
    try {
      const updates: Partial<DiscoveryConfig> = {};
      const body = req.body;

      if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled);
      if (body.alchemyWsUrl !== undefined) {
        updates.alchemyWsUrl = normalizeAlchemyWsUrl(String(body.alchemyWsUrl));
      }
      if (body.broadPollingEnabled !== undefined) updates.broadPollingEnabled = Boolean(body.broadPollingEnabled);
      if (body.surfaceMode !== undefined) {
        updates.surfaceMode = body.surfaceMode === 'verified' ? 'verified' : 'provisional';
      }
      if (body.pollIntervalMs !== undefined) updates.pollIntervalMs = parseInt(body.pollIntervalMs, 10);
      if (body.marketCount !== undefined) updates.marketCount = parseInt(body.marketCount, 10);
      if (body.statsIntervalMs !== undefined) updates.statsIntervalMs = parseInt(body.statsIntervalMs, 10);
      if (body.retentionDays !== undefined) updates.retentionDays = parseInt(body.retentionDays, 10);

      const newConfig = await manager.updateConfig(updates);
      res.json({
        success: true,
        config: {
          ...newConfig,
          alchemyWsUrl: maskAlchemyUrl(newConfig.alchemyWsUrl),
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /config/restart — restart the discovery engine
  // -----------------------------------------------------------------------
  router.post('/config/restart', async (req: Request, res: Response) => {
    try {
      await manager.restart();
      res.json({ success: true, message: 'Discovery engine restarted' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /status — health info
  // -----------------------------------------------------------------------
  router.get('/status', (req: Request, res: Response) => {
    try {
      const status = manager.getStatus();
      res.json({ success: true, ...status });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /purge — delete old discovery trades
  // -----------------------------------------------------------------------
  router.post('/purge', (req: Request, res: Response) => {
    try {
      if (req.body?.full === true) {
        const deleted = manager.resetData();
        res.json({ success: true, mode: 'full', deleted });
        return;
      }
      const days = parseInt(req.body.days) || 90;
      const deleted = manager.purgeData(days);
      res.json({ success: true, mode: 'days', deleted });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /wallets/:address/track — mark a discovered wallet as tracked
  // -----------------------------------------------------------------------
  router.post('/wallets/:address/track', (req: Request, res: Response) => {
    try {
      markWalletTracked(req.params.address, true);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
