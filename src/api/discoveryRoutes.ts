/**
 * Discovery API Routes
 *
 * REST endpoints for the discovery engine. Provides wallet listings,
 * runtime config management, engine restart, status, and data purge.
 */

import { Router, Request, Response } from 'express';
import { DiscoveryManager } from '../discovery/discoveryManager.js';
import { DiscoveryConfig } from '../discovery/types.js';
import { markWalletTracked } from '../discovery/statsStore.js';

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

export const createDiscoveryRoutes = (manager: DiscoveryManager): Router => {
  const router = Router();

  // -----------------------------------------------------------------------
  // GET /wallets — ranked list of discovered wallets
  // -----------------------------------------------------------------------
  router.get('/wallets', (req: Request, res: Response) => {
    try {
      const sort = (req.query.sort as 'volume' | 'trades' | 'recent') || 'volume';
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const wallets = manager.getWallets(sort, limit, offset);
      res.json({ success: true, wallets });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
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
      if (body.alchemyWsUrl !== undefined) updates.alchemyWsUrl = String(body.alchemyWsUrl);
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
      const days = parseInt(req.body.days) || 90;
      const deleted = manager.purgeData(days);
      res.json({ success: true, deleted });
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
