import type { TradingWallet } from './types.js';
import { PolymarketClobClient } from './clobClient.js';
import { getBuilderCredentials, getSigner } from './secureKeyManager.js';
import { createComponentLogger } from './logger.js';
import { getValidEvmAddress } from './addressUtils.js';
import { PolymarketApi } from './polymarketApi.js';
import { isHostedMultiTenantMode } from './hostedMode.js';

const log = createComponentLogger('ClobClientFactory');

const MAX_CACHE = 64;
const cache = new Map<string, PolymarketClobClient>();

const cacheKey = (tenantId: string, tradingWalletId: string): string =>
  `${tenantId}:${tradingWalletId}`;

const evictIfNeeded = (): void => {
  while (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first) {
      cache.delete(first);
    }
  }
};

/**
 * Resolve signature type: per-wallet field, then env (legacy).
 */
export const resolveSignatureType = (tw: TradingWallet): number => {
  if (typeof tw.polymarketSignatureType === 'number' && !Number.isNaN(tw.polymarketSignatureType)) {
    return tw.polymarketSignatureType;
  }
  return parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0', 10);
};

/**
 * Resolve funder (proxy) address for CLOB — never use another tenant's env in isolation.
 */
export const resolveFunderAddress = async (
  tw: TradingWallet,
  api: PolymarketApi,
): Promise<string> => {
  const explicit = getValidEvmAddress(tw.polymarketFunderAddress);
  if (explicit) {
    return explicit;
  }
  const proxy = getValidEvmAddress(tw.proxyAddress);
  if (proxy) {
    return proxy;
  }
  try {
    const fromApi = await api.getProxyWalletAddress(tw.address);
    if (fromApi) {
      return fromApi;
    }
  } catch {
    // fall through
  }
  if (!isHostedMultiTenantMode()) {
    const envFunder = getValidEvmAddress(process.env.POLYMARKET_FUNDER_ADDRESS);
    if (envFunder) {
      return envFunder;
    }
  } else {
    log.warn(
      `Hosted mode: no explicit/proxy/API funder for wallet ${tw.id}; refusing env funder fallback and using wallet address`
    );
  }
  return tw.address;
};

/**
 * Return a cached CLOB client for (tenant, trading wallet). Caller must be inside runWithTenant(tenantId).
 */
export async function getClobClientForTradingWallet(
  tenantId: string,
  tw: TradingWallet,
  api: PolymarketApi,
): Promise<PolymarketClobClient> {
  const key = cacheKey(tenantId, tw.id);
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }

  const signer = getSigner(tw.id);
  const builder = getBuilderCredentials(tw.id);
  if (!builder?.apiKey || !builder.apiSecret || !builder.apiPassphrase) {
    throw new Error(
      `Builder API credentials not loaded for trading wallet "${tw.id}". Add Builder credentials in the dashboard.`,
    );
  }

  const signatureType = resolveSignatureType(tw);
  const funderAddress = await resolveFunderAddress(tw, api);

  const client = new PolymarketClobClient();
  await client.initializeFromOptions({
    privateKey: signer.privateKey,
    signatureType,
    funderAddress,
    builder: {
      key: builder.apiKey,
      secret: builder.apiSecret,
      passphrase: builder.apiPassphrase,
    },
  });

  evictIfNeeded();
  cache.set(key, client);
  log.info(`Cached CLOB client for tenant=${tenantId} wallet=${tw.id}`);
  return client;
}

/**
 * Clear cached clients (e.g. tests or credential rotation).
 */
export function clearClobClientCache(): void {
  cache.clear();
}

export function evictClobClientCacheEntry(tenantId: string, tradingWalletId: string): void {
  cache.delete(cacheKey(tenantId, tradingWalletId));
}
