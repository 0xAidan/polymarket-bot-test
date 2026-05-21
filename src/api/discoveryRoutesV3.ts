/**
 * Discovery v3 API router — 9 endpoints per parent plan §7.
 *
 * All routes are flag-gated. When `DISCOVERY_V3=false` the router returns
 * 404 for every path so the UI can't accidentally render.
 *
 * Display stats come from the pipeline SQLite read model (harvest → snapshots →
 * publish). At publish time, `realized_pnl` is overwritten with Polymarket
 * position PnL (closed realizedPnl + open cashPnl) when the API responds.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { isDiscoveryV3Enabled } from '../discovery/v3/featureFlag.js';
import { getDiscoveryCoverageContract } from '../discovery/v3/coverageContract.js';
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
  composite_score: number | null;
  momentum_score: number | null;
  consistency_score: number | null;
  ditto_state: string | null;
  predictions_count: number | null;
  profile_name: string | null;
  brier_score: number | null;
  avg_clv_1h: number | null;
  pct_positive_clv_1h: number | null;
  top_category: string | null;
  cat_volume_share: number | null;
  maker_ratio: number | null;
  copyable: number | null;
}

function buildProfileUrl(address: string): string {
  return `https://polymarket.com/@${address.trim().toLowerCase()}`;
}

function dto(row: ScoreRow) {
  const reasons = safeJson(row.reasons_json, [] as string[]);
  const fillCount = Number(row.trade_count);
  const predictionsCount =
    row.predictions_count != null ? Number(row.predictions_count) : null;
  return {
    address: row.proxy_wallet,
    alias: aliasFor(row.proxy_wallet),
    profileName: row.profile_name ?? null,
    profileUrl: buildProfileUrl(row.proxy_wallet),
    tier: row.tier,
    tierRank: row.tier_rank,
    score: row.score,
    volumeTotal: row.volume_total,
    /** OrderFilled event count from our harvest (internal "fills"). */
    fillCount,
    /** Polymarket profile "Predictions" when populated at publish time. */
    predictionsCount,
    /** @deprecated Use fillCount / predictionsCount — kept for older clients. */
    tradeCount: predictionsCount ?? fillCount,
    distinctMarkets: row.distinct_markets,
    closedPositions: row.closed_positions,
    realizedPnl: row.realized_pnl,
    hitRate: row.hit_rate,
    lastActiveTs: row.last_active_ts,
    reasons,
    updatedAt: row.updated_at,
    compositeScore: row.composite_score,
    momentumScore: row.momentum_score,
    consistencyScore: row.consistency_score,
    dittoState: row.ditto_state,
    brierScore: row.brier_score ?? null,
    avgClv1h: row.avg_clv_1h ?? null,
    pctPositiveClv1h: row.pct_positive_clv_1h ?? null,
    topCategory: row.top_category ?? null,
    catVolumeShare: row.cat_volume_share ?? null,
    makerRatio: row.maker_ratio ?? null,
    copyable: row.copyable != null ? row.copyable === 1 : null,
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
  return `${adjectives[h % adjectives.length]} ${animals[(h >>> 3) % animals.length]}`;
}

export interface V3RouterDeps {
  getDb: () => Database.Database;
}

/**
 * Gate for endpoints that MUTATE user state (track, watchlist, dismiss).
 */
export const requireAuthForMutations = (req: Request, res: Response, next: NextFunction): void => {
  const oidc = (req as any).oidc;
  if (oidc && typeof oidc.isAuthenticated === 'function') {
    if (oidc.isAuthenticated()) {
      next();
      return;
    }
    res.status(401).json({
      success: false,
      error: 'Authentication required',
      loginUrl: '/auth/login'
    });
    return;
  }
  next();
};

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
    const data = rows.map((row) => dto(row));
    res.json({ success: true, tier, count: data.length, data });
  });

  router.get('/wallet/:address', (req: Request, res: Response) => {
    const addr = req.params.address.toLowerCase();
    const rows = deps.getDb()
      .prepare('SELECT * FROM discovery_wallet_scores_v3 WHERE LOWER(proxy_wallet) = ?')
      .all(addr) as ScoreRow[];
    if (rows.length === 0) {
      res.status(404).json({ success: false, error: 'wallet not found in v3 scores' });
      return;
    }
    res.json({ success: true, address: addr, tiers: rows.map((row) => dto(row)) });
  });

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
    res.json({ success: true, addresses: addrs, data: rows.map((row) => dto(row)) });
  });

  router.get('/health', (_req: Request, res: Response) => {
    try {
      const counts = deps.getDb().prepare(
        `SELECT tier, COUNT(*) AS count FROM discovery_wallet_scores_v3 GROUP BY tier`
      ).all() as { tier: string; count: number }[];
      const cursor = deps.getDb().prepare(
        'SELECT pipeline, last_block, last_ts_unix, updated_at FROM pipeline_cursor'
      ).all() as Array<{ pipeline: string; last_block: number; last_ts_unix: number; updated_at: number }>;
      const coverage = getDiscoveryCoverageContract(deps.getDb());
      res.json({
        success: true,
        flag: isDiscoveryV3Enabled(),
        tierCounts: Object.fromEntries(counts.map((c) => [c.tier, c.count])),
        cursors: cursor,
        coverage,
      });
    } catch (err) {
      res.json({
        success: true,
        flag: isDiscoveryV3Enabled(),
        tierCounts: {},
        cursors: [],
        coverage: {
          historical_backfill_source: process.env.DISCOVERY_V3_HISTORICAL_BACKFILL_SOURCE
            || 'huggingface:SII-WANGZJ/Polymarket_data/users.parquet',
          historical_coverage_max_ts: Number(process.env.DISCOVERY_V3_HISTORICAL_COVERAGE_MAX_TS || 1772668800),
          known_gap_policy: process.env.DISCOVERY_V3_KNOWN_GAP_POLICY
            || 'Historical coverage is limited to imported backfill + live ingest.',
          live_ingest_cursor_ts: null,
          live_ingest_cursor_block: null,
          score_updated_at: null,
        },
        warning: (err as Error).message,
      });
    }
  });

  router.post('/watchlist', requireAuthForMutations, (req: Request, res: Response) => {
    const address = String(req.body?.address ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      res.status(400).json({ success: false, error: 'address must be 0x + 40 hex chars' });
      return;
    }
    res.json({ success: true, address, action: 'watch' });
  });

  router.delete('/watchlist/:addr', requireAuthForMutations, (req: Request, res: Response) => {
    res.json({ success: true, address: req.params.addr.toLowerCase(), action: 'unwatch' });
  });

  router.post('/dismiss', requireAuthForMutations, (req: Request, res: Response) => {
    const address = String(req.body?.address ?? '').toLowerCase();
    res.json({ success: true, address, action: 'dismiss', until: req.body?.until ?? null });
  });

  router.post('/track', requireAuthForMutations, (req: Request, res: Response) => {
    const address = String(req.body?.address ?? '').toLowerCase();
    res.json({ success: true, address, action: 'track' });
  });

  router.get('/cutover-status', (_req: Request, res: Response) => {
    const db = deps.getDb();
    const tierCounts = db.prepare(
      `SELECT tier, COUNT(*) AS count FROM discovery_wallet_scores_v3 GROUP BY tier`
    ).all() as { tier: string; count: number }[];
    const cursors = db.prepare(
      'SELECT pipeline, last_block, last_ts_unix, updated_at FROM pipeline_cursor'
    ).all() as Array<{ pipeline: string; last_block: number; last_ts_unix: number; updated_at: number }>;
    const totalRow = db.prepare('SELECT COUNT(*) AS c FROM discovery_wallet_scores_v3').get() as { c: number };
    const coverage = getDiscoveryCoverageContract(db);
    res.json({
      success: true,
      flag: isDiscoveryV3Enabled(),
      totalScoreRows: totalRow.c,
      tierCounts: Object.fromEntries(tierCounts.map((c) => [c.tier, c.count])),
      cursors,
      coverage,
    });
  });

  return router;
}
