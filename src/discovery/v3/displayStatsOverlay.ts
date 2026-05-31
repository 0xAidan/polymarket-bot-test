/**
 * Read-path overlay: tier cards show Polymarket reference lifetime PnL/volume
 * instead of pipeline-derived SQLite values (which can be corrupt or stale).
 *
 * Bounded for latency: only the first N visible cards are refreshed per request,
 * with parallel fetches and per-wallet timeouts so /tier/* responds in seconds.
 */
import {
  fetchReferenceLifetimePnlUsd,
  fetchReferenceTradeVolumeUsd,
} from './dataApiValidator.js';
import { fetchReferenceDisplayStats } from './publishEnrichment.js';

const CACHE_TTL_MS = Number(process.env.DISCOVERY_V3_DISPLAY_CACHE_MS ?? 10 * 60 * 1000);
const OVERLAY_MAX_WALLETS = Number(process.env.DISCOVERY_V3_OVERLAY_MAX_WALLETS ?? 20);
const OVERLAY_CONCURRENCY = Number(process.env.DISCOVERY_V3_OVERLAY_CONCURRENCY ?? 4);
const OVERLAY_WALLET_TIMEOUT_MS = Number(process.env.DISCOVERY_V3_OVERLAY_WALLET_TIMEOUT_MS ?? 12_000);

interface CachedDisplay {
  pnl: number | null;
  volume: number | null;
  fetchedAt: number;
}

const cache = new Map<string, CachedDisplay>();

export const isDisplayReferenceOverlayEnabled = (): boolean =>
  process.env.DISCOVERY_V3_READ_REFERENCE_OVERLAY !== '0';

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export async function fetchReferenceDisplayCached(
  address: string
): Promise<{ pnl: number | null; volume: number | null }> {
  const key = address.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return { pnl: hit.pnl, volume: hit.volume };
  }

  const ref = await withTimeout(fetchReferenceDisplayStats(key), OVERLAY_WALLET_TIMEOUT_MS);
  if (!ref) {
    return { pnl: null, volume: null };
  }

  let pnl = ref.profilePnlUsd;
  let volume = ref.profileVolumeUsd;

  if (pnl == null) {
    pnl = await withTimeout(fetchReferenceLifetimePnlUsd(key), OVERLAY_WALLET_TIMEOUT_MS);
  }
  if (volume == null) {
    volume = await withTimeout(fetchReferenceTradeVolumeUsd(key), OVERLAY_WALLET_TIMEOUT_MS);
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
  displayStatsUnverified?: boolean;
};

const applyReferenceToRow = <T extends DisplayOverlayRow>(
  row: T,
  ref: { pnl: number | null; volume: number | null },
  allowFallback: boolean
): DisplayOverlayResult<T> => {
  if (ref.pnl != null && Number.isFinite(ref.pnl)) {
    return {
      ...row,
      realizedPnl: ref.pnl,
      volumeTotal: ref.volume != null && Number.isFinite(ref.volume) ? ref.volume : row.volumeTotal,
    };
  }
  if (allowFallback) {
    return { ...row, displayStatsUnverified: true };
  }
  return {
    ...row,
    realizedPnl: null as unknown as number,
    volumeTotal: null as unknown as number,
    displayStatsUnverified: true,
  };
};

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Replace lifetime PnL/volume with Polymarket reference for the first N rows only.
 * Remaining rows keep SQLite values (fast path) so the page loads immediately.
 */
export async function overlayDisplayStats<T extends DisplayOverlayRow>(
  rows: T[],
  opts: { allowPipelineFallback?: boolean } = {}
): Promise<Array<DisplayOverlayResult<T>>> {
  const allowFallback = opts.allowPipelineFallback
    ?? process.env.DISCOVERY_V3_ALLOW_PIPELINE_PNL_FALLBACK !== '0';

  if (rows.length === 0) return [];

  const overlayCount = Math.min(rows.length, OVERLAY_MAX_WALLETS);
  const head = rows.slice(0, overlayCount);
  const tail = rows.slice(overlayCount);

  const headOut = await mapPool(head, OVERLAY_CONCURRENCY, async (row) => {
    const ref = await fetchReferenceDisplayCached(row.address);
    return applyReferenceToRow(row, ref, allowFallback);
  });

  const tailOut = tail.map((row) => ({ ...row, displayStatsUnverified: true }));

  return [...headOut, ...tailOut];
}
