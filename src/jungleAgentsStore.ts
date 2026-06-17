import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config.js';
import { createComponentLogger } from './logger.js';
import { Storage } from './storage.js';
import { assertDiskWritable } from './diskGuard.js';

const log = createComponentLogger('JungleAgentsStore');

type LegacyOlympicsAgent = { id: string; displayName: string; walletAddress: string };

export const JUNGLE_AGENT_CATEGORIES = [
  'sports',
  'politics',
  'crypto',
  'macro',
  'company',
  'legal',
  'geopolitics',
  'entertainment',
  'event',
  'other',
] as const;

export type JungleAgentCategory = (typeof JUNGLE_AGENT_CATEGORIES)[number];

export type JungleAgentRecord = {
  id: string;
  /** Stable slug aligned with legacy Olympics roster ids (migration + public API). */
  slug?: string;
  displayName: string;
  tagline?: string;
  modelLabel?: string;
  polymarketAddress: string;
  /** Polymarket @username used for exact proxy-wallet lookup (e.g. junglekingagent). */
  polymarketUsername?: string;
  /** MetaMask / login EOA from ops spreadsheet — not used for trade monitoring. */
  loginWalletAddress?: string;
  olympicsProfileUrl: string;
  avatarUrl?: string;
  /** Market focus shown to users (sports, politics, crypto, …). */
  category?: JungleAgentCategory;
  /** Named group for curation (e.g. "MLB Opening Week"). Free text, ≤60 chars. */
  collection?: string;
  sortOrder: number;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

const OLY_HOST = 'olympics.jungle.win';

const seedAgents: Omit<JungleAgentRecord, 'id' | 'createdAtMs' | 'updatedAtMs'>[] = [
  { slug: 'howler-monkey-herald', displayName: 'Howler Monkey Herald', tagline: 'The Loud Scout', modelLabel: 'Gemini 2.5', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 1, enabled: true },
  { slug: 'silverback-sage', displayName: 'Silverback Sage', tagline: 'The Veteran Mind', modelLabel: 'Gemini 2.5', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 2, enabled: true },
  { slug: 'sabermetrician', displayName: 'Sabermetrician', tagline: 'The Numbers Mind', modelLabel: 'Gemini 2.5', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 3, enabled: true },
  { slug: 'veteran-backstop', displayName: 'Veteran Backstop', tagline: "The Catcher's POV", modelLabel: 'Gemini 2.5', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 4, enabled: true },
  { slug: 'claude-slugger', displayName: 'Claude Slugger', tagline: 'The Diamond Mind', modelLabel: 'Claude Opus 4.6', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 5, enabled: true },
  { slug: 'deepseek-knuckler', displayName: 'DeepSeek Knuckler', tagline: 'The Contrarian Bat', modelLabel: 'DeepSeek V3.2', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 6, enabled: true },
  { slug: 'gemini-laser', displayName: 'Gemini Laser', tagline: 'The Pitch Modeler', modelLabel: 'Gemini 3.1 Pro Preview', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 7, enabled: true },
  { slug: 'mistral-closer', displayName: 'Mistral Closer', tagline: 'The Late-Inning Pricer', modelLabel: 'Mistral Medium 3', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 8, enabled: true },
  { slug: 'king', displayName: 'KING', tagline: 'The Aggregator', modelLabel: 'KING Aggregator', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 9, enabled: true }
];

const slugByDisplayName = new Map(seedAgents.map((s) => [s.displayName.toLowerCase(), s.slug!]));

export const inferAgentSlug = (displayName: string): string | undefined =>
  slugByDisplayName.get(displayName.trim().toLowerCase());

const agentsFilePath = (): string => path.join(config.dataDir, 'jungle_agents.json');

const assertOlympicsUrl = (url: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid olympicsProfileUrl');
  }
  if (parsed.hostname.toLowerCase() !== OLY_HOST) {
    throw new Error(`olympicsProfileUrl must use hostname ${OLY_HOST}`);
  }
};

const assertEvmOptional = (addr: string): void => {
  if (!addr) return;
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    throw new Error('Invalid polymarketAddress');
  }
};

const assertDisplayName = (name: string): void => {
  const t = name?.trim();
  if (!t) throw new Error('displayName is required');
  if (t.length > 80) throw new Error('displayName too long');
};

/** Returns the normalized category, or undefined for empty input. Throws on unknown values. */
const normalizeCategory = (value: unknown): JungleAgentCategory | undefined => {
  const t = String(value ?? '').trim().toLowerCase();
  if (!t) return undefined;
  if (!(JUNGLE_AGENT_CATEGORIES as readonly string[]).includes(t)) {
    throw new Error(`Invalid category "${t}" — allowed: ${JUNGLE_AGENT_CATEGORIES.join(', ')}`);
  }
  return t as JungleAgentCategory;
};

/** Returns the trimmed collection name, or undefined for empty input. Throws when too long. */
const normalizeCollection = (value: unknown): string | undefined => {
  const t = String(value ?? '').trim();
  if (!t) return undefined;
  if (t.length > 60) throw new Error('collection too long (max 60 characters)');
  return t;
};

const duplicateEnabledAddress = (agents: JungleAgentRecord[], address: string, selfId?: string): boolean => {
  if (!address) return false;
  const lower = address.toLowerCase();
  return agents.some(
    (a) =>
      a.enabled &&
      a.polymarketAddress &&
      a.polymarketAddress.toLowerCase() === lower &&
      a.id !== selfId
  );
};

export const buildSeedRecords = (): JungleAgentRecord[] => {
  const now = Date.now();
  return seedAgents.map((s, i) => ({
    ...s,
    id: randomUUID(),
    sortOrder: i + 1,
    createdAtMs: now,
    updatedAtMs: now
  }));
};

export async function loadAgentsFile(): Promise<JungleAgentRecord[]> {
  const file = agentsFilePath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as JungleAgentRecord[];
    if (!Array.isArray(parsed)) return buildSeedRecords();
    return parsed;
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      const seeded = buildSeedRecords();
      await saveAgentsFile(seeded);
      log.info({ file }, 'Created jungle_agents.json with seed roster');
      return seeded;
    }
    log.error({ err: e }, 'Failed to read jungle_agents.json');
    throw e;
  }
}

export async function saveAgentsFile(agents: JungleAgentRecord[]): Promise<void> {
  const file = agentsFilePath();
  assertDiskWritable(path.dirname(file));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(agents, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export async function listEnabledAgents(): Promise<JungleAgentRecord[]> {
  const all = await loadAgentsFile();
  return all.filter((a) => a.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function getAgentById(id: string): Promise<JungleAgentRecord | undefined> {
  const all = await loadAgentsFile();
  return all.find((a) => a.id === id);
}

export async function createAgent(input: Partial<JungleAgentRecord>): Promise<JungleAgentRecord> {
  assertDisplayName(String(input.displayName || ''));
  const olympicsProfileUrl = String(input.olympicsProfileUrl || '').trim();
  assertOlympicsUrl(olympicsProfileUrl);
  const polymarketAddress = String(input.polymarketAddress ?? '').trim();
  assertEvmOptional(polymarketAddress);
  const agents = await loadAgentsFile();
  if (polymarketAddress && input.enabled !== false && duplicateEnabledAddress(agents, polymarketAddress)) {
    throw new Error('Another enabled agent already uses this Polymarket address');
  }
  const now = Date.now();
  const rec: JungleAgentRecord = {
    id: randomUUID(),
    displayName: input.displayName!.trim(),
    tagline: input.tagline?.trim() || undefined,
    modelLabel: input.modelLabel?.trim() || undefined,
    polymarketAddress,
    olympicsProfileUrl,
    avatarUrl: input.avatarUrl?.trim() || undefined,
    category: normalizeCategory(input.category),
    collection: normalizeCollection(input.collection),
    sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : agents.length + 1,
    enabled: input.enabled !== false,
    createdAtMs: now,
    updatedAtMs: now
  };
  agents.push(rec);
  await saveAgentsFile(agents);
  return rec;
}

const applyAgentPatch = (
  agents: JungleAgentRecord[],
  id: string,
  patch: Partial<JungleAgentRecord>
): JungleAgentRecord => {
  const idx = agents.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error('Agent not found');
  const cur = agents[idx];
  if (patch.displayName !== undefined) assertDisplayName(String(patch.displayName));
  if (patch.olympicsProfileUrl !== undefined) assertOlympicsUrl(String(patch.olympicsProfileUrl).trim());
  if (patch.polymarketAddress !== undefined) assertEvmOptional(String(patch.polymarketAddress).trim());

  const next: JungleAgentRecord = {
    ...cur,
    displayName: patch.displayName !== undefined ? String(patch.displayName).trim() : cur.displayName,
    tagline: patch.tagline !== undefined ? patch.tagline?.trim() || undefined : cur.tagline,
    modelLabel: patch.modelLabel !== undefined ? patch.modelLabel?.trim() || undefined : cur.modelLabel,
    polymarketAddress:
      patch.polymarketAddress !== undefined ? String(patch.polymarketAddress).trim() : cur.polymarketAddress,
    olympicsProfileUrl:
      patch.olympicsProfileUrl !== undefined ? String(patch.olympicsProfileUrl).trim() : cur.olympicsProfileUrl,
    avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl?.trim() || undefined : cur.avatarUrl,
    category: patch.category !== undefined ? normalizeCategory(patch.category) : cur.category,
    collection: patch.collection !== undefined ? normalizeCollection(patch.collection) : cur.collection,
    sortOrder: typeof patch.sortOrder === 'number' ? patch.sortOrder : cur.sortOrder,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    updatedAtMs: Date.now(),
  };
  if (next.enabled && next.polymarketAddress && duplicateEnabledAddress(agents, next.polymarketAddress, id)) {
    throw new Error('Another enabled agent already uses this Polymarket address');
  }
  agents[idx] = next;
  return next;
};

export async function updateAgent(id: string, patch: Partial<JungleAgentRecord>): Promise<JungleAgentRecord> {
  const agents = await loadAgentsFile();
  const next = applyAgentPatch(agents, id, patch);
  await saveAgentsFile(agents);
  return next;
}

export async function deleteAgent(id: string): Promise<void> {
  const agents = await loadAgentsFile();
  const next = agents.filter((a) => a.id !== id);
  if (next.length === agents.length) throw new Error('Agent not found');
  await saveAgentsFile(next);
}

export async function reorderAgents(orderedIds: string[]): Promise<JungleAgentRecord[]> {
  const agents = await loadAgentsFile();
  const byId = new Map(agents.map((a) => [a.id, a]));
  let order = 1;
  for (const id of orderedIds) {
    const a = byId.get(id);
    if (a) {
      a.sortOrder = order++;
      a.updatedAtMs = Date.now();
    }
  }
  await saveAgentsFile(agents);
  return [...agents].sort((a, b) => a.sortOrder - b.sortOrder);
}

export type BulkAddressUpdate = { id: string; polymarketAddress: string };

export async function bulkUpdateAgents(updates: Array<Partial<JungleAgentRecord> & { id: string }>): Promise<JungleAgentRecord[]> {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('updates must be a non-empty array');
  }
  const agents = await loadAgentsFile();
  for (const row of updates) {
    const { id, ...patch } = row;
    applyAgentPatch(agents, id, patch);
  }
  await saveAgentsFile(agents);
  return [...agents].sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function bulkUpdateAddresses(updates: BulkAddressUpdate[]): Promise<JungleAgentRecord[]> {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('updates must be a non-empty array');
  }
  const agents = await loadAgentsFile();
  const byId = new Map(agents.map((a) => [a.id, a]));
  const staged = new Map<string, string>();

  for (const row of updates) {
    const id = String(row.id || '').trim();
    if (!id || !byId.has(id)) throw new Error(`Agent not found: ${id}`);
    const addr = String(row.polymarketAddress ?? '').trim();
    assertEvmOptional(addr);
    staged.set(id, addr);
  }

  for (const [id, addr] of staged) {
    const agent = byId.get(id)!;
    const enabled = agent.enabled;
    if (addr && enabled && duplicateEnabledAddress(agents, addr, id)) {
      throw new Error(`Another enabled agent already uses address ${addr}`);
    }
  }

  const now = Date.now();
  for (const [id, addr] of staged) {
    const agent = byId.get(id)!;
    agent.polymarketAddress = addr;
    agent.updatedAtMs = now;
  }
  await saveAgentsFile(agents);
  return [...agents].sort((a, b) => a.sortOrder - b.sortOrder);
}

const matchOlympicsToJungle = (jungle: JungleAgentRecord, olympics: LegacyOlympicsAgent): boolean => {
  const oId = olympics.id.trim().toLowerCase();
  const oName = olympics.displayName.trim().toLowerCase();
  if (jungle.slug && jungle.slug.toLowerCase() === oId) return true;
  const inferred = inferAgentSlug(jungle.displayName);
  if (inferred && inferred.toLowerCase() === oId) return true;
  return jungle.displayName.trim().toLowerCase() === oName;
};

/** One-time merge from legacy config.olympicsAgents — never overwrites non-empty jungle addresses. */
export async function migrateOlympicsConfigToJungleStore(): Promise<{ merged: number; conflicts: number; skipped: number }> {
  const cfg = await Storage.loadConfig();
  const raw = cfg.olympicsAgents;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { merged: 0, conflicts: 0, skipped: 0 };
  }

  const agents = await loadAgentsFile();
  let merged = 0;
  let conflicts = 0;
  let skipped = 0;
  const now = Date.now();

  for (const row of raw as LegacyOlympicsAgent[]) {
    if (!row || typeof row !== 'object') continue;
    const wallet = String(row.walletAddress || '').trim();
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      skipped++;
      continue;
    }
    const lowerWallet = wallet.toLowerCase();
    const target = agents.find((a) => matchOlympicsToJungle(a, row));
    if (!target) {
      log.warn({ olympicsId: row.id, displayName: row.displayName }, 'Olympics migration: no jungle agent match');
      skipped++;
      continue;
    }
    if (!target.slug && row.id) {
      target.slug = row.id.trim().toLowerCase();
    }
    if (target.polymarketAddress) {
      if (target.polymarketAddress.toLowerCase() !== lowerWallet) {
        log.warn(
          { agentId: target.id, slug: target.slug, existing: target.polymarketAddress, olympics: lowerWallet },
          'Olympics migration conflict: jungle address kept'
        );
        conflicts++;
      } else {
        skipped++;
      }
      continue;
    }
    target.polymarketAddress = lowerWallet;
    target.updatedAtMs = now;
    merged++;
    log.info({ agentId: target.id, slug: target.slug }, 'Olympics migration: merged wallet address');
  }

  if (merged > 0 || conflicts > 0) {
    await saveAgentsFile(agents);
  }
  if (merged > 0 || conflicts > 0) {
    log.info({ merged, conflicts, skipped }, 'Olympics → jungle_agents migration complete');
  }
  return { merged, conflicts, skipped };
}

/** Alias for tests and callers that prefer the shorter name. */
export const loadAgents = loadAgentsFile;

/** Ensure `jungle_agents.json` exists (writes seed roster on first run). */
export async function seedJungleAgentsIfMissing(): Promise<void> {
  await loadAgentsFile();
}

export async function __dangerousReplaceAgentsForTests(agents: JungleAgentRecord[]): Promise<void> {
  await saveAgentsFile(agents);
}

export function validateOlympicsProfileUrl(url: string): boolean {
  try {
    assertOlympicsUrl(url);
    return true;
  } catch {
    return false;
  }
}

export function validatePolymarketAddress(addr: string): boolean {
  try {
    assertEvmOptional(addr);
    return true;
  } catch {
    return false;
  }
}
