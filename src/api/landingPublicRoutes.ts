import { Router, type Request, type Response } from 'express';
import type { CopyTrader } from '../copyTrader.js';
import { createComponentLogger } from '../logger.js';
import { fetchJungleAgentPolymarketStats } from '../jungleAgentPolymarketStats.js';
import { getAgentById, listEnabledAgents } from '../jungleAgentsStore.js';

const log = createComponentLogger('LandingPublicRoutes');

type PerfCacheEntry = { at: number; payload: Record<string, unknown> };
const perfCache = new Map<string, PerfCacheEntry>();
const PERF_TTL_MS = 90_000;

const toLandingAgent = (agent: Awaited<ReturnType<typeof listEnabledAgents>>[number]) => ({
  id: agent.id,
  displayName: agent.displayName,
  tagline: agent.tagline ?? null,
  modelLabel: agent.modelLabel ?? null,
  category: agent.category ?? null,
  avatarUrl: agent.avatarUrl ?? null,
  polymarketAddress: agent.polymarketAddress,
  addressPending: !agent.polymarketAddress,
});

export function createLandingPublicRouter(copyTrader: CopyTrader): Router {
  const router = Router();

  router.get('/public/landing-preview', async (_req: Request, res: Response) => {
    try {
      const enabled = await listEnabledAgents();
      const agents = enabled.slice(0, 12).map(toLandingAgent);
      const missingAddressCount = enabled.filter((agent) => !agent.polymarketAddress).length;

      res.json({
        success: true,
        agents,
        meta: {
          totalEnabled: enabled.length,
          missingAddressCount,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load landing preview';
      res.status(500).json({ success: false, error: message });
    }
  });

  router.get('/public/jungle-agents/:id/performance', async (req: Request, res: Response) => {
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

      const { resolveMonitoringAddress } = await import('../trackedWalletAddress.js');
      const lookupInput = agent.polymarketUsername?.trim()
        ? `@${agent.polymarketUsername.replace(/^@/, '')}`
        : agent.polymarketAddress;
      const resolved = await resolveMonitoringAddress(lookupInput);
      const monitoringAddress = resolved.monitoringAddress.toLowerCase();
      const balanceTracker = copyTrader.getBalanceTracker();
      const stats = await fetchJungleAgentPolymarketStats(monitoringAddress, fetch, {
        getCashBalance: (addr) => balanceTracker.getBalance(addr),
      });
      if (!stats) {
        res.status(502).json({ success: false, error: 'Could not load Polymarket stats for this wallet' });
        return;
      }

      const payload = {
        success: true,
        agentId: agent.id,
        address: monitoringAddress,
        portfolioValueUsd: stats.portfolioValueUsd,
        usdcBalance: stats.usdcBalanceUsd,
        positionsValue: stats.positionsValueUsd,
        positionCount: stats.positionCount,
        lifetimePnlUsd: stats.lifetimePnlUsd,
        roiPct: stats.roiPct,
        winRatePct: stats.winRatePct,
        wins: stats.wins,
        losses: stats.losses,
        breakeven: stats.breakeven,
        closedPositionsCount: stats.closedPositionsCount,
        totalDeployedUsd: stats.totalDeployedUsd,
        tradeCount30d: null as null,
        lastActiveAt: null as null,
        source: stats.source,
        stale: false,
      };
      perfCache.set(cacheKey, { at: now, payload });
      res.json(payload);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Performance fetch failed';
      log.warn({ err: message }, '[LandingPublic] performance fetch failed');
      res.status(500).json({
        success: false,
        error: message,
        portfolioValueUsd: null,
        positionCount: null,
      });
    }
  });

  return router;
}
