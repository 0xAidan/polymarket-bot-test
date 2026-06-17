import { Router, Request, Response } from 'express';
import type { CopyTrader } from '../copyTrader.js';
import type { BalanceTracker } from '../balanceTracker.js';
import type { PolymarketApi } from '../polymarketApi.js';
import { createComponentLogger } from '../logger.js';
import {
  createAgent,
  deleteAgent,
  getAgentById,
  listEnabledAgents,
  loadAgentsFile,
  reorderAgents,
  updateAgent,
  bulkUpdateAddresses,
  bulkUpdateAgents,
  type JungleAgentRecord,
} from '../jungleAgentsStore.js';
import { reconcileAgentAddressesFromPolymarket, resolveCanonicalPolymarketAddress } from '../jungleAgentsPolymarketSync.js';
import { requirePlatformAdmin } from '../middleware/requirePlatformAdmin.js';

const log = createComponentLogger('JungleAgentsRoutes');

type PerfCacheEntry = { at: number; payload: Record<string, unknown> };
const perfCache = new Map<string, PerfCacheEntry>();
const PERF_TTL_MS = 90_000;

const normalizeSavedAddress = async (
  agent: JungleAgentRecord,
  address: string,
): Promise<string> => {
  const trimmed = address.trim();
  if (!trimmed) return '';
  const resolved = await resolveCanonicalPolymarketAddress(agent, trimmed);
  return resolved.address ?? trimmed;
};

const toPublicAgent = (a: JungleAgentRecord) => ({
  id: a.id,
  displayName: a.displayName,
  tagline: a.tagline ?? null,
  modelLabel: a.modelLabel ?? null,
  polymarketAddress: a.polymarketAddress,
  polymarketUsername: a.polymarketUsername ?? null,
  olympicsProfileUrl: a.olympicsProfileUrl,
  avatarUrl: a.avatarUrl ?? null,
  category: a.category ?? null,
  collection: a.collection ?? null,
  sortOrder: a.sortOrder,
  addressPending: !a.polymarketAddress
});

export function createJungleAgentsRouter(copyTrader: CopyTrader): Router {
  const router = Router();

  router.get('/jungle-agents', async (_req: Request, res: Response) => {
    try {
      const enabled = await listEnabledAgents();
      const missingAddressCount = enabled.filter((a) => !a.polymarketAddress).length;
      res.json({
        success: true,
        agents: enabled.map(toPublicAgent),
        meta: {
          totalEnabled: enabled.length,
          missingAddressCount
        }
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/jungle-agents/:id/performance', async (req: Request, res: Response) => {
    try {
      const agent = await getAgentById(req.params.id);
      if (!agent || !agent.enabled) {
        res.status(404).json({ success: false, error: 'Agent not found' });
        return;
      }
      if (!agent.polymarketAddress && !agent.polymarketUsername?.trim()) {
        res.status(400).json({ success: false, error: 'Agent has no Polymarket address yet' });
        return;
      }
      const cacheKey = agent.id;
      const now = Date.now();
      const cached = perfCache.get(cacheKey);
      if (cached && now - cached.at < PERF_TTL_MS) {
        res.json({ ...cached.payload, stale: true });
        return;
      }
      const api = copyTrader.getPolymarketApi();
      const balanceTracker = copyTrader.getBalanceTracker();
      const { resolveMonitoringAddress } = await import('../trackedWalletAddress.js');
      const lookupInput = agent.polymarketUsername?.trim()
        ? `@${agent.polymarketUsername.replace(/^@/, '')}`
        : agent.polymarketAddress;
      const resolved = await resolveMonitoringAddress(lookupInput);
      const monitoringAddress = resolved.monitoringAddress.toLowerCase();
      const portfolio = await api.getPortfolioValue(monitoringAddress, balanceTracker);
      const payload = {
        success: true,
        agentId: agent.id,
        address: monitoringAddress,
        portfolioValueUsd: portfolio.totalValue,
        usdcBalance: portfolio.usdcBalance,
        positionsValue: portfolio.positionsValue,
        positionCount: portfolio.positionCount,
        tradeCount30d: null as null,
        lastActiveAt: null as null,
        source: 'full_portfolio',
        stale: false,
      };
      perfCache.set(cacheKey, { at: now, payload });
      res.json(payload);
    } catch (error: any) {
      log.warn({ err: error.message }, '[JungleAgents] performance fetch failed');
      res.status(500).json({
        success: false,
        error: error.message,
        portfolioValueUsd: null,
        positionCount: null
      });
    }
  });

  router.get('/admin/jungle-agents', requirePlatformAdmin, async (_req: Request, res: Response) => {
    try {
      const agents = (await loadAgentsFile()).sort((a, b) => a.sortOrder - b.sortOrder);
      res.json({ success: true, agents });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/admin/jungle-agents', requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const created = await createAgent(req.body);
      res.json({ success: true, agent: created });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.patch('/admin/jungle-agents/:id', requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const existing = await getAgentById(req.params.id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Agent not found' });
        return;
      }
      const patch = { ...req.body } as Partial<JungleAgentRecord>;
      if (typeof patch.polymarketAddress === 'string' && patch.polymarketAddress.trim()) {
        patch.polymarketAddress = await normalizeSavedAddress(existing, patch.polymarketAddress);
      }
      const updated = await updateAgent(req.params.id, patch);
      res.json({ success: true, agent: updated });
    } catch (error: any) {
      const code = error.message === 'Agent not found' ? 404 : 400;
      res.status(code).json({ success: false, error: error.message });
    }
  });

  router.delete('/admin/jungle-agents/:id', requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      await deleteAgent(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      const code = error.message === 'Agent not found' ? 404 : 400;
      res.status(code).json({ success: false, error: error.message });
    }
  });

  router.post('/admin/jungle-agents/reorder', requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const orderedIds = req.body?.orderedIds;
      if (!Array.isArray(orderedIds) || !orderedIds.every((x: unknown) => typeof x === 'string')) {
        res.status(400).json({ success: false, error: 'orderedIds must be an array of strings' });
        return;
      }
      const agents = await reorderAgents(orderedIds as string[]);
      res.json({ success: true, agents });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/admin/jungle-agents/bulk-addresses', requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const updates = req.body?.updates;
      if (!Array.isArray(updates)) {
        res.status(400).json({ success: false, error: 'updates must be an array' });
        return;
      }
      const agents = await bulkUpdateAddresses(updates);
      res.json({ success: true, agents });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/admin/jungle-agents/bulk-save', requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const updates = req.body?.updates;
      if (!Array.isArray(updates)) {
        res.status(400).json({ success: false, error: 'updates must be an array' });
        return;
      }
      const normalizedUpdates = [];
      for (const row of updates) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string') {
          res.status(400).json({ success: false, error: 'Each update must include an id' });
          return;
        }
        const existing = await getAgentById(row.id);
        if (!existing) {
          res.status(400).json({ success: false, error: `Agent not found: ${row.id}` });
          return;
        }
        const next = { ...row } as Partial<JungleAgentRecord> & { id: string };
        if (typeof next.polymarketAddress === 'string' && next.polymarketAddress.trim()) {
          next.polymarketAddress = await normalizeSavedAddress(existing, next.polymarketAddress);
        }
        normalizedUpdates.push(next);
      }
      const agents = await bulkUpdateAgents(normalizedUpdates);
      res.json({ success: true, agents });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/admin/jungle-agents/sync-polymarket', requirePlatformAdmin, async (req: Request, res: Response) => {
    try {
      const force = req.body?.force === true;
      const onlyMissing = req.body?.onlyMissing === true;
      const result = await reconcileAgentAddressesFromPolymarket({ force, onlyMissing });
      const agents = (await loadAgentsFile()).sort((a, b) => a.sortOrder - b.sortOrder);
      res.json({ success: true, ...result, agents });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

export type JungleAgentsRoutesDeps = {
  getPolymarketApi: () => PolymarketApi;
  getBalanceTracker?: () => BalanceTracker;
};

/** Factory used by tests and lightweight mounts (no full CopyTrader). */
export function createJungleAgentsRoutes(deps: JungleAgentsRoutesDeps): Router {
  const stub = {
    getPolymarketApi: deps.getPolymarketApi,
    getBalanceTracker: deps.getBalanceTracker ?? (() => ({} as BalanceTracker))
  } as CopyTrader;
  return createJungleAgentsRouter(stub);
}
