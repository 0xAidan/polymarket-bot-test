/**
 * Discovery API Routes
 *
 * REST endpoints for the discovery engine. Provides wallet listings,
 * runtime config management, engine restart, status, and data purge.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { initDatabase } from '../database.js';
import { Storage } from '../storage.js';
import { DiscoveryConfig, DiscoveryMarketCategory } from '../discovery/types.js';
import {
  fetchAuthoritativePositions,
  summarizeAuthoritativePositions,
  buildPositionVerificationSummary,
  filterLiveWalletPositions,
  mapOfficialPositionToWalletPosition,
} from '../discovery/positionTracker.js';
import {
  markWalletTracked,
  dismissSignal,
  getPositionsByAddress,
} from '../discovery/statsStore.js';
import { computeDiscoveryWalletScore } from '../discovery/walletScorer.js';
import { classifyDiscoveryMarket } from '../discovery/marketClassifier.js';
import { getRecentWalletReasons, getWalletReasons } from '../discovery/discoveryScorer.js';
import { getWalletValidation } from '../discovery/walletValidator.js';
import { getValidEvmAddress } from '../addressUtils.js';

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

type WalletPositionsSource = 'verified' | 'cached' | 'derived';

const normalizeWalletPositionsSource = (source: WalletPositionsSource | boolean): WalletPositionsSource => {
  if (typeof source === 'boolean') {
    return source ? 'verified' : 'derived';
  }
  return source;
};

const normalizeWalletDetailProfile = (
  address: string,
  rawProfile?: Record<string, unknown>
): { profileAddress?: string; profileUrl?: string } => {
  const profileAddress = getValidEvmAddress(
    rawProfile?.address ??
    rawProfile?.walletAddress ??
    rawProfile?.publicAddress ??
    rawProfile?.proxyWallet
  );

  if (!profileAddress || profileAddress !== address.toLowerCase()) {
    return {};
  }

  return {
    profileAddress,
    profileUrl: `https://polymarket.com/profile/${profileAddress}`,
  };
};

export const buildWalletPositionsResponse = (
  address: string,
  positions: any[],
  sourceInput: WalletPositionsSource | boolean,
  metadata: { profileAddress?: string; profileUrl?: string } = {},
) => {
  const source = normalizeWalletPositionsSource(sourceInput);
  const normalizedPositions = positions.map((position) => {
    if (source === 'cached') {
      return {
        ...position,
        dataSource: 'cached' as const,
      };
    }

    if (source === 'verified') {
      return {
        ...position,
        dataSource: 'verified' as const,
      };
    }

    return {
      ...position,
      dataSource: position.dataSource ?? 'derived',
    };
  });

  const visiblePositions = source === 'derived'
    ? normalizedPositions
    : filterLiveWalletPositions(normalizedPositions);

  return {
    success: true,
    address,
    positions: visiblePositions,
    source,
    ...metadata,
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
}>(
  wallet: T,
): boolean => {
  if ((wallet.lastSignalAt || 0) > 0) return true;
  if (Number(wallet.whaleScore || 0) >= 20) return true;
  if (Number(wallet.volume7d || 0) >= 2500) return true;
  return Number(wallet.tradeCount7d || 0) >= 4 && Number(wallet.volume7d || 0) >= 750;
};

export const matchesDiscoveryFocusFilter = <T extends {
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
}>(
  wallet: T,
  focus: 'all-real-world' | 'high-information',
): boolean => {
  if (focus !== 'high-information') return true;
  const volume7d = Number(wallet.volume7d || 0);
  const highInformationVolume7d = Number(wallet.highInformationVolume7d || 0);
  if (volume7d <= 0) return false;
  if (['politics', 'macro', 'company', 'legal', 'geopolitics'].includes(wallet.focusCategory || '')) return true;
  return highInformationVolume7d / volume7d >= 0.6;
};

const annotateDiscoveryWallet = <T extends {
  whySurfaced?: string;
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  lastSignalType?: string;
}>(
  wallet: T,
): T & { whySurfaced: string } => ({
  ...wallet,
  whySurfaced: wallet.whySurfaced || buildDiscoveryWalletExplanation(wallet),
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
}>(
  wallets: T[],
  focus: 'all-real-world' | 'high-information',
  includeAll: boolean,
): Array<T & { whySurfaced: string }> => {
  return wallets
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
  },
): Array<T & { whySurfaced: string }> => {
  return filterDiscoveryWalletsForPresentation(wallets, options.focus, options.includeAll)
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
  const normalizeTimestamp = (value?: number): number => {
    const timestamp = Number(value || 0);
    if (!timestamp) return 0;
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  };
  const surfacedWallets = wallets.filter(shouldIncludeDiscoveryWallet);
  const surfacedCutoff = Date.now() - 24 * 3600 * 1000;
  const signalCutoff = Date.now() - days * 86400 * 1000;
  const highInformationCategories = new Set(['politics', 'macro', 'company', 'legal', 'geopolitics']);
  const surfacedToday = surfacedWallets.filter((wallet) => normalizeTimestamp(wallet.lastActive) >= surfacedCutoff);
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
    const bucket = new Date(normalizeTimestamp(wallet.lastActive)).toISOString().slice(0, 10);
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

/** Ensure DB is initialized before any discovery route (e.g. when user saves config before copy trader has started). */
const ensureDatabase = async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    await initDatabase();
    next();
  } catch (err: any) {
    next(err);
  }
};

type DiscoveryRoutesController = {
  getConfig(): DiscoveryConfig;
  updateConfig(updates: Partial<DiscoveryConfig>): Promise<DiscoveryConfig>;
  getStatus(): {
    enabled: boolean;
    chainListener: { connected: boolean; lastEventAt?: number; reconnectCount: number };
    apiPoller: { running: boolean; lastPollAt?: number; marketsMonitored: number };
    stats: { totalWallets: number; totalTrades: number; uptimeMs: number };
  };
  getWallets(
    sort: 'volume' | 'trades' | 'recent' | 'score' | 'roi',
    limit: number,
    offset: number,
    filters?: { minScore?: number; heat?: string; hasSignals?: boolean }
  ): unknown[];
  purgeData(olderThanDays: number): number;
  resetData(): {
    trades: number;
    wallets: number;
    positions: number;
    signals: number;
    marketCache: number;
    total: number;
  };
  restart(): Promise<void>;
};

export const createDiscoveryRoutes = (manager: DiscoveryRoutesController): Router => {
  const router = Router();

  router.use(ensureDatabase);

  // -----------------------------------------------------------------------
  // GET /wallets — ranked list of discovered wallets (with filters)
  // -----------------------------------------------------------------------
  router.get('/wallets', (req: Request, res: Response) => {
    void (async () => {
      try {
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
            filterDiscoveryWalletsForPresentation(batch as any[], focus, includeAll)
          );
          rawOffset += batch.length;
          if (batch.length < rawBatchSize) break;
        }

        const wallets = filteredWallets.slice(offset, offset + limit);
        if (!hydratePositions || wallets.length === 0) {
          const derivedWallets = wallets.map((wallet) => ({
            ...wallet,
            positionDataSource: 'derived' as const,
          }));
          res.json({
            success: true,
            wallets: derivedWallets,
            positionsSource: 'derived',
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
          wallets: hydratedWallets.map(annotateDiscoveryWallet),
          positionsSource: 'verified',
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
      const reasonSignals = getRecentWalletReasons(limit * 3, offset).map((reason, index) => ({
        id: offset + index + 1,
        signalType: reason.reasonCode,
        severity: reason.reasonType === 'rejection' ? 'high' : reason.reasonType === 'warning' ? 'medium' : 'low',
        address: reason.address,
        title: reason.reasonCode,
        description: reason.message,
        detectedAt: reason.createdAt,
        canDismiss: false,
      }));
      const signals = severity
        ? reasonSignals.filter((signal) => signal.severity === severity).slice(0, limit)
        : reasonSignals.slice(0, limit);
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
      const cutoff = Date.now() - days * 86400 * 1000;
      const marketCounts = new Map<string, { marketTitle: string; signal_count: number; wallets: Set<string> }>();
      const normalizeTimestamp = (value?: number): number => {
        const timestamp = Number(value || 0);
        return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
      };
      for (const wallet of manager.getWallets('score', 200, 0) as any[]) {
        if (!Array.isArray(wallet.supportingMarkets)) continue;
        if (normalizeTimestamp(wallet.updatedAt) < cutoff) continue;
        for (const marketTitle of wallet.supportingMarkets) {
          const entry = marketCounts.get(marketTitle) ?? { marketTitle, signal_count: 0, wallets: new Set<string>() };
          entry.signal_count += 1;
          entry.wallets.add(wallet.address);
          marketCounts.set(marketTitle, entry);
        }
      }
      const markets = [...marketCounts.values()]
        .sort((a, b) => b.signal_count - a.signal_count)
        .map((entry) => ({
          market_title: entry.marketTitle,
          signal_count: entry.signal_count,
          wallets: [...entry.wallets].join(','),
        }));
      res.json({ success: true, markets });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/summary', (req: Request, res: Response) => {
    try {
      const days = Math.min(parseInt(req.query.days as string) || 7, 14);
      const wallets = manager.getWallets('score', 1000, 0) as any[];
      const signals: any[] = wallets.flatMap((wallet) =>
        (wallet.warningReasons || []).map((reason: string, index: number) => ({
          address: wallet.address,
          severity: 'high',
          marketTitle: wallet.supportingMarkets?.[index] || wallet.supportingMarkets?.[0],
          detectedAt: wallet.updatedAt,
          signalType: 'DISCOVERY_REASON',
          description: reason,
        }))
      );
      res.json({
        success: true,
        overview: buildDiscoveryOverview(wallets as any, signals as any, days),
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
        const validation = getWalletValidation(address);
        const profileMetadata = normalizeWalletDetailProfile(address, validation?.rawProfile);
        try {
          const positions = await fetchAuthoritativePositions(address);
          res.json(buildWalletPositionsResponse(address, positions, 'verified', profileMetadata));
          return;
        } catch {
          /* fall back to derived positions below */
        }

        if (validation?.rawPositions?.length) {
          const cachedPositions = validation.rawPositions.map((position) =>
            mapOfficialPositionToWalletPosition(position as any, 'cached')
          );
          res.json(buildWalletPositionsResponse(address, cachedPositions, 'cached', profileMetadata));
          return;
        }

        const positions = getPositionsByAddress(address);
        res.json(buildWalletPositionsResponse(address, positions, 'derived', profileMetadata));
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
      const signals = getWalletReasons(req.params.address.toLowerCase()).map((reason, index) => ({
        id: index + 1,
        signalType: reason.reasonCode,
        severity: reason.reasonType === 'rejection' ? 'high' : reason.reasonType === 'warning' ? 'medium' : 'low',
        address: reason.address,
        title: reason.reasonCode,
        description: reason.message,
        detectedAt: reason.createdAt,
      }));
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
      await manager.restart().catch(() => {});
      res.status(202).json({
        success: true,
        message: 'Discovery worker settings saved. Restart the dedicated discovery worker process to apply them.',
      });
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
    void (async () => {
      try {
        const address = req.params.address.toLowerCase();
        try {
          await Storage.addWallet(address);
        } catch {
          /* already tracked */
        }
        await Storage.toggleWalletActive(address, true);
        markWalletTracked(address, true);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    })();
  });

  return router;
};
