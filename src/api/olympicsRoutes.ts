import { Router, type Request, type Response } from 'express';
import { Storage } from '../storage.js';

export interface OlympicsAgent {
  id: string;
  displayName: string;
  walletAddress: string;
}

export const DEFAULT_OLYMPICS_AGENTS: OlympicsAgent[] = [
  { id: 'howler-monkey-herald', displayName: 'Howler Monkey Herald', walletAddress: '' },
  { id: 'silverback-sage', displayName: 'Silverback Sage', walletAddress: '' },
  { id: 'sabermetrician', displayName: 'Sabermetrician', walletAddress: '' },
  { id: 'veteran-backstop', displayName: 'Veteran Backstop', walletAddress: '' },
  { id: 'claude-slugger', displayName: 'Claude Slugger', walletAddress: '' },
  { id: 'deepseek-knuckler', displayName: 'DeepSeek Knuckler', walletAddress: '' },
  { id: 'gemini-laser', displayName: 'Gemini Laser', walletAddress: '' },
  { id: 'mistral-closer', displayName: 'Mistral Closer', walletAddress: '' },
  { id: 'king', displayName: 'KING', walletAddress: '' },
];

const normalizeAgents = (raw: unknown): OlympicsAgent[] => {
  if (!Array.isArray(raw)) return DEFAULT_OLYMPICS_AGENTS.map((a) => ({ ...a }));
  const byId = new Map(DEFAULT_OLYMPICS_AGENTS.map((a) => [a.id, { ...a }]));
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const id = String((row as OlympicsAgent).id || '').trim();
    if (!byId.has(id)) continue;
    const base = byId.get(id)!;
    base.displayName = String((row as OlympicsAgent).displayName || base.displayName).trim() || base.displayName;
    const wallet = String((row as OlympicsAgent).walletAddress || '').trim();
    base.walletAddress = /^0x[a-fA-F0-9]{40}$/.test(wallet) ? wallet.toLowerCase() : '';
  }
  return DEFAULT_OLYMPICS_AGENTS.map((a) => byId.get(a.id)!);
};

export const loadOlympicsAgents = async (): Promise<OlympicsAgent[]> => {
  const cfg = await Storage.loadConfig();
  return normalizeAgents(cfg.olympicsAgents);
};

export const saveOlympicsAgents = async (agents: OlympicsAgent[]): Promise<OlympicsAgent[]> => {
  const cfg = await Storage.loadConfig();
  const normalized = normalizeAgents(agents);
  cfg.olympicsAgents = normalized;
  await Storage.saveConfig(cfg);
  return normalized;
};

export function createOlympicsRoutes(): Router {
  const router = Router();

  router.get('/agents', async (_req: Request, res: Response) => {
    try {
      const agents = await loadOlympicsAgents();
      res.json({ success: true, agents, publicUrl: 'https://olympics.jungle.win/agents' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load Olympics agents';
      res.status(500).json({ success: false, error: message });
    }
  });

  router.put('/agents', async (req: Request, res: Response) => {
    try {
      const agents = await saveOlympicsAgents(req.body?.agents);
      res.json({ success: true, agents });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to save Olympics agents';
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
