import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('JungleAgentsStore');

export type JungleAgentRecord = {
  id: string;
  displayName: string;
  tagline?: string;
  modelLabel?: string;
  polymarketAddress: string;
  olympicsProfileUrl: string;
  avatarUrl?: string;
  sortOrder: number;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

const OLY_HOST = 'olympics.jungle.win';

const seedAgents: Omit<JungleAgentRecord, 'id' | 'createdAtMs' | 'updatedAtMs'>[] = [
  { displayName: 'Howler Monkey Herald', tagline: 'The Loud Scout', modelLabel: 'Gemini 2.5', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 1, enabled: true },
  { displayName: 'Silverback Sage', tagline: 'The Veteran Mind', modelLabel: 'Gemini 2.5', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 2, enabled: true },
  { displayName: 'Sabermetrician', tagline: 'The Numbers Mind', modelLabel: 'Gemini 2.5', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 3, enabled: true },
  { displayName: 'Veteran Backstop', tagline: "The Catcher's POV", modelLabel: 'Gemini 2.5', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 4, enabled: true },
  { displayName: 'Claude Slugger', tagline: 'The Diamond Mind', modelLabel: 'Claude Opus 4.6', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 5, enabled: true },
  { displayName: 'DeepSeek Knuckler', tagline: 'The Contrarian Bat', modelLabel: 'DeepSeek V3.2', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 6, enabled: true },
  { displayName: 'Gemini Laser', tagline: 'The Pitch Modeler', modelLabel: 'Gemini 3.1 Pro Preview', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 7, enabled: true },
  { displayName: 'Mistral Closer', tagline: 'The Late-Inning Pricer', modelLabel: 'Mistral Medium 3', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 8, enabled: true },
  { displayName: 'KING', tagline: 'The Aggregator', modelLabel: 'KING Aggregator', polymarketAddress: '', olympicsProfileUrl: `https://${OLY_HOST}/agents`, sortOrder: 9, enabled: true }
];

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
    sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : agents.length + 1,
    enabled: input.enabled !== false,
    createdAtMs: now,
    updatedAtMs: now
  };
  agents.push(rec);
  await saveAgentsFile(agents);
  return rec;
}

export async function updateAgent(id: string, patch: Partial<JungleAgentRecord>): Promise<JungleAgentRecord> {
  const agents = await loadAgentsFile();
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
    sortOrder: typeof patch.sortOrder === 'number' ? patch.sortOrder : cur.sortOrder,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    updatedAtMs: Date.now()
  };
  if (next.enabled && next.polymarketAddress && duplicateEnabledAddress(agents, next.polymarketAddress, id)) {
    throw new Error('Another enabled agent already uses this Polymarket address');
  }
  agents[idx] = next;
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
