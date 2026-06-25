import {
  dbLoadConfig,
  dbSaveConfig,
  listTenantIdsWithActiveTrackedWallets,
  listTenantIdsWithCopyTradingEnabled,
} from './database.js';
import { config } from './config.js';
import { Storage } from './storage.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('CopyTradingSync');

export const COPY_TRADING_ENABLED_KEY = 'copyTradingEnabled';

export interface CopyTraderSyncTarget {
  start(): Promise<void>;
  stop(): void;
}

export const isCopyTradingForceDisabled = (): boolean =>
  process.env.COPY_TRADING_FORCE_DISABLED === 'true';

const parseConfigFlag = (value: unknown): boolean => value === true || value === 'true';

export const getCopyTradingEnabledForTenant = (tenantId: string): boolean => {
  const cfg = dbLoadConfig(tenantId);
  return parseConfigFlag(cfg[COPY_TRADING_ENABLED_KEY]);
};

export const anyTenantWantsCopyTradingSqlite = (): boolean => {
  const activeTenants = new Set(listTenantIdsWithActiveTrackedWallets());
  if (activeTenants.size === 0) {
    return false;
  }
  return listTenantIdsWithCopyTradingEnabled().some((tenantId) => activeTenants.has(tenantId));
};

export const anyTenantWantsCopyTrading = async (): Promise<boolean> => {
  if (config.storageBackend !== 'sqlite') {
    const enabled = await Storage.getCopyTradingEnabled();
    if (!enabled) {
      return false;
    }
    const wallets = await Storage.getActiveWallets();
    return wallets.length > 0;
  }
  return anyTenantWantsCopyTradingSqlite();
};

export const migrateCopyTradingPreferencesSqlite = (): void => {
  for (const tenantId of listTenantIdsWithActiveTrackedWallets()) {
    const cfg = dbLoadConfig(tenantId);
    if (cfg[COPY_TRADING_ENABLED_KEY] !== undefined) {
      continue;
    }
    cfg[COPY_TRADING_ENABLED_KEY] = true;
    dbSaveConfig(cfg, tenantId);
    log.info({ tenantId }, 'Migrated copy trading preference to enabled (active wallets present)');
  }
};

export const migrateCopyTradingPreferences = async (): Promise<void> => {
  if (config.storageBackend === 'sqlite') {
    migrateCopyTradingPreferencesSqlite();
    return;
  }

  const wallets = await Storage.loadTrackedWallets();
  const hasActiveWallet = wallets.some((wallet) => wallet.active);
  if (!hasActiveWallet) {
    return;
  }

  const cfg = await Storage.loadConfig();
  if (cfg[COPY_TRADING_ENABLED_KEY] !== undefined) {
    return;
  }

  cfg[COPY_TRADING_ENABLED_KEY] = true;
  await Storage.saveConfig(cfg);
  log.info('Migrated copy trading preference to enabled (active wallets present)');
};

export const syncCopyTraderState = async (copyTrader: CopyTraderSyncTarget): Promise<void> => {
  if (isCopyTradingForceDisabled()) {
    log.warn('COPY_TRADING_FORCE_DISABLED is set — copy trading monitor stopped');
    copyTrader.stop();
    return;
  }

  if (await anyTenantWantsCopyTrading()) {
    await copyTrader.start();
    return;
  }

  copyTrader.stop();
};
