import { getDatabase } from '../database.js';
import { classifyDiscoveryMarket } from './marketClassifier.js';
import { DiscoveryMarketCategory, DiscoveryMarketPoolEntry } from './types.js';
import { upsertMarketUniverseV2Entries } from './v2DataStore.js';

type EventTag = {
  slug?: string;
  label?: string;
};

type EventMarket = {
  id?: string;
  conditionId?: string;
  slug?: string;
  question?: string;
  clobTokenIds?: unknown;
  outcomes?: unknown;
  volume24hr?: string | number;
  acceptingOrders?: boolean;
  competitive?: boolean;
};

type GammaEvent = {
  id?: string;
  slug?: string;
  title?: string;
  tags?: EventTag[];
  liquidity?: string | number;
  volume24hr?: string | number;
  openInterest?: string | number;
  startDate?: string;
  endDate?: string;
  markets?: EventMarket[];
};

const TAG_CATEGORY_MATCHERS: Array<{ category: DiscoveryMarketCategory; needles: string[] }> = [
  { category: 'politics', needles: ['politic', 'election', 'government', 'congress', 'senate', 'house'] },
  { category: 'macro', needles: ['economic', 'economy', 'macro', 'finance', 'fed', 'inflation', 'rates', 'jobs'] },
  { category: 'company', needles: ['company', 'companies', 'business', 'earnings', 'technology', 'tech'] },
  { category: 'legal', needles: ['legal', 'law', 'court', 'regulation', 'regulatory'] },
  { category: 'geopolitics', needles: ['world', 'geopolit', 'international', 'war', 'conflict'] },
  { category: 'entertainment', needles: ['culture', 'entertainment', 'celebrity', 'music', 'movie'] },
  { category: 'sports', needles: ['sport', 'sports'] },
  { category: 'crypto', needles: ['crypto', 'bitcoin', 'ethereum', 'solana', 'token'] },
];

const normalizeTokenIds = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value ?? '').trim()).filter(Boolean);
  }

  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => String(value ?? '').trim()).filter(Boolean);
      }
    } catch {
      return [raw.trim()].filter(Boolean);
    }
  }

  return [];
};

const normalizeOutcomes = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((value) => String(value ?? '').trim()).filter(Boolean);
};

const parseOptionalNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const buildTagSlugs = (tags: EventTag[] | undefined): string[] => {
  return (tags ?? [])
    .flatMap((tag) => [tag.slug, tag.label])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
};

export const deriveSeedCategory = (input: {
  title?: string;
  slug?: string;
  tags?: EventTag[];
}): DiscoveryMarketCategory => {
  const tagHaystack = buildTagSlugs(input.tags);
  for (const matcher of TAG_CATEGORY_MATCHERS) {
    if (tagHaystack.some((tag) => matcher.needles.some((needle) => tag.includes(needle)))) {
      return matcher.category;
    }
  }

  return classifyDiscoveryMarket({
    title: input.title,
    slug: input.slug,
  }).category ?? 'event';
};

export const buildDiscoveryMarketPoolEntries = (
  events: GammaEvent[],
  updatedAt: number,
): DiscoveryMarketPoolEntry[] => {
  const entries: DiscoveryMarketPoolEntry[] = [];

  for (const event of events) {
    const focusCategory = deriveSeedCategory({
      title: event.title,
      slug: event.slug,
      tags: event.tags,
    });

    if (focusCategory === 'crypto') {
      continue;
    }

    for (const market of event.markets ?? []) {
      if (!market.conditionId) continue;
      const tokenIds = normalizeTokenIds(market.clobTokenIds);
      if (tokenIds.length === 0) continue;

      entries.push({
        conditionId: market.conditionId,
        eventId: event.id ? String(event.id) : undefined,
        marketId: market.id ? String(market.id) : undefined,
        eventSlug: event.slug,
        slug: market.slug ?? event.slug,
        title: market.question ?? event.title,
        focusCategory,
        tagSlugs: buildTagSlugs(event.tags),
        tokenIds,
        outcomes: normalizeOutcomes(market.outcomes),
        liquidity: parseOptionalNumber(event.liquidity),
        volume24h: parseOptionalNumber(market.volume24hr ?? event.volume24hr),
        openInterest: parseOptionalNumber(event.openInterest),
        acceptingOrders: Boolean(market.acceptingOrders),
        competitive: Boolean(market.competitive),
        startDate: event.startDate,
        endDate: event.endDate,
        updatedAt,
      });
    }
  }

  return entries;
};

export const upsertDiscoveryMarketPoolEntries = (entries: DiscoveryMarketPoolEntry[]): void => {
  if (entries.length === 0) return;

  upsertMarketUniverseV2Entries(entries);

  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO discovery_market_pool (
      condition_id, event_id, market_id, event_slug, slug, title, focus_category, tag_slugs,
      token_ids, outcomes, liquidity, volume_24h, open_interest, accepting_orders,
      competitive, start_date, end_date, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(condition_id) DO UPDATE SET
      event_id = excluded.event_id,
      market_id = excluded.market_id,
      event_slug = excluded.event_slug,
      slug = excluded.slug,
      title = excluded.title,
      focus_category = excluded.focus_category,
      tag_slugs = excluded.tag_slugs,
      token_ids = excluded.token_ids,
      outcomes = excluded.outcomes,
      liquidity = excluded.liquidity,
      volume_24h = excluded.volume_24h,
      open_interest = excluded.open_interest,
      accepting_orders = excluded.accepting_orders,
      competitive = excluded.competitive,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction(() => {
    for (const entry of entries) {
      stmt.run(
        entry.conditionId,
        entry.eventId ?? null,
        entry.marketId ?? null,
        entry.eventSlug ?? null,
        entry.slug ?? null,
        entry.title ?? null,
        entry.focusCategory,
        JSON.stringify(entry.tagSlugs),
        JSON.stringify(entry.tokenIds),
        JSON.stringify(entry.outcomes ?? []),
        entry.liquidity ?? null,
        entry.volume24h ?? null,
        entry.openInterest ?? null,
        entry.acceptingOrders ? 1 : 0,
        entry.competitive ? 1 : 0,
        entry.startDate ?? null,
        entry.endDate ?? null,
        entry.updatedAt,
      );
    }
  });

  tx();
};

export const getDiscoveryMarketPool = (limit = 100): DiscoveryMarketPoolEntry[] => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT *
    FROM discovery_market_pool
    ORDER BY volume_24h DESC, updated_at DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    conditionId: String(row.condition_id),
    eventId: row.event_id ? String(row.event_id) : undefined,
    marketId: row.market_id ? String(row.market_id) : undefined,
    eventSlug: row.event_slug ? String(row.event_slug) : undefined,
    slug: row.slug ? String(row.slug) : undefined,
    title: row.title ? String(row.title) : undefined,
    focusCategory: String(row.focus_category) as DiscoveryMarketCategory,
    tagSlugs: JSON.parse(String(row.tag_slugs ?? '[]')) as string[],
    tokenIds: JSON.parse(String(row.token_ids ?? '[]')) as string[],
    outcomes: JSON.parse(String(row.outcomes ?? '[]')) as string[],
    liquidity: parseOptionalNumber(row.liquidity),
    volume24h: parseOptionalNumber(row.volume_24h),
    openInterest: parseOptionalNumber(row.open_interest),
    acceptingOrders: Boolean(row.accepting_orders),
    competitive: Boolean(row.competitive),
    startDate: row.start_date ? String(row.start_date) : undefined,
    endDate: row.end_date ? String(row.end_date) : undefined,
    updatedAt: Number(row.updated_at),
  }));
};
