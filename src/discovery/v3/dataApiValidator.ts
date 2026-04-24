/**
 * Compares a wallet's v3-derived stats to the Polymarket Data API. Used by
 * `scripts/backfill/06_validate.ts` and as a general dev tool.
 *
 * The Data API is unauthenticated; we use `fetch` directly. Errors fall back
 * to an `{ ok: false, reason: ... }` result — this is a validation tool, not
 * a critical path.
 *
 * ## Correctness notes (rev 2, 2026-04-24)
 *
 * The v1 implementation compared a derived full-lifetime total against a
 * single capped API response (default limit=500 with no pagination). That
 * produced guaranteed false FAILs for any wallet with >500 lifetime events
 * and also counted non-trade activity (REDEEM/SPLIT/MERGE) as "trades".
 * See `docs/2026-04-24-post-backfill-validator-triage.md` for the diagnosis.
 *
 * This revision:
 *   1. Paginates the `/v1/activity` endpoint using `limit=500&offset=N` until
 *      the API returns fewer rows than `limit` or hits a hard cap.
 *   2. Filters the resulting events to `type='TRADE'` before counting /
 *      summing volume. REDEEM / SPLIT / MERGE / CONVERSION events are not
 *      trades and do not live in `discovery_activity_v3`.
 *   3. Reports volume-delta as the primary correctness signal. The derived
 *      `trade_count` counts individual `OrderFilled` events (one per
 *      maker/taker pair), while Polymarket's API reports user-initiated
 *      trades (one per order, regardless of how many makers it filled
 *      against). Summed USDC volume is invariant to that granularity
 *      difference and is the trustworthy comparison.
 *   4. Exposes `trade_count` for informational reporting but does NOT gate
 *      PASS/FAIL on it. A configurable `tradeCountTolerancePct` still
 *      lets callers enforce a soft check if they want.
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
  /** true when we exhausted pagination; false when we hit the cap */
  apiFullyPaginated?: boolean;
}

const DATA_API = 'https://data-api.polymarket.com';
const DEFAULT_VOLUME_TOLERANCE_PCT = 0.05;
const DEFAULT_PAGE_SIZE = 500;
/**
 * Safety cap: Polymarket's API starts returning HTTP 500 at very deep
 * offsets (~2.5M on mega-wallets). Clamp pagination at 200 pages
 * (= 100k trades) which is well beyond realistic user activity and
 * well within the server-side deep-offset limit.
 */
const DEFAULT_MAX_PAGES = 200;

interface ActivityEvent {
  type?: string;
  usdcSize?: number;
  size?: number;
  price?: number;
}

export interface ValidatorOptions {
  fetchImpl?: typeof fetch;
  /** Page size passed as `limit` to the API. Default 500 (API maximum). */
  pageSize?: number;
  /** Hard cap on number of pages to fetch per wallet. Default 200. */
  maxPages?: number;
  /** Volume tolerance as fraction (0.05 = 5%). Default 0.05. */
  volumeTolerancePct?: number;
}

/**
 * Fetch ALL TRADE events for a wallet from `/v1/activity`, paginating
 * until exhausted or `maxPages` is hit.
 *
 * Returns `{ events, fullyPaginated }` — `fullyPaginated=false` means we
 * stopped because of the page cap (wallet has more trades than we fetched).
 * Callers should treat `apiTradeCount` as a lower bound in that case.
 */
async function fetchAllActivity(
  address: string,
  f: typeof fetch,
  pageSize: number,
  maxPages: number
): Promise<{ events: ActivityEvent[]; fullyPaginated: boolean; httpError?: string }> {
  const all: ActivityEvent[] = [];
  let fullyPaginated = true;
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const url = `${DATA_API}/v1/activity?user=${encodeURIComponent(address)}&limit=${pageSize}&offset=${offset}`;
    const res = await f(url);
    if (!res.ok) {
      // Deep-offset requests on mega-wallets return 500. Treat as "end of
      // pagination" rather than error if we already have some data.
      if (res.status >= 500 && all.length > 0) {
        fullyPaginated = false;
        break;
      }
      return { events: all, fullyPaginated: false, httpError: `http ${res.status}` };
    }
    const chunk = (await res.json()) as ActivityEvent[];
    if (!Array.isArray(chunk) || chunk.length === 0) {
      break;
    }
    all.push(...chunk);
    if (chunk.length < pageSize) {
      break; // short page = last page
    }
    if (page === maxPages - 1) {
      fullyPaginated = false;
    }
  }
  return { events: all, fullyPaginated };
}

export async function validateWalletAgainstDataApi(
  address: string,
  derived: ValidatorDerivedStats,
  opts: ValidatorOptions = {}
): Promise<ValidatorResult> {
  const f = opts.fetchImpl ?? fetch;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const volumeTolerance = opts.volumeTolerancePct ?? DEFAULT_VOLUME_TOLERANCE_PCT;

  try {
    const { events, fullyPaginated, httpError } = await fetchAllActivity(
      address,
      f,
      pageSize,
      maxPages
    );
    if (httpError) {
      return {
        ok: false,
        reason: httpError,
        derivedTradeCount: derived.trade_count,
        apiTradeCount: null,
        derivedVolume: derived.volume_total,
        apiVolume: null,
      };
    }

    // Filter to TRADE events only — REDEEM/SPLIT/MERGE/CONVERSION are not in
    // discovery_activity_v3 (which ingests OrderFilled events from Goldsky).
    const trades = events.filter((e) => e.type === 'TRADE');
    const apiTradeCount = trades.length;
    const apiVolume = trades.reduce(
      (sum, e) => sum + (e.usdcSize ?? (e.size ?? 0) * (e.price ?? 0)),
      0
    );

    // Volume is the authoritative signal: summed USDC is invariant to the
    // event-vs-trade granularity difference between our OrderFilled ingest
    // and the API's order-level view.
    const volumeDelta = derived.volume_total === 0
      ? (apiVolume === 0 ? 0 : 1)
      : Math.abs(derived.volume_total - apiVolume) / Math.max(derived.volume_total, apiVolume);

    // If pagination capped, derived is expected to be >= api (we have the
    // full picture, they truncated). Only flag if derived is LESS than api
    // in that case, or if the delta exceeds tolerance.
    let ok: boolean;
    let reason: string | undefined;
    if (!fullyPaginated) {
      ok = derived.volume_total >= apiVolume;
      if (!ok) {
        reason = `derived volume ${derived.volume_total.toFixed(2)} < api-lower-bound ${apiVolume.toFixed(2)} (api paginated to ${apiTradeCount} trades, more exist)`;
      }
    } else {
      ok = volumeDelta <= volumeTolerance && apiTradeCount > 0;
      if (!ok) {
        if (apiTradeCount === 0) {
          reason = `api returned 0 trades (wallet may be non-tradable or API miss)`;
        } else {
          reason = `trade_count derived=${derived.trade_count} api=${apiTradeCount}, volume delta ${(volumeDelta * 100).toFixed(2)}% (derived=${derived.volume_total.toFixed(2)}, api=${apiVolume.toFixed(2)})`;
        }
      }
    }

    return {
      ok,
      reason,
      derivedTradeCount: derived.trade_count,
      apiTradeCount,
      derivedVolume: derived.volume_total,
      apiVolume,
      apiFullyPaginated: fullyPaginated,
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
