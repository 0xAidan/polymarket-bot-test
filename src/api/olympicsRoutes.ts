import { Router } from 'express';
import { inferAgentSlug, loadAgentsFile } from '../jungleAgentsStore.js';

const toOlympicsAgent = (agent: any) => ({
  id: agent.slug || inferAgentSlug(agent.displayName) || agent.id,
  displayName: agent.displayName,
  walletAddress: agent.polymarketAddress || ''
});

export function createOlympicsRoutes(): Router {
  const router = Router();

  router.get('/agents', async (_req, res) => {
    try {
      const agents = (await loadAgentsFile()).sort((a, b) => a.sortOrder - b.sortOrder);
      res.json({
        success: true,
        agents: agents.map(toOlympicsAgent),
        publicUrl: 'https://olympics.jungle.win/agents'
      });
    } catch (error: any) {
      const message = error instanceof Error ? error.message : 'Failed to load Olympics agents';
      res.status(500).json({ success: false, error: message });
    }
  });

  // Legacy write path intentionally blocked. Admin edits must happen in /admin.
  router.put('/agents', (_req, res) => {
    res.status(403).json({
      success: false,
      error: 'Olympics roster edits are platform-admin only. Use /admin to manage Jungle Agents.'
    });
  });

  return router;
}
