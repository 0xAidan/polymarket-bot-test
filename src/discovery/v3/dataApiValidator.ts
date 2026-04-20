/**
 * Compares a wallet's v3-derived stats to the Polymarket Data API. Used by
 * `scripts/backfill/06_validate.ts` and as a general dev tool.
 *
 * The Data API is unauthenticated; we use `fetch` directly. Errors fall back
 * to an `{ ok: false, reason: ... }` result — this is a validation tool, not
 * a critical path.
 */
export interface ValidatorDerivedStats {
  trade_count: number;
  volume_total: number;
}

export interface ValidatorResult {
  ok: boolean;
  reason?: string;
  derivedTradeCount: number;
  apiTradeCount: number | null;
  derivedVolume: number;
  apiVolume: number | null;
}

const DATA_API = 'https://data-api.polymarket.com';
const VOLUME_TOLERANCE_PCT = 0.01;

interface ActivityEvent {
  usdcSize?: number;
  size?: number;
  price?: number;
}

export interface ValidatorOptions {
  fetchImpl?: typeof fetch;
  activityLimit?: number;
}

export async function validateWalletAgainstDataApi(
  address: string,
  derived: ValidatorDerivedStats,
  opts: ValidatorOptions = {}
): Promise<ValidatorResult> {
  const f = opts.fetchImpl ?? fetch;
  const limit = opts.activityLimit ?? 500;
  const url = `${DATA_API}/v1/activity?user=${encodeURIComponent(address)}&limit=${limit}`;
  try {
    const res = await f(url);
    if (!res.ok) {
      return {
        ok: false,
        reason: `http ${res.status}`,
        derivedTradeCount: derived.trade_count,
        apiTradeCount: null,
        derivedVolume: derived.volume_total,
        apiVolume: null,
      };
    }
    const events = (await res.json()) as ActivityEvent[];
    const apiTradeCount = Array.isArray(events) ? events.length : 0;
    const apiVolume = Array.isArray(events)
      ? events.reduce((sum, e) => sum + (e.usdcSize ?? (e.size ?? 0) * (e.price ?? 0)), 0)
      : 0;

    const volumeDelta = derived.volume_total === 0
      ? (apiVolume === 0 ? 0 : 1)
      : Math.abs(derived.volume_total - apiVolume) / Math.max(derived.volume_total, apiVolume);
    const ok = volumeDelta <= VOLUME_TOLERANCE_PCT && apiTradeCount > 0;
    return {
      ok,
      reason: ok
        ? undefined
        : `trade_count derived=${derived.trade_count} api=${apiTradeCount}, volume delta ${(volumeDelta * 100).toFixed(2)}%`,
      derivedTradeCount: derived.trade_count,
      apiTradeCount,
      derivedVolume: derived.volume_total,
      apiVolume,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `fetch error: ${(err as Error).message}`,
      derivedTradeCount: derived.trade_count,
      apiTradeCount: null,
      derivedVolume: derived.volume_total,
      apiVolume: null,
    };
  }
}
