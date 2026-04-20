/**
 * apiCache.ts
 *
 * Lightweight TTL cache used to reduce redundant Polymarket API calls on the
 * hot copy-trading path:
 *
 *   - Portfolio value (tracked wallet)  — 30 s TTL
 *   - USDC balance (our execution wallet) — 20 s TTL
 *   - Minimum order size (per token ID)   — 5 min TTL
 *
 * Each cache is a plain Map<key, { value, expiresAt }> so there are no
 * external dependencies and no background timers.
 */

export interface CacheEntry<T> {
  value: T;
  expiresAt: number; // Date.now() ms
}

export class TtlCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number) {
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /** Delete a specific key (e.g. after a trade changes the balance). */
  clear(key?: K): void {
    if (key !== undefined) {
      this.store.delete(key);
    } else {
      this.store.clear();
    }
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Singleton cache instances
// ---------------------------------------------------------------------------

/** Tracked-wallet portfolio value (USD). Key = lower-case proxy wallet address. */
export const portfolioValueCache = new TtlCache<string, number>(30_000);

/** Our execution-wallet USDC balance (raw units or USD float). Key = lower-case address. */
export const usdcBalanceCache = new TtlCache<string, number>(20_000);

/**
 * Minimum order size for a CLOB token. Key = tokenId string.
 * Exchange minimums change rarely; 5-minute TTL is more than sufficient.
 */
export const minOrderSizeCache = new TtlCache<string, number>(5 * 60_000);
