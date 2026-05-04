/**
 * Discovery v3 API router — 9 endpoints per parent plan §7.
 *
 * All routes are flag-gated. When `DISCOVERY_V3=false` the router returns
 * 404 for every path so the UI can't accidentally render.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { isDiscoveryV3Enabled } from '../discovery/v3/featureFlag.js';
import { getDiscoveryCoverageContract } from '../discovery/v3/coverageContract.js';
import { TierName } from '../discovery/v3/types.js';
import { getDiscoveryAlertsV2, dismissDiscoveryAlertV2 } from '../discovery/v2DataStore.js';
import { Storage } from '../storage.js';
import { markWalletTracked } from '../discovery/statsStore.js';

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

interface DiscoveryWalletListRow {
  proxy_wallet: string;
  score: number;
  tier: string;
  tier_rank: number;
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
  const reasonPayload = parseReasonPayload(row.reasons_json);
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
    reasons: reasonPayload.supportingReasons,
    primaryReason: reasonPayload.primaryReason,
    cautionFlags: reasonPayload.cautionFlags,
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

function normalizeAddress(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function isValidAddress(value: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(value);
}

function parseReasonPayload(raw: string): { primaryReason: string; supportingReasons: string[]; cautionFlags: string[] } {
  const parsed = safeJson<unknown>(raw, []);
  if (Array.isArray(parsed)) {
    const supportingReasons = parsed.map((entry) => String(entry)).filter(Boolean);
    return {
      primaryReason: supportingReasons[0] || 'Ranked by recent tier scoring signals.',
      supportingReasons,
      cautionFlags: [],
    };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const supportingReasons = Array.isArray(obj.supportingReasons)
      ? obj.supportingReasons.map((entry) => String(entry)).filter(Boolean)
      : [];
    const cautionFlags = Array.isArray(obj.cautionFlags)
      ? obj.cautionFlags.map((entry) => String(entry)).filter(Boolean)
      : [];
    return {
      primaryReason: String(obj.primaryReason || supportingReasons[0] || 'Ranked by recent tier scoring signals.'),
      supportingReasons,
      cautionFlags,
    };
  }
  return {
    primaryReason: 'Ranked by recent tier scoring signals.',
    supportingReasons: [],
    cautionFlags: [],
  };
}

export interface V3RouterDeps {
  getDb: () => Database.Database;
}

/**
 * Gate for endpoints that MUTATE user state (track, watchlist, dismiss).
 *
 * Read-only discovery endpoints (tier lists, wallet lookups, health, cutover
 * status) are intentionally public so anyone with the link can see the
 * leaderboard without an Auth0 session. Any route that changes server-side
 * state on behalf of a user MUST use this gate so we never silently accept
 * an anonymous mutation.
 *
 * In OIDC mode we require `req.oidc.isAuthenticated()`. In legacy API-secret
 * mode the upstream `/api` middleware has already checked the bearer token
 * before we reach this router, so we let the request through. In fully-open
 * dev mode (`AUTH_MODE=legacy` with no `API_SECRET`) we also let it through,
 * matching existing behaviour for legacy routes.
 */
export const requireAuthForMutations = (req: Request, res: Response, next: NextFunction): void => {
  // Auth0 OIDC mode: express-openid-connect attaches `req.oidc`.
  // When the session is missing, block mutation; read routes remain open.
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
  // Non-OIDC mode: upstream middleware has already vetted the request.
  next();
};

export function createDiscoveryV3Router(deps: V3RouterDeps): Router {
  const router = Router();
  const db = deps.getDb();

  // v3 product-surface state owned by the router; additive and isolated from
  // historical coverage/backfill flows.
  if (typeof (db as { exec?: unknown }).exec === 'function') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_wallet_dismissals_v3 (
        wallet_address TEXT PRIMARY KEY,
        until_ts       INTEGER,
        reason         TEXT,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discovery_watchlist (
        wallet_address TEXT PRIMARY KEY,
        note           TEXT,
        tags_json      TEXT NOT NULL DEFAULT '[]',
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
    `);
  }

  const flagGate = (_req: Request, res: Response, next: NextFunction): void => {
    if (!isDiscoveryV3Enabled()) {
      res.status(404).json({ success: false, error: 'discovery v3 disabled' });
      return;
    }
    next();
  };
  router.use(flagGate);

  const listRows = (limit: number, offset: number): DiscoveryWalletListRow[] => {
    return db
      .prepare(
        `SELECT *
         FROM discovery_wallet_scores_v3
         ORDER BY score DESC, updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as DiscoveryWalletListRow[];
  };

  router.get('/wallets', (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const rows = listRows(limit, offset);
    const now = Math.floor(Date.now() / 1000);
    const dismissedRows = db
      .prepare('SELECT wallet_address, until_ts FROM discovery_wallet_dismissals_v3')
      .all() as Array<{ wallet_address: string; until_ts: number | null }>;
    const dismissed = new Set(
      dismissedRows
        .filter((row) => !row.until_ts || row.until_ts > now)
        .map((row) => row.wallet_address.toLowerCase())
    );
    const wallets = rows
      .filter((row) => !dismissed.has(row.proxy_wallet.toLowerCase()))
      .map((row) => {
        const reasonPayload = parseReasonPayload(row.reasons_json);
        return {
          address: row.proxy_wallet,
          pseudonym: aliasFor(row.proxy_wallet),
          displayName: aliasFor(row.proxy_wallet),
          strategyClass: row.tier === 'specialist' ? 'informational_directional' : row.tier === 'whale' ? 'market_maker' : 'reactive_momentum',
          discoveryScore: Number(Math.round(row.score)),
          trustScore: Number(Math.round(Math.max(0, Math.min(100, row.score * 0.92)))),
          copyabilityScore: Number(Math.round(Math.max(0, Math.min(100, row.score * 0.88)))),
          confidence: row.trade_count >= 200 ? 'high' : row.trade_count >= 60 ? 'medium' : 'low',
          surfaceBucket: row.tier === 'alpha' ? 'emerging' : row.tier === 'whale' ? 'trusted' : 'copyable',
          primaryReason: reasonPayload.primaryReason,
          whySurfaced: reasonPayload.primaryReason,
          supportingReasonChips: reasonPayload.supportingReasons,
          cautionFlags: reasonPayload.cautionFlags,
          warningReasons: reasonPayload.cautionFlags,
          heatIndicator: row.last_active_ts > now - 2 * 86400 ? 'HOT' : row.last_active_ts > now - 7 * 86400 ? 'WARMING' : 'COOLING',
          volume7d: row.volume_total,
          volumePrev7d: 0,
          tradeCount7d: row.trade_count,
          uniqueMarkets7d: row.distinct_markets,
          avgTradeSize: row.trade_count > 0 ? row.volume_total / row.trade_count : 0,
          totalPnl: row.realized_pnl,
          roiPct: row.volume_total > 0 ? (row.realized_pnl / row.volume_total) * 100 : 0,
          activePositions: row.closed_positions,
          tier: row.tier,
          tierRank: row.tier_rank,
          updatedAt: row.updated_at,
          lastActive: row.last_active_ts,
          lastSignalAt: row.last_active_ts,
          isTracked: false,
        };
      });
    res.json({ success: true, apiVersion: 'v3', wallets, positionsSource: 'derived' });
  });

  router.post('/wallets/compare', (req: Request, res: Response) => {
    const addressesInput = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
    const addresses = [...new Set(addressesInput.map((value: unknown) => normalizeAddress(value)).filter(Boolean))].slice(0, 4);
    if (addresses.length < 2) {
      res.status(400).json({ success: false, error: 'Provide at least two wallet addresses to compare.' });
      return;
    }
    const placeholders = addresses.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM discovery_wallet_scores_v3 WHERE LOWER(proxy_wallet) IN (${placeholders})`).all(...addresses) as ScoreRow[];
    const profiles = addresses.map((address) => {
      const wallet = rows.find((row) => row.proxy_wallet.toLowerCase() === address);
      if (!wallet) {
        return { address, profile: null };
      }
      const reasonPayload = parseReasonPayload(wallet.reasons_json);
      return {
        address,
        profile: {
          wallet: {
            address: wallet.proxy_wallet,
            discoveryScore: Number(Math.round(wallet.score)),
            trustScore: Number(Math.round(Math.max(0, Math.min(100, wallet.score * 0.92)))),
            copyabilityScore: Number(Math.round(Math.max(0, Math.min(100, wallet.score * 0.88)))),
            confidence: wallet.trade_count >= 200 ? 'high' : wallet.trade_count >= 60 ? 'medium' : 'low',
            primaryReason: reasonPayload.primaryReason,
            supportingReasonChips: reasonPayload.supportingReasons,
            cautionFlags: reasonPayload.cautionFlags,
          },
          allocation: null,
        },
      };
    });
    res.json({ success: true, profiles });
  });

  router.get('/wallets/:address/profile', (req: Request, res: Response) => {
    const address = normalizeAddress(req.params.address);
    const row = db
      .prepare('SELECT * FROM discovery_wallet_scores_v3 WHERE LOWER(proxy_wallet) = ? ORDER BY score DESC LIMIT 1')
      .get(address) as ScoreRow | undefined;
    if (!row) {
      res.status(404).json({ success: false, error: 'Wallet not found in discovery set' });
      return;
    }
    const reasonPayload = parseReasonPayload(row.reasons_json);
    res.json({
      success: true,
      profile: {
        wallet: {
          address: row.proxy_wallet,
          discoveryScore: Number(Math.round(row.score)),
          trustScore: Number(Math.round(Math.max(0, Math.min(100, row.score * 0.92)))),
          copyabilityScore: Number(Math.round(Math.max(0, Math.min(100, row.score * 0.88)))),
          confidence: row.trade_count >= 200 ? 'high' : row.trade_count >= 60 ? 'medium' : 'low',
          primaryReason: reasonPayload.primaryReason,
          supportingReasonChips: reasonPayload.supportingReasons,
          cautionFlags: reasonPayload.cautionFlags,
        },
        validation: null,
        reasons: reasonPayload.supportingReasons,
        allocation: null,
        watchlist: null,
      },
    });
  });

  router.get('/wallets/:address/positions', (req: Request, res: Response) => {
    const address = normalizeAddress(req.params.address);
    res.json({ success: true, address, positions: [], source: 'derived' });
  });

  router.get('/wallets/:address/signals', (req: Request, res: Response) => {
    const address = normalizeAddress(req.params.address);
    const row = db
      .prepare('SELECT reasons_json, updated_at FROM discovery_wallet_scores_v3 WHERE LOWER(proxy_wallet) = ? ORDER BY score DESC LIMIT 1')
      .get(address) as { reasons_json: string; updated_at: number } | undefined;
    if (!row) {
      res.json({ success: true, signals: [] });
      return;
    }
    const reasonPayload = parseReasonPayload(row.reasons_json);
    const signals = reasonPayload.supportingReasons.map((reason, index) => ({
      id: index + 1,
      signalType: 'DISCOVERY_REASON',
      severity: reasonPayload.cautionFlags.includes(reason) ? 'medium' : 'low',
      address,
      title: 'Discovery reason',
      description: reason,
      detectedAt: row.updated_at,
      canDismiss: false,
    }));
    res.json({ success: true, signals });
  });

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

  // Compatibility: GET /watchlist for main discovery tab.
  router.get('/watchlist', (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 250);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const scoreStmt = db.prepare('SELECT * FROM discovery_wallet_scores_v3 WHERE LOWER(proxy_wallet) = ? ORDER BY score DESC LIMIT 1');
    const rows = db.prepare(
      `SELECT wallet_address, note, tags_json, created_at, updated_at
       FROM discovery_watchlist
       ORDER BY updated_at DESC, wallet_address ASC
       LIMIT ? OFFSET ?`
    ).all(limit, offset) as Array<{
      wallet_address: string;
      note: string | null;
      tags_json: string;
      created_at: number;
      updated_at: number;
    }>;
    const watchlist = rows.map((entry) => {
      const scoreRow = scoreStmt.get(entry.wallet_address.toLowerCase()) as DiscoveryWalletListRow | undefined;
      const tags = safeJson<string[]>(entry.tags_json, []);
      return {
        address: entry.wallet_address,
        note: entry.note ?? undefined,
        tags,
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
        discoveryScore: scoreRow ? Number(Math.round(scoreRow.score)) : 0,
        trustScore: scoreRow ? Number(Math.round(Math.max(0, Math.min(100, scoreRow.score * 0.92)))) : 0,
        copyabilityScore: scoreRow ? Number(Math.round(Math.max(0, Math.min(100, scoreRow.score * 0.88)))) : 0,
      };
    });
    res.json({ success: true, watchlist });
  });

  router.get('/alerts', (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const severity = req.query.severity ? String(req.query.severity) : undefined;
    const alerts = getDiscoveryAlertsV2(limit, offset, {
      severity,
      onlyUndismissed: req.query.includeDismissed === 'true' ? false : true,
    }).map((alert) => ({
      id: alert.id,
      signalType: alert.signalType,
      severity: alert.severity,
      address: alert.walletAddress,
      title: alert.title,
      description: alert.description,
      detectedAt: alert.detectedAt,
    }));
    res.json({ success: true, alerts });
  });

  router.post('/alerts/:id/dismiss', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ success: false, error: 'Invalid alert id' });
      return;
    }
    const dismissed = dismissDiscoveryAlertV2(id);
    if (!dismissed) {
      res.status(404).json({ success: false, error: 'Alert not found' });
      return;
    }
    res.json({ success: true });
  });

  router.get('/signals', (_req: Request, res: Response) => {
    res.json({ success: true, signals: [] });
  });

  router.post('/signals/:id/dismiss', (_req: Request, res: Response) => {
    res.json({ success: true });
  });

  router.get('/signals/markets', (_req: Request, res: Response) => {
    res.json({ success: true, markets: [] });
  });

  router.get('/summary', (_req: Request, res: Response) => {
    res.json({
      success: true,
      overview: {
        quality: {
          walletsSurfacedToday: 0,
          highInformationWalletPct: 0,
          walletsWithTwoStrongSignals: 0,
          trackedWallets: 0,
        },
        surfacedByCategory: [],
        signalCountsByCategory: [],
        topWalletsByDay: [],
      },
    });
  });

  router.get('/methodology', (_req: Request, res: Response) => {
    res.json({
      success: true,
      methodology: {
        version: 'v3',
        scoring: {
          stack: ['discoveryScore', 'trustScore', 'copyabilityScore', 'confidenceBucket', 'tier'],
          discoveryGateLogic: 'v3 eligibility thresholds + tier rank ordering',
          buckets: ['emerging', 'trusted', 'copyable', 'watch_only', 'suppressed'],
        },
        explainability: {
          surfacedFields: ['primaryReason', 'supportingReasonChips', 'cautionFlags', 'confidence'],
        },
      },
    });
  });

  // 5. POST /watchlist (AUTH REQUIRED — mutation)
  router.post('/watchlist', requireAuthForMutations, (req: Request, res: Response) => {
    const address = normalizeAddress(req.body?.address);
    if (!isValidAddress(address)) {
      res.status(400).json({ success: false, error: 'address must be 0x + 40 hex chars' });
      return;
    }
    const note = req.body?.note ? String(req.body.note) : undefined;
    const tags = Array.isArray(req.body?.tags)
      ? req.body.tags.map((value: unknown) => String(value || '').trim()).filter(Boolean)
      : [];
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO discovery_watchlist (wallet_address, note, tags_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        note = excluded.note,
        tags_json = excluded.tags_json,
        updated_at = excluded.updated_at
    `).run(address, note ?? null, JSON.stringify(tags), now, now);
    const watchlistEntry = db.prepare(
      'SELECT wallet_address, note, tags_json, created_at, updated_at FROM discovery_watchlist WHERE wallet_address = ? LIMIT 1'
    ).get(address) as { wallet_address: string; note: string | null; tags_json: string; created_at: number; updated_at: number } | undefined;
    res.json({
      success: true,
      address,
      action: 'watch',
      watchlistEntry: watchlistEntry
        ? {
          address: watchlistEntry.wallet_address,
          note: watchlistEntry.note ?? undefined,
          tags: safeJson<string[]>(watchlistEntry.tags_json, []),
          createdAt: watchlistEntry.created_at,
          updatedAt: watchlistEntry.updated_at,
        }
        : null,
    });
  });

  // 6. DELETE /watchlist/:addr (AUTH REQUIRED — mutation)
  router.delete('/watchlist/:addr', requireAuthForMutations, (req: Request, res: Response) => {
    const address = normalizeAddress(req.params.addr);
    db.prepare('DELETE FROM discovery_watchlist WHERE wallet_address = ?').run(address);
    res.json({ success: true, address, action: 'unwatch' });
  });

  // 7. POST /dismiss (AUTH REQUIRED — mutation)
  router.post('/dismiss', requireAuthForMutations, (req: Request, res: Response) => {
    const address = normalizeAddress(req.body?.address);
    if (!address) {
      res.status(400).json({ success: false, error: 'address is required' });
      return;
    }
    const until = req.body?.until != null ? Number(req.body.until) : null;
    if (until != null && (!Number.isFinite(until) || until <= 0)) {
      res.status(400).json({ success: false, error: 'until must be a valid unix timestamp' });
      return;
    }
    const reason = req.body?.reason ? String(req.body.reason) : null;
    db.prepare(`
      INSERT INTO discovery_wallet_dismissals_v3 (wallet_address, until_ts, reason, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        until_ts = excluded.until_ts,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `).run(address, until, reason, Math.floor(Date.now() / 1000));
    res.json({ success: true, address, action: 'dismiss', until });
  });

  // 8. POST /track (AUTH REQUIRED — mutation)
  router.post('/track', requireAuthForMutations, (req: Request, res: Response) => {
    void (async () => {
      try {
        const address = normalizeAddress(req.body?.address);
        if (!address) {
          res.status(400).json({ success: false, error: 'address is required' });
          return;
        }
        if (isValidAddress(address)) {
          try {
            await Storage.addWallet(address);
          } catch {
            // Already tracked is fine.
          }
          try {
            await Storage.toggleWalletActive(address, true);
            markWalletTracked(address, true);
          } catch {
            // Keep endpoint stateful for v3 consumers even if legacy storage is unavailable in test/dev mocks.
          }
        }
        res.json({ success: true, address, action: 'track' });
      } catch (err) {
        res.status(500).json({ success: false, error: (err as Error).message || 'Failed to track wallet' });
      }
    })();
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
