import { Router } from 'express';
import { CopyTrader } from '../copyTrader.js';
import { createComponentLogger } from '../logger.js';
import {
  bulkUpdateAddresses,
  bulkUpdateAgents,
  createAgent,
  deleteAgent,
  getAgentById,
  listAgentCategories,
  listEnabledAgents,
  loadAgentsFile,
  reorderAgents,
  updateAgent
} from '../jungleAgentsStore.js';
import { syncMissingAgentAddressesFromPolymarket } from '../jungleAgentsPolymarketSync.js';
import { requirePlatformAdmin } from '../middleware/requirePlatformAdmin.js';

const log = createComponentLogger('JungleAgentsRoutes');

type PerfPayload = {
  success: true;
  agentId: string;
  address: string;
  portfolioValueUsd: number | null;
  positionCount: number | null;
  tradeCount30d: number | null;
  lastActiveAt: string | null;
  source: string;
  stale: boolean;
};

const perfCache = new Map<string, { at: number; payload: PerfPayload }>();
const PERF_TTL_MS = 90_000;

const toPublicAgent = (agent: any) => ({
  id: agent.id,
  displayName: agent.displayName,
  tagline: agent.tagline ?? null,
  modelLabel: agent.modelLabel ?? null,
  category: agent.category ?? 'Uncategorized',
  polymarketAddress: agent.polymarketAddress,
  olympicsProfileUrl: agent.olympicsProfileUrl,
  avatarUrl: agent.avatarUrl ?? null,
  sortOrder: agent.sortOrder,
  addressPending: !agent.polymarketAddress
});

export function createJungleAgentsRouter(copyTrader: CopyTrader): Router {
  const router = Router();

  router.get('/jungle-agents', async (_req, res) => {
    try {
      const enabled = await listEnabledAgents();
      const missingAddressCount = enabled.filter((agent) => !agent.polymarketAddress).length;
      const categories = await listAgentCategories();
      res.json({
        success: true,
        agents: enabled.map(toPublicAgent),
        meta: {
          totalEnabled: enabled.length,
          missingAddressCount,
          categories
        }
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/jungle-agents/:id/performance', async (req, res) => {
    try {
      const agent = await getAgentById(req.params.id);
      if (!agent || !agent.enabled) {
        res.status(404).json({ success: false, error: 'Agent not found' });
        return;
      }
      if (!agent.polymarketAddress) {
        res.status(400).json({ success: false, error: 'Agent has no Polymarket address yet' });
        return;
      }

      const address = agent.polymarketAddress.toLowerCase();
      const now = Date.now();
      const cached = perfCache.get(address);
      if (cached && now - cached.at < PERF_TTL_MS) {
        res.json({ ...cached.payload, stale: true });
        return;
      }

      const api = copyTrader.getPolymarketApi();
      const portfolio = await api.getPortfolioValue(address);
      const payload: PerfPayload = {
        success: true,
        agentId: agent.id,
        address,
        portfolioValueUsd: portfolio.totalValue,
        positionCount: portfolio.positionCount,
        tradeCount30d: null,
        lastActiveAt: null,
        source: 'portfolio-value',
        stale: false
      };
      perfCache.set(address, { at: now, payload });
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

  router.get('/admin/jungle-agents', requirePlatformAdmin, async (_req, res) => {
    try {
      const agents = (await loadAgentsFile()).sort((a, b) => a.sortOrder - b.sortOrder);
      const categories = await listAgentCategories();
      res.json({ success: true, agents, categories });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/admin/jungle-agents', requirePlatformAdmin, async (req, res) => {
    try {
      const created = await createAgent(req.body);
      res.json({ success: true, agent: created });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.patch('/admin/jungle-agents/:id', requirePlatformAdmin, async (req, res) => {
    try {
      const updated = await updateAgent(req.params.id, req.body);
      res.json({ success: true, agent: updated });
    } catch (error: any) {
      const status = error.message === 'Agent not found' ? 404 : 400;
      res.status(status).json({ success: false, error: error.message });
    }
  });

  router.delete('/admin/jungle-agents/:id', requirePlatformAdmin, async (req, res) => {
    try {
      await deleteAgent(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      const status = error.message === 'Agent not found' ? 404 : 400;
      res.status(status).json({ success: false, error: error.message });
    }
  });

  router.post('/admin/jungle-agents/reorder', requirePlatformAdmin, async (req, res) => {
    try {
      const orderedIds = req.body?.orderedIds;
      if (!Array.isArray(orderedIds) || !orderedIds.every((value) => typeof value === 'string')) {
        res.status(400).json({ success: false, error: 'orderedIds must be an array of strings' });
        return;
      }
      const agents = await reorderAgents(orderedIds);
      res.json({ success: true, agents });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/admin/jungle-agents/bulk-addresses', requirePlatformAdmin, async (req, res) => {
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

  router.post('/admin/jungle-agents/bulk-save', requirePlatformAdmin, async (req, res) => {
    try {
      const updates = req.body?.updates;
      if (!Array.isArray(updates)) {
        res.status(400).json({ success: false, error: 'updates must be an array' });
        return;
      }
      const agents = await bulkUpdateAgents(updates);
      res.json({ success: true, agents });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/admin/jungle-agents/sync-polymarket', requirePlatformAdmin, async (_req, res) => {
    try {
      const result = await syncMissingAgentAddressesFromPolymarket();
      const agents = (await loadAgentsFile()).sort((a, b) => a.sortOrder - b.sortOrder);
      res.json({ success: true, ...result, agents });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}
