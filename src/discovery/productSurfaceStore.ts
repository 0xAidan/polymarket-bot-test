import { getDatabase } from '../database.js';

type WatchlistEntry = {
  address: string;
  note?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  discoveryScore?: number;
  trustScore?: number;
  copyabilityScore?: number;
  surfaceBucket?: string;
  confidenceBucket?: string;
  allocationState?: string;
  allocationWeight?: number;
};

export const upsertDiscoveryWatchlistEntry = (
  address: string,
  note?: string,
  tags: string[] = [],
): WatchlistEntry => {
  const normalizedAddress = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_watchlist (wallet_address, note, tags_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(wallet_address) DO UPDATE SET
      note = excluded.note,
      tags_json = excluded.tags_json,
      updated_at = excluded.updated_at
  `).run(
    normalizedAddress,
    note?.trim() || null,
    JSON.stringify(tags),
    now,
    now,
  );
  const entry = getDiscoveryWatchlistEntry(normalizedAddress);
  if (!entry) {
    throw new Error('Failed to upsert discovery watchlist entry');
  }
  return entry;
};

export const removeDiscoveryWatchlistEntry = (address: string): boolean => {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM discovery_watchlist WHERE wallet_address = ?').run(address.toLowerCase());
  return result.changes > 0;
};

export const getDiscoveryWatchlistEntry = (address: string): WatchlistEntry | null => {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      w.wallet_address,
      w.note,
      w.tags_json,
      w.created_at,
      w.updated_at,
      s2.discovery_score,
      s2.trust_score,
      s2.copyability_score,
      s2.surface_bucket,
      s2.confidence_bucket,
      aps.state as allocation_state,
      aps.target_weight as allocation_weight
    FROM discovery_watchlist w
    LEFT JOIN discovery_wallet_scores_v2 s2 ON s2.address = w.wallet_address
    LEFT JOIN allocation_policy_states aps ON aps.tracked_wallet_address = w.wallet_address
    WHERE w.wallet_address = ?
    LIMIT 1
  `).get(address.toLowerCase()) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapWatchlistRow(row);
};

export const listDiscoveryWatchlistEntries = (limit = 100, offset = 0): WatchlistEntry[] => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      w.wallet_address,
      w.note,
      w.tags_json,
      w.created_at,
      w.updated_at,
      s2.discovery_score,
      s2.trust_score,
      s2.copyability_score,
      s2.surface_bucket,
      s2.confidence_bucket,
      aps.state as allocation_state,
      aps.target_weight as allocation_weight
    FROM discovery_watchlist w
    LEFT JOIN discovery_wallet_scores_v2 s2 ON s2.address = w.wallet_address
    LEFT JOIN allocation_policy_states aps ON aps.tracked_wallet_address = w.wallet_address
    ORDER BY w.updated_at DESC, w.wallet_address ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<Record<string, unknown>>;

  return rows.map(mapWatchlistRow);
};

export const buildDiscoveryMethodologyPayload = (): Record<string, unknown> => ({
  version: 'v2',
  scoring: {
    stack: ['discoveryScore', 'trustScore', 'copyabilityScore', 'confidenceBucket', 'strategyClass'],
    discoveryGateLogic: 'profitability + focus + copyability gates must all pass',
    buckets: ['emerging', 'trusted', 'copyable', 'watch_only', 'suppressed'],
    definitions: {
      discoveryScore: 'Should this wallet surface right now based on signal quality and timing.',
      trustScore: 'How credible the wallet looks across realized outcomes, breadth, and behavior.',
      copyabilityScore: 'How realistic it is for a normal follower to mirror the wallet without bad execution.',
      confidenceBucket: 'How much evidence supports the current read. This is evidence strength, not win probability.',
      strategyClass: 'What kind of wallet this appears to be, such as informational directional or structural arbitrage.',
    },
    bucketDefinitions: {
      emerging: 'Strong discovery signal with acceptable trust, but still earlier or less proven than a trusted wallet.',
      trusted: 'Good discovery score plus strong trust. Worth serious attention.',
      copyable: 'Trusted and realistically mirrorable under current market conditions.',
      watch_only: 'Interesting enough to monitor, but not yet a clear copy target.',
      suppressed: 'Too weak, noisy, or suspicious to surface as a default candidate.',
    },
    uiOverlays: {
      tracked: 'Tracked is a UI overlay showing wallets already promoted into Ditto. It is not a separate scoring bucket.',
    },
  },
  allocationPolicy: {
    states: ['NEW', 'CONSISTENT', 'HOT_STREAK', 'COOLDOWN', 'PAUSED'],
    actions: ['monitor', 'hold', 'upsize', 'derisk', 'pause', 'resume'],
    controls: ['hysteresis', 'risk caps', 'pause-on-risk', 'guarded resume'],
  },
  explainability: {
    surfacedFields: ['primaryReason', 'supportingReasonChips', 'cautionFlags', 'confidence', 'freshnessMs'],
    alerts: ['SIZE_ANOMALY', 'VOLUME_SPIKE', 'DORMANT_ACTIVATION', 'MARKET_PIONEER', 'NEW_WHALE', 'COORDINATED_ENTRY', 'CONVICTION_BUILD'],
  },
});

const mapWatchlistRow = (row: Record<string, unknown>): WatchlistEntry => ({
  address: String(row.wallet_address),
  note: row.note ? String(row.note) : undefined,
  tags: parseJsonArray(row.tags_json),
  createdAt: Number(row.created_at ?? 0),
  updatedAt: Number(row.updated_at ?? 0),
  discoveryScore: row.discovery_score == null ? undefined : Number(row.discovery_score),
  trustScore: row.trust_score == null ? undefined : Number(row.trust_score),
  copyabilityScore: row.copyability_score == null ? undefined : Number(row.copyability_score),
  surfaceBucket: row.surface_bucket ? String(row.surface_bucket) : undefined,
  confidenceBucket: row.confidence_bucket ? String(row.confidence_bucket) : undefined,
  allocationState: row.allocation_state ? String(row.allocation_state) : undefined,
  allocationWeight: row.allocation_weight == null ? undefined : Number(row.allocation_weight),
});

const parseJsonArray = (value: unknown): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
};
