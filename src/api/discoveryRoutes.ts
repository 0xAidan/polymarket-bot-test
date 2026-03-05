/**
 * Discovery API Routes
 *
 * REST endpoints for the discovery engine. Provides wallet listings,
 * runtime config management, engine restart, status, and data purge.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { initDatabase } from '../database.js';
import { DiscoveryManager } from '../discovery/discoveryManager.js';
import { DiscoveryConfig } from '../discovery/types.js';
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

/** Ensure DB is initialized before any discovery route (e.g. when user saves config before copy trader has started). */
const ensureDatabase = async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    await initDatabase();
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
        const sort = (req.query.sort as 'volume' | 'trades' | 'recent' | 'score' | 'roi') || 'volume';
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const hydratePositions = req.query.hydratePositions === 'true';
        const filters: { minScore?: number; heat?: string; hasSignals?: boolean } = {};
        if (req.query.minScore !== undefined) filters.minScore = parseFloat(req.query.minScore as string);
        if (req.query.heat) filters.heat = req.query.heat as string;
        if (req.query.hasSignals === 'true') filters.hasSignals = true;

        const wallets = manager.getWallets(sort, limit, offset, filters);
        if (!hydratePositions || wallets.length === 0) {
          res.json({ success: true, wallets });
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

        res.json({ success: true, wallets: hydratedWallets });
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
