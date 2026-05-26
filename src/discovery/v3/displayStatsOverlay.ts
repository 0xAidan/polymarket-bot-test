/**
 * Read-path overlay: tier cards show Polymarket reference lifetime PnL/volume
 * instead of pipeline-derived SQLite values (which can be corrupt or stale).
 */
import {
  fetchReferenceLifetimePnlUsd,
  fetchReferenceTradeVolumeUsd,
} from './dataApiValidator.js';
import { fetchReferenceDisplayStats } from './publishEnrichment.js';

const CACHE_TTL_MS = Number(process.env.DISCOVERY_V3_DISPLAY_CACHE_MS ?? 10 * 60 * 1000);
const FETCH_GAP_MS = Number(process.env.DISCOVERY_V3_DISPLAY_FETCH_GAP_MS ?? 250);

interface CachedDisplay {
  pnl: number | null;
  volume: number | null;
  fetchedAt: number;
}

const cache = new Map<string, CachedDisplay>();
let lastFetchAt = 0;

export const isDisplayReferenceOverlayEnabled = (): boolean =>
  process.env.DISCOVERY_V3_READ_REFERENCE_OVERLAY !== '0';

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastFetchAt;
  if (elapsed < FETCH_GAP_MS) {
    await sleepMs(FETCH_GAP_MS - elapsed);
  }
  lastFetchAt = Date.now();
}

export async function fetchReferenceDisplayCached(
  address: string
): Promise<{ pnl: number | null; volume: number | null }> {
  const key = address.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return { pnl: hit.pnl, volume: hit.volume };
  }

  await throttle();
  const ref = await fetchReferenceDisplayStats(key);
  let pnl = ref.profilePnlUsd;
  let volume = ref.profileVolumeUsd;

  if (pnl == null) {
    await throttle();
    pnl = await fetchReferenceLifetimePnlUsd(key);
  }
  if (volume == null) {
    await throttle();
    volume = await fetchReferenceTradeVolumeUsd(key);
  }

  const entry: CachedDisplay = { pnl, volume, fetchedAt: Date.now() };
  cache.set(key, entry);
  return { pnl, volume };
}

export interface DisplayOverlayRow {
  address: string;
  realizedPnl: number;
  volumeTotal: number;
}

export type DisplayOverlayResult<T extends DisplayOverlayRow> = T & {
  /** When reference fetch failed, UI should not trust pipeline PnL. */
  displayStatsUnverified?: boolean;
};

/**
 * Replace lifetime PnL/volume with Polymarket reference values when available.
 * If reference is unavailable, null out stats rather than show corrupt pipeline numbers.
 */
export async function overlayDisplayStats<T extends DisplayOverlayRow>(
  rows: T[],
  opts: { allowPipelineFallback?: boolean } = {}
): Promise<Array<DisplayOverlayResult<T>>> {
  const allowFallback = opts.allowPipelineFallback
    ?? process.env.DISCOVERY_V3_ALLOW_PIPELINE_PNL_FALLBACK === '1';

  const out: Array<DisplayOverlayResult<T>> = [];
  for (const row of rows) {
    const ref = await fetchReferenceDisplayCached(row.address);
    if (ref.pnl != null && Number.isFinite(ref.pnl)) {
      out.push({
        ...row,
        realizedPnl: ref.pnl,
        volumeTotal: ref.volume != null && Number.isFinite(ref.volume) ? ref.volume : row.volumeTotal,
      });
      continue;
    }
    if (allowFallback) {
      out.push({ ...row, displayStatsUnverified: true });
      continue;
    }
    out.push({
      ...row,
      realizedPnl: null as unknown as number,
      volumeTotal: null as unknown as number,
      displayStatsUnverified: true,
    });
  }
  return out;
}
