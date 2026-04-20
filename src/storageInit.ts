/**
 * storageInit.ts
 *
 * Call `initStorageBackend()` ONCE at application startup.
 * All Storage methods check `isSqliteReady()` via this module —
 * no more calling initDatabase() on every hot-path operation.
 */
import { initDatabase } from './database.js';
import { config } from './config.js';
import { isHostedMultiTenantMode } from './hostedMode.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('StorageInit');

let _sqliteReady = false;
let _initPromise: Promise<void> | null = null;

/**
 * Returns true if SQLite has been successfully initialised for this process.
 */
export function isSqliteReady(): boolean {
  return _sqliteReady;
}

/**
 * Initialise the storage backend once at startup.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initStorageBackend(): Promise<void> {
  if (_sqliteReady) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    if (config.storageBackend !== 'sqlite') {
      log.info('Storage backend: JSON (file-based)');
      return;
    }
    try {
      await initDatabase();
      _sqliteReady = true;
      log.info('Storage backend: SQLite (initialised)');
    } catch (err) {
      if (isHostedMultiTenantMode()) {
        log.error({ err }, 'SQLite init failed in hosted mode — cannot continue');
        throw err;
      }
      log.error({ err }, 'SQLite init failed — falling back to JSON');
      // _sqliteReady stays false; Storage will use JSON path
    }
  })();

  return _initPromise;
}

/**
 * Reset state — used in tests only.
 */
export function _resetStorageInitForTests(): void {
  _sqliteReady = false;
  _initPromise = null;
}
