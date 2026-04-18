import { getDatabase } from '../database.js';
import { DiscoveryWalletCandidate } from './types.js';

type SeedContext = {
  conditionId?: string;
  marketTitle?: string;
  detectedAt: number;
};

const normalizeAddress = (value: unknown): string => String(value ?? '').trim().toLowerCase();
const parseOptionalNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const mapCandidateRow = (row: Record<string, unknown>): DiscoveryWalletCandidate => ({
  address: String(row.address),
  sourceType: String(row.source_type) as DiscoveryWalletCandidate['sourceType'],
  sourceLabel: String(row.source_label),
  conditionId: String(row.condition_id || '') || undefined,
  marketTitle: row.market_title ? String(row.market_title) : undefined,
  sourceRank: parseOptionalNumber(row.source_rank),
  sourceMetric: parseOptionalNumber(row.source_metric),
  sourceMetadata: row.source_metadata ? JSON.parse(String(row.source_metadata)) as Record<string, unknown> : undefined,
  firstSeenAt: Number(row.first_seen_at),
  lastSeenAt: Number(row.last_seen_at),
  updatedAt: Number(row.updated_at),
});

export const buildLeaderboardSeedCandidates = (
  rows: Array<Record<string, unknown>>,
  context: { category: string; timePeriod: string; detectedAt: number },
): DiscoveryWalletCandidate[] => {
  const candidates: DiscoveryWalletCandidate[] = [];
  for (const row of rows) {
    const address = normalizeAddress(row.proxyWallet ?? row.user);
    if (!address) continue;

    candidates.push({
      address,
      sourceType: 'leaderboard',
      sourceLabel: `${context.category}:${context.timePeriod}`,
      conditionId: undefined,
      marketTitle: undefined,
      sourceRank: parseOptionalNumber(row.rank),
      sourceMetric: parseOptionalNumber(row.pnl),
      sourceMetadata: {
        userName: row.userName ?? row.name,
        volume: parseOptionalNumber(row.vol),
      },
      firstSeenAt: context.detectedAt,
      lastSeenAt: context.detectedAt,
      updatedAt: context.detectedAt,
    });
  }
  return candidates;
};

export const buildMarketPositionSeedCandidates = (
  rows: Array<Record<string, unknown>>,
  context: SeedContext,
): DiscoveryWalletCandidate[] => {
  const positions = rows.flatMap((row) => {
    if (Array.isArray(row.positions)) return row.positions as Array<Record<string, unknown>>;
    return [row];
  });

  const candidates: DiscoveryWalletCandidate[] = [];
  for (const position of positions) {
    const address = normalizeAddress(position.proxyWallet ?? position.user ?? position.address);
    if (!address) continue;

    candidates.push({
      address,
      sourceType: 'market-positions',
      sourceLabel: 'market-positions',
      conditionId: context.conditionId,
      marketTitle: context.marketTitle,
      sourceRank: undefined,
      sourceMetric: parseOptionalNumber(position.totalPnl ?? position.cashPnl ?? position.currentValue),
      sourceMetadata: {
        name: position.name,
        verified: position.verified,
        currentValue: parseOptionalNumber(position.currentValue),
      },
      firstSeenAt: context.detectedAt,
      lastSeenAt: context.detectedAt,
      updatedAt: context.detectedAt,
    });
  }
  return candidates;
};

export const buildHolderSeedCandidates = (
  rows: Array<Record<string, unknown>>,
  context: SeedContext,
): DiscoveryWalletCandidate[] => {
  const candidates: DiscoveryWalletCandidate[] = [];
  for (const row of rows) {
    const address = normalizeAddress(row.proxyWallet ?? row.user ?? row.address);
    if (!address) continue;

    candidates.push({
      address,
      sourceType: 'holders',
      sourceLabel: 'holders',
      conditionId: context.conditionId,
      marketTitle: context.marketTitle,
      sourceRank: undefined,
      sourceMetric: parseOptionalNumber(row.size ?? row.balance ?? row.amount),
      sourceMetadata: undefined,
      firstSeenAt: context.detectedAt,
      lastSeenAt: context.detectedAt,
      updatedAt: context.detectedAt,
    });
  }
  return candidates;
};

export const buildTradeSeedCandidates = (
  rows: Array<Record<string, unknown>>,
  context: SeedContext,
): DiscoveryWalletCandidate[] => {
  const candidates: DiscoveryWalletCandidate[] = [];
  for (const row of rows) {
    const address = normalizeAddress(row.proxyWallet ?? row.owner ?? row.maker ?? row.user);
    if (!address) continue;

    const size = parseOptionalNumber(row.size);
    const price = parseOptionalNumber(row.price);
    const notional = size !== undefined && price !== undefined ? size * price : undefined;

    candidates.push({
      address,
      sourceType: 'trades',
      sourceLabel: 'recent-trades',
      conditionId: context.conditionId,
      marketTitle: context.marketTitle,
      sourceRank: undefined,
      sourceMetric: notional,
      sourceMetadata: {
        price,
        size,
      },
      firstSeenAt: context.detectedAt,
      lastSeenAt: context.detectedAt,
      updatedAt: context.detectedAt,
    });
  }
  return candidates;
};

export const upsertWalletCandidates = (candidates: DiscoveryWalletCandidate[]): void => {
  if (candidates.length === 0) return;

  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO discovery_wallet_candidates (
      address, source_type, source_label, condition_id, market_title, source_rank,
      source_metric, source_metadata, first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address, source_type, condition_id, source_label) DO UPDATE SET
      market_title = excluded.market_title,
      source_rank = excluded.source_rank,
      source_metric = excluded.source_metric,
      source_metadata = excluded.source_metadata,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction(() => {
    for (const candidate of candidates) {
      stmt.run(
        candidate.address,
        candidate.sourceType,
        candidate.sourceLabel,
        candidate.conditionId ?? '',
        candidate.marketTitle ?? null,
        candidate.sourceRank ?? null,
        candidate.sourceMetric ?? null,
        candidate.sourceMetadata ? JSON.stringify(candidate.sourceMetadata) : null,
        candidate.firstSeenAt,
        candidate.lastSeenAt,
        candidate.updatedAt,
      );
    }
  });

  tx();
};

export const getWalletCandidates = (limit = 100): DiscoveryWalletCandidate[] => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT *
    FROM discovery_wallet_candidates
    ORDER BY updated_at DESC, source_metric DESC, source_rank ASC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  return rows.map(mapCandidateRow);
};

export const upsertWalletCandidatesV2 = (candidates: DiscoveryWalletCandidate[], snapshotAt: number): void => {
  if (candidates.length === 0) return;

  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO discovery_wallet_candidates_v2 (
      address, source_type, source_label, condition_id, market_title, source_rank,
      source_metric, source_metadata, first_seen_at, last_seen_at, updated_at, snapshot_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address, source_type, condition_id, source_label, snapshot_at) DO UPDATE SET
      market_title = excluded.market_title,
      source_rank = excluded.source_rank,
      source_metric = excluded.source_metric,
      source_metadata = excluded.source_metadata,
      first_seen_at = MIN(discovery_wallet_candidates_v2.first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(discovery_wallet_candidates_v2.last_seen_at, excluded.last_seen_at),
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction(() => {
    for (const candidate of candidates) {
      stmt.run(
        candidate.address,
        candidate.sourceType,
        candidate.sourceLabel,
        candidate.conditionId ?? '',
        candidate.marketTitle ?? null,
        candidate.sourceRank ?? null,
        candidate.sourceMetric ?? null,
        candidate.sourceMetadata ? JSON.stringify(candidate.sourceMetadata) : null,
        candidate.firstSeenAt,
        candidate.lastSeenAt,
        candidate.updatedAt,
        snapshotAt,
      );
    }
  });

  tx();
};

const latestCandidateSnapshotAt = (): number => {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT MAX(snapshot_at) AS snapshot_at
    FROM discovery_wallet_candidates_v2
  `).get() as { snapshot_at?: number | null };
  return Number(row?.snapshot_at ?? 0);
};

export const getWalletCandidatesV2 = (limit = 100): DiscoveryWalletCandidate[] => {
  const snapshotAt = latestCandidateSnapshotAt();
  if (!snapshotAt) return [];

  const db = getDatabase();
  const rows = db.prepare(`
    SELECT *
    FROM discovery_wallet_candidates_v2
    WHERE snapshot_at = ?
    ORDER BY updated_at DESC, source_metric DESC, source_rank ASC
    LIMIT ?
  `).all(snapshotAt, limit) as Array<Record<string, unknown>>;

  return rows.map(mapCandidateRow);
};

export const getCandidateAddressesForScoringV2 = (limit = 200): string[] => {
  const snapshotAt = latestCandidateSnapshotAt();
  if (!snapshotAt) return [];

  const db = getDatabase();
  const rows = db.prepare(`
    SELECT address
    FROM discovery_wallet_candidates_v2
    WHERE snapshot_at = ?
    GROUP BY address
    ORDER BY MAX(updated_at) DESC
    LIMIT ?
  `).all(snapshotAt, limit) as Array<{ address: string }>;

  return rows.map((row) => row.address);
};

export const getWalletCandidatesByAddressV2 = (address: string): DiscoveryWalletCandidate[] => {
  const snapshotAt = latestCandidateSnapshotAt();
  if (!snapshotAt) return [];

  const db = getDatabase();
  const rows = db.prepare(`
    SELECT *
    FROM discovery_wallet_candidates_v2
    WHERE address = ? AND snapshot_at = ?
    ORDER BY updated_at DESC, source_metric DESC
  `).all(address.toLowerCase(), snapshotAt) as Array<Record<string, unknown>>;

  return rows.map(mapCandidateRow);
};

export const getCandidateAddressesForScoring = (limit = 200): string[] => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT address
    FROM discovery_wallet_candidates
    GROUP BY address
    ORDER BY MAX(updated_at) DESC
    LIMIT ?
  `).all(limit) as Array<{ address: string }>;

  return rows.map((row) => row.address);
};

export const getWalletCandidatesByAddress = (address: string): DiscoveryWalletCandidate[] => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT *
    FROM discovery_wallet_candidates
    WHERE address = ?
    ORDER BY updated_at DESC, source_metric DESC
  `).all(address.toLowerCase()) as Array<Record<string, unknown>>;

  return rows.map(mapCandidateRow);
};

export const getCandidateAddressesNeedingValidation = (
  limit = 25,
  staleBefore = Math.floor(Date.now() / 1000) - 6 * 60 * 60,
): string[] => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT c.address
    FROM discovery_wallet_candidates c
    LEFT JOIN discovery_wallet_validation v ON v.address = c.address
    GROUP BY c.address
    HAVING MAX(COALESCE(v.last_validated_at, 0)) < ?
    ORDER BY MAX(c.updated_at) DESC
    LIMIT ?
  `).all(staleBefore, limit) as Array<{ address: string }>;

  return rows.map((row) => row.address);
};

export const getWalletCandidateFocusSummary = (address: string): {
  focusCategory?: string;
  supportingMarkets: string[];
  sourceChannels: string[];
} => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT c.source_type, c.market_title, p.focus_category
    FROM discovery_wallet_candidates c
    LEFT JOIN discovery_market_pool p ON p.condition_id = c.condition_id
    WHERE c.address = ?
    ORDER BY c.updated_at DESC, c.source_metric DESC
  `).all(address.toLowerCase()) as Array<{
    source_type: string;
    market_title?: string | null;
    focus_category?: string | null;
  }>;

  const channels = [...new Set(rows.map((row) => row.source_type))];
  const markets = [...new Set(rows.map((row) => row.market_title).filter(Boolean) as string[])].slice(0, 3);
  const categoryCounts = new Map<string, number>();
  for (const row of rows) {
    const category = row.focus_category || '';
    if (!category) continue;
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }

  let focusCategory: string | undefined;
  let bestCount = 0;
  for (const [category, count] of categoryCounts.entries()) {
    if (count > bestCount) {
      focusCategory = category;
      bestCount = count;
    }
  }

  return {
    focusCategory,
    supportingMarkets: markets,
    sourceChannels: channels,
  };
};

export const getWalletCandidateFocusSummaryV2 = (address: string): {
  focusCategory?: string;
  supportingMarkets: string[];
  sourceChannels: string[];
} => {
  const snapshotAt = latestCandidateSnapshotAt();
  if (!snapshotAt) {
    return {
      focusCategory: undefined,
      supportingMarkets: [],
      sourceChannels: [],
    };
  }

  const db = getDatabase();
  const rows = db.prepare(`
    SELECT c.source_type, c.market_title, p.focus_category
    FROM discovery_wallet_candidates_v2 c
    LEFT JOIN discovery_market_pool p ON p.condition_id = c.condition_id
    WHERE c.address = ? AND c.snapshot_at = ?
    ORDER BY c.updated_at DESC, c.source_metric DESC
  `).all(address.toLowerCase(), snapshotAt) as Array<{
    source_type: string;
    market_title?: string | null;
    focus_category?: string | null;
  }>;

  const channels = [...new Set(rows.map((row) => row.source_type))];
  const markets = [...new Set(rows.map((row) => row.market_title).filter(Boolean) as string[])].slice(0, 3);
  const categoryCounts = new Map<string, number>();
  for (const row of rows) {
    const category = row.focus_category || '';
    if (!category) continue;
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }

  let focusCategory: string | undefined;
  let bestCount = 0;
  for (const [category, count] of categoryCounts.entries()) {
    if (count > bestCount) {
      focusCategory = category;
      bestCount = count;
    }
  }

  return {
    focusCategory,
    supportingMarkets: markets,
    sourceChannels: channels,
  };
};
