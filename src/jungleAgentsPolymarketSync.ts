import { config } from './config.js';
import { createComponentLogger } from './logger.js';
import { JungleAgentRecord, loadAgentsFile, saveAgentsFile } from './jungleAgentsStore.js';

type GammaProfile = {
  name?: string;
  pseudonym?: string;
  proxyWallet?: string;
};

export type PolymarketAddressVerification = {
  address: string;
  hasActivity: boolean;
  portfolioValueUsd: number;
  isLikelyValid: boolean;
};

export type AgentAddressReconcileResult = {
  agentId: string;
  displayName: string;
  previousAddress: string;
  resolvedAddress: string | null;
  action: 'kept' | 'replaced' | 'cleared' | 'unresolved';
  reason: string;
};

const log = createComponentLogger('JungleAgentsPolymarketSync');
const GAMMA_SEARCH = `${config.polymarketGammaApiUrl.replace(/\/$/, '')}/public-search`;
const DATA_API = config.polymarketDataApiUrl.replace(/\/$/, '');

const normalizeName = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return row[b.length];
};

const searchTermsForAgent = (agent: JungleAgentRecord): string[] => {
  const terms = new Set<string>();
  const display = agent.displayName?.trim();
  if (display) {
    terms.add(display);
    terms.add(display.replace(/\s+/g, ''));
    terms.add(display.replace(/^Jungle\s+/i, 'JUNGLE'));
    terms.add(display.replace(/\s+/g, '').replace(/^Jungle/i, 'JUNGLE'));
    terms.add(`${display.replace(/\s+/g, '')}Agent`.replace(/^Jungle/i, 'JUNGLE'));
  }
  if (agent.polymarketUsername?.trim()) {
    terms.add(agent.polymarketUsername.trim());
    terms.add(agent.polymarketUsername.trim().replace(/^@/, ''));
  }
  if (agent.modelLabel?.trim()) {
    terms.add(agent.modelLabel.trim());
    terms.add(agent.modelLabel.trim().replace(/\s+/g, ''));
  }
  if (agent.slug === 'king') terms.add('KING Aggregator');
  if (agent.slug?.trim()) terms.add(agent.slug.trim());
  return [...terms];
};

const scoreProfileMatch = (agent: JungleAgentRecord, profile: GammaProfile): number => {
  const profileName = normalizeName(profile.name || '');
  if (!profileName || !profile.proxyWallet) return 0;

  const targets = searchTermsForAgent(agent).map(normalizeName).filter(Boolean);
  let best = 0;
  for (const target of targets) {
    if (!target) continue;
    if (profileName === target) best = Math.max(best, 100);
    else if (profileName.includes(target) || target.includes(profileName)) best = Math.max(best, 60);
    else if (target.length >= 8 && profileName.length >= 8 && levenshtein(profileName, target) <= 2) {
      best = Math.max(best, 85);
    }
  }
  return best;
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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ query, err: message }, 'Gamma profile search failed');
    return [];
  } finally {
    clearTimeout(timer);
  }
};

export const verifyPolymarketAddress = async (address: string): Promise<PolymarketAddressVerification> => {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    return { address: normalized, hasActivity: false, portfolioValueUsd: 0, isLikelyValid: false };
  }

  let hasActivity = false;
  let portfolioValueUsd = 0;

  try {
    const activityRes = await fetch(`${DATA_API}/activity?user=${normalized}&limit=1`);
    if (activityRes.ok) {
      const activity = await activityRes.json() as unknown[];
      hasActivity = Array.isArray(activity) && activity.length > 0;
    }
  } catch {
    /* non-fatal */
  }

  try {
    const valueRes = await fetch(`${DATA_API}/value?user=${normalized}`);
    if (valueRes.ok) {
      const valueRows = await valueRes.json() as Array<{ user?: string; value?: number }>;
      const row = Array.isArray(valueRows)
        ? valueRows.find((entry) => entry.user?.toLowerCase() === normalized) ?? valueRows[0]
        : null;
      const value = Number(row?.value);
      if (Number.isFinite(value)) portfolioValueUsd = value;
    }
  } catch {
    /* non-fatal */
  }

  return {
    address: normalized,
    hasActivity,
    portfolioValueUsd,
    isLikelyValid: hasActivity || portfolioValueUsd > 0,
  };
};

type RankedProfile = {
  profile: GammaProfile;
  score: number;
  verification: PolymarketAddressVerification;
};

const rankProfileCandidates = async (
  agent: JungleAgentRecord,
  profiles: GammaProfile[],
): Promise<string | null> => {
  const agentKey = normalizeName(agent.displayName);
  const ranked: RankedProfile[] = [];

  for (const profile of profiles) {
    const profileName = normalizeName(profile.name || '');
    if (profileName === 'jungle' && agentKey !== 'jungle') {
      continue;
    }
    const score = scoreProfileMatch(agent, profile);
    if (score < 60 || !profile.proxyWallet) continue;

    const verification = await verifyPolymarketAddress(profile.proxyWallet);
    ranked.push({ profile, score, verification });
  }

  ranked.sort((a, b) => {
    if (a.verification.isLikelyValid !== b.verification.isLikelyValid) {
      return a.verification.isLikelyValid ? -1 : 1;
    }
    return b.score - a.score;
  });

  const best = ranked[0];
  if (!best?.verification.isLikelyValid || !best.profile.proxyWallet) {
    return null;
  }

  return best.profile.proxyWallet.toLowerCase();
};

export const resolveAgentPolymarketProxy = async (agent: JungleAgentRecord): Promise<string | null> => {
  if (agent.polymarketUsername?.trim()) {
    const profiles = await fetchGammaProfiles(agent.polymarketUsername.trim());
    const usernameKey = normalizeName(agent.polymarketUsername);
    for (const profile of profiles) {
      if (!profile.proxyWallet) continue;
      const profileName = normalizeName(profile.name || '');
      if (profileName === usernameKey || profileName.includes(usernameKey) || usernameKey.includes(profileName)) {
        const verification = await verifyPolymarketAddress(profile.proxyWallet);
        if (verification.isLikelyValid) {
          return profile.proxyWallet.toLowerCase();
        }
      }
    }
  }

  const mergedProfiles: GammaProfile[] = [];
  for (const term of searchTermsForAgent(agent)) {
    const hits = await fetchGammaProfiles(term);
    for (const hit of hits) {
      if (hit.proxyWallet && !mergedProfiles.some((profile) => profile.proxyWallet === hit.proxyWallet)) {
        mergedProfiles.push(hit);
      }
    }
  }

  return rankProfileCandidates(agent, mergedProfiles);
};

/** Prefer stored address when it has real Polymarket activity; otherwise resolve proxy via Gamma. */
export const resolveCanonicalPolymarketAddress = async (
  agent: JungleAgentRecord,
  storedAddress?: string,
): Promise<{ address: string | null; source: 'stored' | 'gamma' | 'none' }> => {
  const stored = (storedAddress ?? agent.polymarketAddress ?? '').trim().toLowerCase();
  if (stored) {
    const verification = await verifyPolymarketAddress(stored);
    if (verification.isLikelyValid) {
      return { address: stored, source: 'stored' };
    }
  }

  const gammaAddress = await resolveAgentPolymarketProxy(agent);
  if (gammaAddress) {
    const verification = await verifyPolymarketAddress(gammaAddress);
    if (verification.isLikelyValid) {
      return { address: gammaAddress, source: 'gamma' };
    }
  }

  return { address: stored || null, source: 'none' };
};

export async function syncMissingAgentAddressesFromPolymarket(): Promise<{
  synced: number;
  skipped: number;
  unresolved: string[];
}> {
  const result = await reconcileAgentAddressesFromPolymarket({ onlyMissing: true });
  return {
    synced: result.replaced,
    skipped: result.kept + result.unresolved,
    unresolved: result.details.filter((row) => row.action === 'unresolved').map((row) => row.displayName),
  };
}

export async function reconcileAgentAddressesFromPolymarket(options?: {
  onlyMissing?: boolean;
  force?: boolean;
}): Promise<{
  kept: number;
  replaced: number;
  unresolved: number;
  details: AgentAddressReconcileResult[];
}> {
  const onlyMissing = options?.onlyMissing ?? false;
  const force = options?.force ?? false;
  const agents = await loadAgentsFile();
  const details: AgentAddressReconcileResult[] = [];
  let kept = 0;
  let replaced = 0;
  let unresolved = 0;
  const now = Date.now();

  for (const agent of agents) {
    if (!agent.enabled) continue;

    const previous = (agent.polymarketAddress || '').toLowerCase();

    if (onlyMissing && previous) {
      kept++;
      continue;
    }

    if (previous && !force) {
      const verification = await verifyPolymarketAddress(previous);
      if (verification.isLikelyValid) {
        details.push({
          agentId: agent.id,
          displayName: agent.displayName,
          previousAddress: previous,
          resolvedAddress: previous,
          action: 'kept',
          reason: 'Stored address has Polymarket activity or portfolio value',
        });
        kept++;
        continue;
      }
    }

    const resolved = await resolveCanonicalPolymarketAddress(agent, previous);
    const nextAddress = resolved.address;

    if (!nextAddress) {
      details.push({
        agentId: agent.id,
        displayName: agent.displayName,
        previousAddress: previous,
        resolvedAddress: null,
        action: 'unresolved',
        reason: 'No Polymarket profile match found',
      });
      unresolved++;
      continue;
    }

    if (nextAddress === previous) {
      details.push({
        agentId: agent.id,
        displayName: agent.displayName,
        previousAddress: previous,
        resolvedAddress: nextAddress,
        action: 'unresolved',
        reason: previous
          ? 'Stored address has no Polymarket activity and no better Gamma match was found'
          : 'No Polymarket profile match found',
      });
      unresolved++;
      continue;
    }

    const duplicate = agents.some((other) => (
      other.id !== agent.id &&
      other.enabled &&
      other.polymarketAddress?.toLowerCase() === nextAddress
    ));
    if (duplicate) {
      details.push({
        agentId: agent.id,
        displayName: agent.displayName,
        previousAddress: previous,
        resolvedAddress: nextAddress,
        action: 'unresolved',
        reason: 'Resolved proxy wallet already assigned to another enabled agent',
      });
      unresolved++;
      continue;
    }

    agent.polymarketAddress = nextAddress;
    agent.updatedAtMs = now;
    replaced++;
    details.push({
      agentId: agent.id,
      displayName: agent.displayName,
      previousAddress: previous,
      resolvedAddress: nextAddress,
      action: 'replaced',
      reason: resolved.source === 'gamma'
        ? 'Replaced inactive address with verified Polymarket proxy wallet from profile search'
        : 'Updated address',
    });
    log.info(
      { agentId: agent.id, slug: agent.slug, previous, nextAddress, source: resolved.source },
      'Reconciled Jungle Agent Polymarket address',
    );
  }

  if (replaced > 0) {
    await saveAgentsFile(agents);
  }

  return { kept, replaced, unresolved, details };
}
