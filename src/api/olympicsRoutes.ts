import { Router, type Request, type Response } from 'express';
import { loadAgentsFile, inferAgentSlug } from '../jungleAgentsStore.js';

export interface OlympicsAgent {
  id: string;
  displayName: string;
  walletAddress: string;
}

const toOlympicsAgent = (agent: {
  id: string;
  slug?: string;
  displayName: string;
  polymarketAddress: string;
}): OlympicsAgent => ({
  id: agent.slug || inferAgentSlug(agent.displayName) || agent.id,
  displayName: agent.displayName,
  walletAddress: agent.polymarketAddress || '',
});

export function createOlympicsRoutes(): Router {
  const router = Router();

  router.get('/agents', async (_req: Request, res: Response) => {
    try {
      const agents = (await loadAgentsFile()).sort((a, b) => a.sortOrder - b.sortOrder);
      res.json({
        success: true,
        agents: agents.map(toOlympicsAgent),
        publicUrl: 'https://olympics.jungle.win/agents',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load Olympics agents';
      res.status(500).json({ success: false, error: message });
    }
  });

  /** Legacy write path removed — roster edits are platform-admin only at /admin. */
  router.put('/agents', (_req: Request, res: Response) => {
    res.status(403).json({
      success: false,
      error: 'Olympics roster edits are platform-admin only. Use /admin to manage Jungle Agents.',
    });
  });

  return router;
}
