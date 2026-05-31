/**
 * Optional metadata fetched at score-publish time (not on API read path).
 * Populates Polymarket "Predictions" count and display name for UI labels.
 */
import {
  fetchReferenceLifetimePnlUsd,
  fetchReferenceTradeVolumeUsd,
  fetchTradedCount,
} from './dataApiValidator.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = Number(process.env.PUBLISH_FETCH_TIMEOUT_MS ?? 30_000);

async function fetchWithTimeout(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface PublishProfileMeta {
  predictionsCount: number | null;
  profileName: string | null;
  /** Polymarket reference lifetime PnL (closed + open), stored at publish for display. */
  profilePnlUsd: number | null;
  /** Paginated Data API TRADE volume sum, stored at publish for display. */
  profileVolumeUsd: number | null;
}

/** Predictions + display name only (fast — used before pipeline gate). */
export async function fetchPublishProfileMetaLite(
  address: string,
  fetchImpl: typeof fetch = fetch
): Promise<PublishProfileMeta> {
  const proxyWallet = address.trim().toLowerCase();
  const [predictionsCount, profileName] = await Promise.all([
    fetchTradedCount(proxyWallet, fetchImpl),
    fetchGammaProfileName(proxyWallet, fetchImpl),
  ]);
  return { predictionsCount, profileName, profilePnlUsd: null, profileVolumeUsd: null };
}

/** Full reference stats — only for wallets that fail the pipeline promotion gate. */
export async function fetchReferenceDisplayStats(
  address: string,
  fetchImpl: typeof fetch = fetch
): Promise<Pick<PublishProfileMeta, 'profilePnlUsd' | 'profileVolumeUsd'>> {
  const proxyWallet = address.trim().toLowerCase();
  const [profilePnlUsd, profileVolumeUsd] = await Promise.all([
    fetchReferenceLifetimePnlUsd(proxyWallet, fetchImpl),
    fetchReferenceTradeVolumeUsd(proxyWallet, fetchImpl),
  ]);
  return { profilePnlUsd, profileVolumeUsd };
}

export async function fetchPublishProfileMeta(
  address: string,
  fetchImpl: typeof fetch = fetch
): Promise<PublishProfileMeta> {
  const lite = await fetchPublishProfileMetaLite(address, fetchImpl);
  const ref = await fetchReferenceDisplayStats(address, fetchImpl);
  return { ...lite, ...ref };
}

async function fetchGammaProfileName(
  address: string,
  f: typeof fetch
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `${GAMMA_API}/public-profile?address=${encodeURIComponent(address)}`,
      f
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: string; pseudonym?: string };
    return body.name ? String(body.name) : body.pseudonym ? String(body.pseudonym) : null;
  } catch {
    return null;
  }
}
