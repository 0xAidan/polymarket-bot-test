import { DomeClient as DomeSdkClient } from '@dome-api/sdk';
import { config } from './config.js';

let client: DomeSdkClient | null = null;

/**
 * Get or create the shared Dome REST client.
 * Returns null if DOME_API_KEY is not configured.
 */
export function getDomeClient(): DomeSdkClient | null {
  if (!config.domeApiKey) return null;
  if (client) return client;

  client = new DomeSdkClient({ apiKey: config.domeApiKey });
  return client;
}

/**
 * Check if Dome API is configured and available.
 */
export function isDomeConfigured(): boolean {
  return !!config.domeApiKey;
}

// ============================================================================
// CONVENIENCE WRAPPERS (loosely typed to work with the SDK's evolving types)
// ============================================================================

/**
 * Fetch market price for a Polymarket token.
 */
export async function domeGetMarketPrice(tokenId: string): Promise<{ price: number } | null> {
  const dome = getDomeClient();
  if (!dome) return null;

  try {
    const result = await dome.polymarket.markets.getMarketPrice({ token_id: tokenId });
    return result as { price: number };
  } catch (err) {
    console.error('[DomeClient] Failed to fetch market price:', err);
    return null;
  }
}

/**
 * Fetch positions for a Polymarket wallet.
 */
export async function domeGetPositions(address: string): Promise<any[]> {
  const dome = getDomeClient();
  if (!dome) return [];

  try {
    const result = await dome.polymarket.wallet.getPositions({ wallet_address: address });
    return (result as any)?.positions ?? [];
  } catch (err) {
    console.error('[DomeClient] Failed to fetch positions:', err);
    return [];
  }
}

/**
 * Get Kalshi markets (for cross-platform matching).
 */
export async function domeGetKalshiMarkets(params: { event_ticker?: string[]; status?: 'open' | 'closed'; limit?: number } = {}): Promise<any[]> {
  const dome = getDomeClient();
  if (!dome) return [];

  try {
    const result = await dome.kalshi.markets.getMarkets(params as any);
    return (result as any)?.markets ?? [];
  } catch (err) {
    console.error('[DomeClient] Failed to fetch Kalshi markets:', err);
    return [];
  }
}

