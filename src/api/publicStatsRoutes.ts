import { Router, type Request, type Response } from 'express';
import { listEnabledAgents } from '../jungleAgentsStore.js';
import { isDiscoveryV3Enabled } from '../discovery/v3/featureFlag.js';
import type Database from 'better-sqlite3';

type PublicStatsDeps = {
  getDb: () => Database.Database;
};

/**
 * Read-only aggregate stats for external homepages (e.g. ancc.blog).
 * Mounted before the global /api auth gate — no secrets or wallet lists.
 */
export const createPublicStatsRouter = (deps: PublicStatsDeps): Router => {
  const router = Router();

  router.get('/public/stats', async (_req: Request, res: Response) => {
    try {
      const enabled = await listEnabledAgents();
      let walletsScored: number | null = null;
      let tierAlpha: number | null = null;
      let tierWhale: number | null = null;
      let tierSpecialist: number | null = null;
      let lastUpdated: string | null = null;

      if (isDiscoveryV3Enabled()) {
        try {
          const db = deps.getDb();
          const totalRow = db.prepare('SELECT COUNT(*) AS c FROM discovery_wallet_scores_v3').get() as {
            c: number;
          };
          walletsScored = totalRow.c;
          const tierCounts = db
            .prepare(`SELECT tier, COUNT(*) AS count FROM discovery_wallet_scores_v3 GROUP BY tier`)
            .all() as Array<{ tier: string; count: number }>;
          const tierMap = Object.fromEntries(tierCounts.map((row) => [row.tier, row.count]));
          tierAlpha = tierMap.alpha ?? null;
          tierWhale = tierMap.whale ?? null;
          tierSpecialist = tierMap.specialist ?? null;
          const cursor = db
            .prepare('SELECT updated_at FROM pipeline_cursor ORDER BY updated_at DESC LIMIT 1')
            .get() as { updated_at: number } | undefined;
          if (cursor?.updated_at) {
            const ts = cursor.updated_at;
            lastUpdated = new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
          }
        } catch {
          /* v3 tables may be absent during cutover */
        }
      }

      res.json({
        success: true,
        agents: enabled.length,
        walletsScored,
        tierCounts: {
          alpha: tierAlpha,
          whale: tierWhale,
          specialist: tierSpecialist,
        },
        lastUpdated,
        discoveryV3: isDiscoveryV3Enabled(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load public stats';
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
};
