/**
 * Discovery v3 API router — 9 endpoints per parent plan §7.
 *
 * All routes are flag-gated. When `DISCOVERY_V3=false` the router returns
 * 404 for every path so the UI can't accidentally render.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { isDiscoveryV3Enabled } from '../discovery/v3/featureFlag.js';
import { TierName } from '../discovery/v3/types.js';

const VALID_TIERS: ReadonlySet<TierName> = new Set(['alpha', 'whale', 'specialist']);

interface ScoreRow {
  proxy_wallet: string;
  tier: string;
  tier_rank: number;
  score: number;
  volume_total: number;
  trade_count: number;
  distinct_markets: number;
  closed_positions: number;
  realized_pnl: number;
  hit_rate: number | null;
  last_active_ts: number;
  reasons_json: string;
  updated_at: number;
}

function dto(row: ScoreRow) {
  const reasons = safeJson(row.reasons_json, [] as string[]);
  return {
    address: row.proxy_wallet,
    alias: aliasFor(row.proxy_wallet),
    tier: row.tier,
    tierRank: row.tier_rank,
    score: row.score,
    volumeTotal: row.volume_total,
    tradeCount: row.trade_count,
    distinctMarkets: row.distinct_markets,
    closedPositions: row.closed_positions,
    realizedPnl: row.realized_pnl,
    hitRate: row.hit_rate,
    lastActiveTs: row.last_active_ts,
    reasons,
    updatedAt: row.updated_at,
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function aliasFor(address: string): string {
  const adjectives = ['Silver', 'Amber', 'Violet', 'Cobalt', 'Crimson', 'Jade', 'Sable', 'Copper'];
  const animals = ['Otter', 'Falcon', 'Moth', 'Hare', 'Vulture', 'Lynx', 'Stoat', 'Marlin'];
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  return `${adjectives[h % adjectives.length]} ${animals[(h >> 3) % animals.length]}`;
}

export interface V3RouterDeps {
  getDb: () => Database.Database;
}

export function createDiscoveryV3Router(deps: V3RouterDeps): Router {
  const router = Router();

  const flagGate = (_req: Request, res: Response, next: NextFunction): void => {
    if (!isDiscoveryV3Enabled()) {
      res.status(404).json({ success: false, error: 'discovery v3 disabled' });
      return;
    }
    next();
  };
  router.use(flagGate);

  // 1. GET /tier/:tier
  router.get('/tier/:tier', (req: Request, res: Response) => {
    const tier = req.params.tier as TierName;
    if (!VALID_TIERS.has(tier)) {
      res.status(400).json({ success: false, error: `invalid tier: ${tier}` });
      return;
    }
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const rows = deps.getDb()
      .prepare('SELECT * FROM discovery_wallet_scores_v3 WHERE tier = ? ORDER BY tier_rank ASC LIMIT ? OFFSET ?')
      .all(tier, limit, offset) as ScoreRow[];
    res.json({ success: true, tier, count: rows.length, data: rows.map(dto) });
  });

  // 2. GET /wallet/:address
  router.get('/wallet/:address', (req: Request, res: Response) => {
    const addr = req.params.address.toLowerCase();
    const rows = deps.getDb()
      .prepare('SELECT * FROM discovery_wallet_scores_v3 WHERE LOWER(proxy_wallet) = ?')
      .all(addr) as ScoreRow[];
    if (rows.length === 0) {
      res.status(404).json({ success: false, error: 'wallet not found in v3 scores' });
      return;
    }
    res.json({ success: true, address: addr, tiers: rows.map(dto) });
  });

  // 3. GET /compare?addresses=a,b,c,d
  router.get('/compare', (req: Request, res: Response) => {
    const raw = String(req.query.addresses ?? '');
    const addrs = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 4);
    if (addrs.length === 0) {
      res.status(400).json({ success: false, error: 'addresses query parameter required' });
      return;
    }
    const placeholders = addrs.map(() => '?').join(',');
    const rows = deps.getDb()
      .prepare(`SELECT * FROM discovery_wallet_scores_v3 WHERE LOWER(proxy_wallet) IN (${placeholders})`)
      .all(...addrs) as ScoreRow[];
    res.json({ success: true, addresses: addrs, data: rows.map(dto) });
  });

  // 4. GET /health
  router.get('/health', (_req: Request, res: Response) => {
    try {
      const counts = deps.getDb().prepare(
        `SELECT tier, COUNT(*) AS count FROM discovery_wallet_scores_v3 GROUP BY tier`
      ).all() as { tier: string; count: number }[];
      const cursor = deps.getDb().prepare(
        'SELECT pipeline, last_block, last_ts_unix, updated_at FROM pipeline_cursor'
      ).all() as Array<{ pipeline: string; last_block: number; last_ts_unix: number; updated_at: number }>;
      res.json({
        success: true,
        flag: isDiscoveryV3Enabled(),
        tierCounts: Object.fromEntries(counts.map((c) => [c.tier, c.count])),
        cursors: cursor,
      });
    } catch (err) {
      res.json({ success: true, flag: isDiscoveryV3Enabled(), tierCounts: {}, cursors: [], warning: (err as Error).message });
    }
  });

  // 5. POST /watchlist
  router.post('/watchlist', (req: Request, res: Response) => {
    const address = String(req.body?.address ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      res.status(400).json({ success: false, error: 'address must be 0x + 40 hex chars' });
      return;
    }
    res.json({ success: true, address, action: 'watch' });
  });

  // 6. DELETE /watchlist/:addr
  router.delete('/watchlist/:addr', (req: Request, res: Response) => {
    res.json({ success: true, address: req.params.addr.toLowerCase(), action: 'unwatch' });
  });

  // 7. POST /dismiss
  router.post('/dismiss', (req: Request, res: Response) => {
    const address = String(req.body?.address ?? '').toLowerCase();
    res.json({ success: true, address, action: 'dismiss', until: req.body?.until ?? null });
  });

  // 8. POST /track
  router.post('/track', (req: Request, res: Response) => {
    const address = String(req.body?.address ?? '').toLowerCase();
    res.json({ success: true, address, action: 'track' });
  });

  // 9. GET /cutover-status — detailed cutover readiness (cf. Phase 4)
  router.get('/cutover-status', (_req: Request, res: Response) => {
    const db = deps.getDb();
    const tierCounts = db.prepare(
      `SELECT tier, COUNT(*) AS count FROM discovery_wallet_scores_v3 GROUP BY tier`
    ).all() as { tier: string; count: number }[];
    const cursors = db.prepare(
      'SELECT pipeline, last_block, last_ts_unix, updated_at FROM pipeline_cursor'
    ).all() as Array<{ pipeline: string; last_block: number; last_ts_unix: number; updated_at: number }>;
    const totalRow = db.prepare('SELECT COUNT(*) AS c FROM discovery_wallet_scores_v3').get() as { c: number };
    res.json({
      success: true,
      flag: isDiscoveryV3Enabled(),
      totalScoreRows: totalRow.c,
      tierCounts: Object.fromEntries(tierCounts.map((c) => [c.tier, c.count])),
      cursors,
    });
  });

  return router;
}
