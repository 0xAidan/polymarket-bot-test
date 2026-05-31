import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('JungleAgentsStore');
const OLY_HOST = 'olympics.jungle.win';

type SeedAgent = {
  slug: string;
  displayName: string;
  tagline?: string;
  modelLabel?: string;
  category?: string;
};

const seedAgents: SeedAgent[] = [
  { slug: 'howler-monkey-herald', displayName: 'Howler Monkey Herald', tagline: 'The Loud Scout', modelLabel: 'Gemini 2.5', category: 'Baseball' },
  { slug: 'silverback-sage', displayName: 'Silverback Sage', tagline: 'The Veteran Mind', modelLabel: 'Gemini 2.5', category: 'Baseball' },
  { slug: 'sabermetrician', displayName: 'Sabermetrician', tagline: 'The Numbers Mind', modelLabel: 'Gemini 2.5', category: 'Baseball' },
  { slug: 'veteran-backstop', displayName: 'Veteran Backstop', tagline: "The Catcher's POV", modelLabel: 'Gemini 2.5', category: 'Baseball' },
  { slug: 'claude-slugger', displayName: 'Claude Slugger', tagline: 'The Diamond Mind', modelLabel: 'Claude Opus 4.6', category: 'Baseball' },
  { slug: 'deepseek-knuckler', displayName: 'DeepSeek Knuckler', tagline: 'The Contrarian Bat', modelLabel: 'DeepSeek V3.2', category: 'Baseball' },
  { slug: 'gemini-laser', displayName: 'Gemini Laser', tagline: 'The Pitch Modeler', modelLabel: 'Gemini 3.1 Pro Preview', category: 'Baseball' },
  { slug: 'mistral-closer', displayName: 'Mistral Closer', tagline: 'The Late-Inning Pricer', modelLabel: 'Mistral Medium 3', category: 'Baseball' },
  { slug: 'king', displayName: 'KING', tagline: 'The Aggregator', modelLabel: 'KING Aggregator', category: 'Core' }
];

const slugByDisplayName = new Map(seedAgents.map((seed) => [seed.displayName.toLowerCase(), seed.slug]));

export interface JungleAgent {
  id: string;
  slug?: string;
  displayName: string;
  tagline?: string;
  modelLabel?: string;
  category?: string;
  polymarketAddress: string;
  olympicsProfileUrl: string;
  avatarUrl?: string;
  sortOrder: number;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

type JungleAgentInput = {
  slug?: string;
  displayName: string;
  tagline?: string;
  modelLabel?: string;
  category?: string;
  polymarketAddress?: string;
  olympicsProfileUrl?: string;
  avatarUrl?: string;
  sortOrder?: number;
  enabled?: boolean;
};

type JungleAgentPatch = Partial<JungleAgentInput>;

type BulkAddressUpdate = {
  id: string;
  polymarketAddress?: string;
};

type BulkAgentPatch = {
  id: string;
} & JungleAgentPatch;

const inferDefaultOlympicsProfileUrl = (): string => `https://${OLY_HOST}/agents`;

const agentsFilePath = (): string => path.join(config.dataDir, 'jungle_agents.json');

const getSeedAvatarUrl = (slug: string): string => `https://cdn.jungle.win/agents/${slug}.png`;

const normalizeCategory = (category: string | undefined): string | undefined => {
  const value = String(category || '').trim();
  return value ? value : undefined;
};

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
  const trimmed = name.trim();
  if (!trimmed) throw new Error('displayName is required');
  if (trimmed.length > 80) throw new Error('displayName too long');
};

const assertCategory = (category: string | undefined): void => {
  if (!category) return;
  if (category.length > 50) throw new Error('category too long');
};

const assertAvatarUrl = (url: string | undefined): void => {
  if (!url) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid avatarUrl');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('avatarUrl must use http:// or https://');
  }
};

const duplicateEnabledAddress = (agents: JungleAgent[], address: string, selfId?: string): boolean => {
  if (!address) return false;
  const lower = address.toLowerCase();
  return agents.some((agent) => (
    agent.enabled &&
    agent.polymarketAddress &&
    agent.polymarketAddress.toLowerCase() === lower &&
    agent.id !== selfId
  ));
};

export const inferAgentSlug = (displayName: string): string | undefined => {
  return slugByDisplayName.get(displayName.trim().toLowerCase());
};

export const buildSeedRecords = (): JungleAgent[] => {
  const now = Date.now();
  return seedAgents.map((seed, index) => ({
    id: randomUUID(),
    slug: seed.slug,
    displayName: seed.displayName,
    tagline: seed.tagline,
    modelLabel: seed.modelLabel,
    category: seed.category,
    polymarketAddress: '',
    olympicsProfileUrl: inferDefaultOlympicsProfileUrl(),
    avatarUrl: getSeedAvatarUrl(seed.slug),
    sortOrder: index + 1,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now
  }));
};

export async function loadAgentsFile(): Promise<JungleAgent[]> {
  const file = agentsFilePath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return buildSeedRecords();
    return parsed;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      const seeded = buildSeedRecords();
      await saveAgentsFile(seeded);
      log.info({ file }, 'Created jungle_agents.json with seed roster');
      return seeded;
    }
    log.error({ err: error }, 'Failed to read jungle_agents.json');
    throw error;
  }
}

export async function saveAgentsFile(agents: JungleAgent[]): Promise<void> {
  const file = agentsFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(agents, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export async function listEnabledAgents(): Promise<JungleAgent[]> {
  const all = await loadAgentsFile();
  return all.filter((agent) => agent.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function listAgentCategories(): Promise<string[]> {
  const all = await loadAgentsFile();
  return [...new Set(all.map((agent) => normalizeCategory(agent.category)).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b));
}

export async function getAgentById(id: string): Promise<JungleAgent | undefined> {
  const all = await loadAgentsFile();
  return all.find((agent) => agent.id === id);
}

export async function createAgent(input: JungleAgentInput): Promise<JungleAgent> {
  assertDisplayName(String(input.displayName || ''));
  const olympicsProfileUrl = String(input.olympicsProfileUrl || inferDefaultOlympicsProfileUrl()).trim();
  assertOlympicsUrl(olympicsProfileUrl);

  const polymarketAddress = String(input.polymarketAddress ?? '').trim();
  assertEvmOptional(polymarketAddress);

  const category = normalizeCategory(input.category);
  assertCategory(category);
  assertAvatarUrl(input.avatarUrl?.trim());

  const agents = await loadAgentsFile();
  if (polymarketAddress && input.enabled !== false && duplicateEnabledAddress(agents, polymarketAddress)) {
    throw new Error('Another enabled agent already uses this Polymarket address');
  }

  const now = Date.now();
  const record: JungleAgent = {
    id: randomUUID(),
    slug: input.slug?.trim() || inferAgentSlug(input.displayName) || undefined,
    displayName: input.displayName.trim(),
    tagline: input.tagline?.trim() || undefined,
    modelLabel: input.modelLabel?.trim() || undefined,
    category,
    polymarketAddress,
    olympicsProfileUrl,
    avatarUrl: input.avatarUrl?.trim() || undefined,
    sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : agents.length + 1,
    enabled: input.enabled !== false,
    createdAtMs: now,
    updatedAtMs: now
  };

  agents.push(record);
  await saveAgentsFile(agents);
  return record;
}

export async function updateAgent(id: string, patch: JungleAgentPatch): Promise<JungleAgent> {
  const agents = await loadAgentsFile();
  const index = agents.findIndex((agent) => agent.id === id);
  if (index < 0) throw new Error('Agent not found');

  const current = agents[index];
  if (patch.displayName !== undefined) assertDisplayName(String(patch.displayName));
  if (patch.olympicsProfileUrl !== undefined) assertOlympicsUrl(String(patch.olympicsProfileUrl).trim());
  if (patch.polymarketAddress !== undefined) assertEvmOptional(String(patch.polymarketAddress).trim());
  if (patch.category !== undefined) assertCategory(normalizeCategory(String(patch.category)));
  if (patch.avatarUrl !== undefined) assertAvatarUrl(patch.avatarUrl?.trim());

  const next: JungleAgent = {
    ...current,
    slug: patch.slug !== undefined ? String(patch.slug || '').trim() || undefined : current.slug,
    displayName: patch.displayName !== undefined ? String(patch.displayName).trim() : current.displayName,
    tagline: patch.tagline !== undefined ? patch.tagline?.trim() || undefined : current.tagline,
    modelLabel: patch.modelLabel !== undefined ? patch.modelLabel?.trim() || undefined : current.modelLabel,
    category: patch.category !== undefined ? normalizeCategory(String(patch.category)) : current.category,
    polymarketAddress: patch.polymarketAddress !== undefined ? String(patch.polymarketAddress).trim() : current.polymarketAddress,
    olympicsProfileUrl: patch.olympicsProfileUrl !== undefined ? String(patch.olympicsProfileUrl).trim() : current.olympicsProfileUrl,
    avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl?.trim() || undefined : current.avatarUrl,
    sortOrder: typeof patch.sortOrder === 'number' ? patch.sortOrder : current.sortOrder,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    updatedAtMs: Date.now()
  };

  if (next.enabled && next.polymarketAddress && duplicateEnabledAddress(agents, next.polymarketAddress, id)) {
    throw new Error('Another enabled agent already uses this Polymarket address');
  }

  agents[index] = next;
  await saveAgentsFile(agents);
  return next;
}

export async function deleteAgent(id: string): Promise<void> {
  const agents = await loadAgentsFile();
  const next = agents.filter((agent) => agent.id !== id);
  if (next.length === agents.length) throw new Error('Agent not found');
  await saveAgentsFile(next);
}

export async function reorderAgents(orderedIds: string[]): Promise<JungleAgent[]> {
  const agents = await loadAgentsFile();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  let order = 1;
  for (const id of orderedIds) {
    const agent = byId.get(id);
    if (!agent) continue;
    agent.sortOrder = order++;
    agent.updatedAtMs = Date.now();
  }
  await saveAgentsFile(agents);
  return [...agents].sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function bulkUpdateAgents(updates: BulkAgentPatch[]): Promise<JungleAgent[]> {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('updates must be a non-empty array');
  }
  for (const row of updates) {
    const { id, ...patch } = row;
    await updateAgent(id, patch);
  }
  return [...(await loadAgentsFile())].sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function bulkUpdateAddresses(updates: BulkAddressUpdate[]): Promise<JungleAgent[]> {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('updates must be a non-empty array');
  }
  const agents = await loadAgentsFile();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const staged = new Map<string, string>();

  for (const row of updates) {
    const id = String(row.id || '').trim();
    if (!id || !byId.has(id)) throw new Error(`Agent not found: ${id}`);
    const address = String(row.polymarketAddress ?? '').trim();
    assertEvmOptional(address);
    staged.set(id, address);
  }

  for (const [id, address] of staged) {
    const agent = byId.get(id)!;
    if (address && agent.enabled && duplicateEnabledAddress(agents, address, id)) {
      throw new Error(`Another enabled agent already uses address ${address}`);
    }
  }

  const now = Date.now();
  for (const [id, address] of staged) {
    const agent = byId.get(id)!;
    agent.polymarketAddress = address;
    agent.updatedAtMs = now;
  }

  await saveAgentsFile(agents);
  return [...agents].sort((a, b) => a.sortOrder - b.sortOrder);
}
