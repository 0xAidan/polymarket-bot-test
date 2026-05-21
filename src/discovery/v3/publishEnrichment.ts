/**
 * Optional metadata fetched at score-publish time (not on API read path).
 * Populates Polymarket "Predictions" count and display name for UI labels.
 */
import { fetchReferenceLifetimePnlUsd, fetchTradedCount } from './dataApiValidator.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';

export interface PublishProfileMeta {
  predictionsCount: number | null;
  profileName: string | null;
  /** Polymarket profile PnL: sum(closed realizedPnl) + sum(open cashPnl). */
  profilePnlUsd: number | null;
}

export async function fetchPublishProfileMeta(
  address: string,
  fetchImpl: typeof fetch = fetch
): Promise<PublishProfileMeta> {
  const proxyWallet = address.trim().toLowerCase();
  const [predictionsCount, profileName, profilePnlUsd] = await Promise.all([
    fetchTradedCount(proxyWallet, fetchImpl),
    fetchGammaProfileName(proxyWallet, fetchImpl),
    fetchReferenceLifetimePnlUsd(proxyWallet, fetchImpl),
  ]);
  return { predictionsCount, profileName, profilePnlUsd };
}

async function fetchGammaProfileName(
  address: string,
  f: typeof fetch
): Promise<string | null> {
  try {
    const res = await f(`${GAMMA_API}/public-profile?address=${encodeURIComponent(address)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: string; pseudonym?: string };
    return body.name ? String(body.name) : body.pseudonym ? String(body.pseudonym) : null;
  } catch {
    return null;
  }
}
