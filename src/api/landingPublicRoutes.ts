import { Router, type Request, type Response } from 'express';
import { listEnabledAgents } from '../jungleAgentsStore.js';

const toLandingAgent = (agent: Awaited<ReturnType<typeof listEnabledAgents>>[number]) => ({
  displayName: agent.displayName,
  tagline: agent.tagline ?? null,
  category: agent.category ?? null,
  avatarUrl: agent.avatarUrl ?? null,
});

export function createLandingPublicRouter(): Router {
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

  return router;
}
