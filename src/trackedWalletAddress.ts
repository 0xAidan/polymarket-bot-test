import { config } from './config.js';
import { createComponentLogger } from './logger.js';
import { verifyPolymarketAddress, type PolymarketAddressVerification } from './jungleAgentsPolymarketSync.js';

const log = createComponentLogger('TrackedWalletAddress');

const DATA_API = config.polymarketDataApiUrl.replace(/\/$/, '');
const GAMMA_SEARCH = config.polymarketGammaApiUrl.replace(/\/$/, '') + '/public-search';

export type ParsedPolymarketInput =
  | { kind: 'address'; value: string }
  | { kind: 'username'; value: string };

export type ResolvedTrackedWallet = {
  input: string;
  monitoringAddress: string;
  source: 'direct' | 'proxy' | 'gamma_username';
  verification: PolymarketAddressVerification;
};

type GammaProfile = {
  name?: string;
  proxyWallet?: string;
};

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export const parsePolymarketWalletInput = (rawInput: string): ParsedPolymarketInput | null => {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  if (EVM_ADDRESS_RE.test(trimmed)) {
    return { kind: 'address', value: trimmed.toLowerCase() };
  }

  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;

  if (/^[a-zA-Z0-9_-]{2,64}$/.test(withoutAt) && !withoutAt.startsWith('0x')) {
    return { kind: 'username', value: withoutAt.toLowerCase() };
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (!host.includes('polymarket.com')) {
      return null;
    }

    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length === 0) return null;

    const profileIndex = pathParts[0] === 'profile' ? 1 : 0;
    const segment = pathParts[profileIndex];
    if (!segment) return null;

    const profileSegment = segment.startsWith('@') ? segment.slice(1) : segment;
    if (EVM_ADDRESS_RE.test(profileSegment)) {
      return { kind: 'address', value: profileSegment.toLowerCase() };
    }

    if (/^[a-zA-Z0-9_-]{2,64}$/.test(profileSegment)) {
      return { kind: 'username', value: profileSegment.toLowerCase() };
    }
  } catch {
    return null;
  }

  return null;
};

const fetchGammaProfiles = async (query: string): Promise<GammaProfile[]> => {
  const params = new URLSearchParams({ q: query, search_profiles: 'true' });
  const url = GAMMA_SEARCH + '?' + params.toString();
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

const fetchProxyFromPositions = async (address: string): Promise<string | null> => {
  try {
    const response = await fetch(DATA_API + '/positions?user=' + address.toLowerCase() + '&limit=1');
    if (!response.ok) return null;
    const positions = await response.json() as Array<{ proxyWallet?: string }>;
    const proxyWallet = positions[0]?.proxyWallet;
    return typeof proxyWallet === 'string' ? proxyWallet.toLowerCase() : null;
  } catch {
    return null;
  }
};

const resolveUsernameToProxy = async (username: string): Promise<string | null> => {
  const profiles = await fetchGammaProfiles(username);
  const normalizedUsername = username.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const profile of profiles) {
    if (!profile.proxyWallet) continue;
    const profileName = (profile.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      profileName === normalizedUsername
      || profileName.includes(normalizedUsername)
      || normalizedUsername.includes(profileName)
    ) {
      const verification = await verifyPolymarketAddress(profile.proxyWallet);
      if (verification.isLikelyValid) {
        return profile.proxyWallet.toLowerCase();
      }
    }
  }

  for (const profile of profiles) {
    if (!profile.proxyWallet) continue;
    const verification = await verifyPolymarketAddress(profile.proxyWallet);
    if (verification.isLikelyValid) {
      return profile.proxyWallet.toLowerCase();
    }
  }

  return null;
};

const resolveAddressCandidate = async (
  address: string,
): Promise<ResolvedTrackedWallet | null> => {
  const normalized = address.toLowerCase();

  const directVerification = await verifyPolymarketAddress(normalized);
  if (directVerification.isLikelyValid) {
    return {
      input: address,
      monitoringAddress: normalized,
      source: 'direct',
      verification: directVerification,
    };
  }

  const proxyWallet = await fetchProxyFromPositions(normalized);
  if (proxyWallet && proxyWallet !== normalized) {
    const proxyVerification = await verifyPolymarketAddress(proxyWallet);
    if (proxyVerification.isLikelyValid) {
      return {
        input: address,
        monitoringAddress: proxyWallet,
        source: 'proxy',
        verification: proxyVerification,
      };
    }
  }

  return null;
};

export const resolveTrackedWalletAddress = async (rawInput: string): Promise<ResolvedTrackedWallet> => {
  const parsed = parsePolymarketWalletInput(rawInput);
  if (!parsed) {
    const verification = await verifyPolymarketAddress('');
    return {
      input: rawInput,
      monitoringAddress: rawInput.trim().toLowerCase(),
      source: 'direct',
      verification,
    };
  }

  if (parsed.kind === 'username') {
    const proxyWallet = await resolveUsernameToProxy(parsed.value);
    if (proxyWallet) {
      const verification = await verifyPolymarketAddress(proxyWallet);
      return {
        input: rawInput,
        monitoringAddress: proxyWallet,
        source: 'gamma_username',
        verification,
      };
    }

    const verification = await verifyPolymarketAddress('');
    return {
      input: rawInput,
      monitoringAddress: parsed.value,
      source: 'gamma_username',
      verification,
    };
  }

  const resolved = await resolveAddressCandidate(parsed.value);
  if (resolved) {
    return { ...resolved, input: rawInput };
  }

  const verification = await verifyPolymarketAddress(parsed.value);
  return {
    input: rawInput,
    monitoringAddress: parsed.value,
    source: 'direct',
    verification,
  };
};

const monitoringAddressCache = new Map<string, { address: string; expiresAt: number }>();
const MONITORING_CACHE_MS = 5 * 60 * 1000;

export const resolveMonitoringAddress = async (storedAddress: string): Promise<ResolvedTrackedWallet> => {
  const normalized = storedAddress.trim().toLowerCase();
  const cached = monitoringAddressCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    const verification = await verifyPolymarketAddress(cached.address);
    return {
      input: storedAddress,
      monitoringAddress: cached.address,
      source: 'direct',
      verification,
    };
  }

  const resolved = await resolveTrackedWalletAddress(normalized);
  if (resolved.verification.isLikelyValid) {
    monitoringAddressCache.set(normalized, {
      address: resolved.monitoringAddress,
      expiresAt: Date.now() + MONITORING_CACHE_MS,
    });
  }

  return resolved;
};

export const clearMonitoringAddressCache = (): void => {
  monitoringAddressCache.clear();
};

export async function reconcileTrackedWalletAddresses(): Promise<{
  migrated: number;
  invalid: string[];
}> {
  const { Storage } = await import('./storage.js');
  const { loadAgentsFile } = await import('./jungleAgentsStore.js');
  const { initDatabase, dbLoadTrackedWallets } = await import('./database.js');
  const { runWithTenant } = await import('./tenantContext.js');
  await initDatabase();
  const agents = await loadAgentsFile();
  const wallets = dbLoadTrackedWallets();
  let migrated = 0;
  const invalid: string[] = [];

  for (const wallet of wallets) {
    await runWithTenant(wallet.tenantId || 'default', async () => {
      let resolved = await resolveTrackedWalletAddress(wallet.address);

      if (!resolved.verification.isLikelyValid && wallet.label?.trim()) {
        const matchingAgent = agents.find((agent) => (
          agent.enabled
          && agent.displayName.trim().toLowerCase() === wallet.label!.trim().toLowerCase()
          && (agent.polymarketAddress || agent.polymarketUsername)
        ));
        if (matchingAgent) {
          const agentResolved = await resolveTrackedWalletAddress(
            matchingAgent.polymarketUsername
              ? '@' + matchingAgent.polymarketUsername.replace(/^@/, '')
              : matchingAgent.polymarketAddress,
          );
          if (agentResolved.verification.isLikelyValid) {
            resolved = agentResolved;
          }
        }
      }

      if (!resolved.verification.isLikelyValid) {
        invalid.push(wallet.address);
        return;
      }

      if (resolved.monitoringAddress !== wallet.address.toLowerCase()) {
        await Storage.migrateWalletAddress(wallet.address, resolved.monitoringAddress);
        migrated++;
        log.info(
          {
            tenantId: wallet.tenantId,
            label: wallet.label,
            from: wallet.address,
            to: resolved.monitoringAddress,
            source: resolved.source,
          },
          'Migrated tracked wallet to verified Polymarket proxy address',
        );
      }
    });
  }

  return { migrated, invalid };
}
