/**
 * Read-only guard for legacy discovery tables once v3 is the source of truth.
 *
 * During cutover, legacy writes are suppressed by feature flag but reads
 * continue to work (Phase 4). This module provides the gate without touching
 * legacy files.
 */
import { isDiscoveryV3Enabled } from './featureFlag.js';

export function isLegacyDiscoveryWriteAllowed(): boolean {
  if (!isDiscoveryV3Enabled()) return true;
  return process.env.DISCOVERY_V3_LEGACY_WRITES === 'true';
}

export function legacyWriteGuardReason(): string | null {
  if (isLegacyDiscoveryWriteAllowed()) return null;
  return 'discovery v3 active: legacy writes disabled (set DISCOVERY_V3_LEGACY_WRITES=true to override)';
}
