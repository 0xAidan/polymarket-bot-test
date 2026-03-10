export interface StartupCopyTrader {
  start(): Promise<void>;
}

export interface StartupDiscoveryManager {
  start(): Promise<void>;
}

export type StartupDiscoveryErrorHandler = (error: unknown) => void;

/**
 * Start monitoring services after the app has initialized.
 * Copy trading starts first so tracked-wallet polling is live
 * even if discovery is disabled or unavailable.
 */
export const startMonitoringServices = async (
  copyTrader: StartupCopyTrader,
  discoveryManager: StartupDiscoveryManager | null,
  onDiscoveryError: StartupDiscoveryErrorHandler = () => {},
): Promise<void> => {
  await copyTrader.start();

  // Discovery now runs in a separate worker process. Keep this argument
  // to avoid breaking older call sites, but do not start discovery inline.
  if (discoveryManager) {
    try {
      onDiscoveryError(new Error('Discovery startup is managed by discovery worker process'));
    } catch {
      // Best-effort callback only
    }
  }
};
