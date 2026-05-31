import { config } from './config.js';
import { createComponentLogger } from './logger.js';
import { JungleAgentRecord, loadAgentsFile, saveAgentsFile } from './jungleAgentsStore.js';

type GammaProfile = {
  name?: string;
  proxyWallet?: string;
};

const log = createComponentLogger('JungleAgentsPolymarketSync');
const GAMMA_SEARCH = `${config.polymarketGammaApiUrl.replace(/\/$/, '')}/public-search`;

const normalizeName = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

const searchTermsForAgent = (agent: JungleAgentRecord): string[] => {
  const terms = new Set<string>();
  if (agent.displayName?.trim()) terms.add(agent.displayName.trim());
  if (agent.modelLabel?.trim()) terms.add(agent.modelLabel.trim());
  if (agent.slug === 'king') terms.add('KING Aggregator');
  return [...terms];
};

const pickProfileAddress = (agent: JungleAgentRecord, profiles: GammaProfile[]): string | null => {
  const targets = searchTermsForAgent(agent).map(normalizeName).filter(Boolean);
  if (!targets.length || !profiles.length) return null;

  for (const target of targets) {
    const exact = profiles.find((profile) => normalizeName(profile.name || '') === target);
    if (exact?.proxyWallet) return exact.proxyWallet.toLowerCase();
  }

  // Avoid fuzzy matching short generic names ("KING", etc).
  const allowPartial = targets.every((target) => target.length >= 8);
  if (!allowPartial) return null;

  for (const target of targets) {
    const partial = profiles.find((profile) => {
      const name = normalizeName(profile.name || '');
      return name.includes(target) || target.includes(name);
    });
    if (partial?.proxyWallet) return partial.proxyWallet.toLowerCase();
  }
  return null;
};

const fetchGammaProfiles = async (query: string): Promise<GammaProfile[]> => {
  const params = new URLSearchParams({ q: query, search_profiles: 'true' });
  const url = `${GAMMA_SEARCH}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const body = await response.json() as { profiles?: GammaProfile[] };
    return body.profiles ?? [];
  } catch (error: any) {
    log.warn({ query, err: error?.message || String(error) }, 'Gamma profile search failed');
    return [];
  } finally {
    clearTimeout(timer);
  }
};

const resolveAgentAddress = async (agent: JungleAgentRecord): Promise<string | null> => {
  const mergedProfiles: GammaProfile[] = [];
  for (const term of searchTermsForAgent(agent)) {
    const hits = await fetchGammaProfiles(term);
    for (const hit of hits) {
      if (hit.proxyWallet && !mergedProfiles.some((profile) => profile.proxyWallet === hit.proxyWallet)) {
        mergedProfiles.push(hit);
      }
    }
    const picked = pickProfileAddress(agent, mergedProfiles);
    if (picked) return picked;
  }
  return null;
};

export async function syncMissingAgentAddressesFromPolymarket(): Promise<{
  synced: number;
  skipped: number;
  unresolved: string[];
}> {
  const agents = await loadAgentsFile();
  let synced = 0;
  let skipped = 0;
  const unresolved: string[] = [];
  const now = Date.now();

  for (const agent of agents) {
    if (agent.polymarketAddress) {
      skipped++;
      continue;
    }

    const address = await resolveAgentAddress(agent);
    if (!address) {
      unresolved.push(agent.displayName);
      continue;
    }

    const duplicate = agents.some((other) => (
      other.id !== agent.id &&
      other.enabled &&
      other.polymarketAddress?.toLowerCase() === address
    ));
    if (duplicate) {
      log.warn({ agentId: agent.id, address }, 'Skipped Polymarket sync — address already assigned');
      unresolved.push(agent.displayName);
      continue;
    }

    agent.polymarketAddress = address;
    agent.updatedAtMs = now;
    synced++;
    log.info({ agentId: agent.id, slug: agent.slug, address }, 'Synced Jungle Agent address from Polymarket');
  }

  if (synced > 0) {
    await saveAgentsFile(agents);
  }
  return { synced, skipped, unresolved };
}
