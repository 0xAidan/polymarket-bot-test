import { Platform, PlatformAdapter } from './types.js';
import { PolymarketAdapter } from './polymarketAdapter.js';
import { KalshiAdapter } from './kalshiAdapter.js';

// ============================================================================
// Platform Registry — Singleton that manages all platform adapters
// ============================================================================

const adapters = new Map<Platform, PlatformAdapter>();

function ensureRegistered(): void {
  if (adapters.size > 0) return;
  adapters.set('polymarket', new PolymarketAdapter());
  adapters.set('kalshi', new KalshiAdapter());
}

/**
 * Get a specific platform adapter.
 */
export function getAdapter(platform: Platform): PlatformAdapter {
  ensureRegistered();
  const adapter = adapters.get(platform);
  if (!adapter) throw new Error(`Unknown platform: ${platform}`);
  return adapter;
}

/**
 * Get all registered adapters.
 */
export function getAllAdapters(): PlatformAdapter[] {
  ensureRegistered();
  return [...adapters.values()];
}

/**
 * Get only configured adapters (have data access).
 */
export function getConfiguredAdapters(): PlatformAdapter[] {
  return getAllAdapters().filter(a => a.isConfigured());
}

/**
 * Get only executable adapters (can place orders).
 */
export function getExecutableAdapters(): PlatformAdapter[] {
  return getAllAdapters().filter(a => a.canExecute());
}

/**
 * Check if a platform is configured.
 */
export function isPlatformConfigured(platform: Platform): boolean {
  ensureRegistered();
  return adapters.get(platform)?.isConfigured() ?? false;
}

/**
 * Get status of all platforms.
 */
export function getAllPlatformStatuses(): Array<{ platform: Platform } & ReturnType<PlatformAdapter['getStatus']>> {
  return getAllAdapters().map(a => ({
    platform: a.platform,
    ...a.getStatus(),
  }));
}
