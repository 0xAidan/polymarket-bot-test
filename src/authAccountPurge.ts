import { promises as fs } from 'fs';
import path from 'path';
import { getDatabase } from './database.js';
import { config } from './config.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('AuthAccountPurge');

export type HostedAccountPurgeResult = {
  usersRemoved: number;
  tenantsRemoved: number;
  membershipsRemoved: number;
  auditLogRemoved: number;
  trackedWalletsRemoved: number;
  botConfigRowsRemoved: number;
  executedPositionsRemoved: number;
  keystoreDirsRemoved: number;
  tenantJsonFilesRemoved: number;
};

const TENANT_JSON_PREFIXES = [
  'balance_history_tenant_',
  'trade_metrics_tenant_',
  'system_issues_tenant_',
];

export const purgeAllHostedAccounts = async (): Promise<HostedAccountPurgeResult> => {
  const database = getDatabase();

  const usersRemoved = (database.prepare('SELECT COUNT(*) AS count FROM app_users').get() as { count: number }).count;
  const tenantsRemoved = (database.prepare('SELECT COUNT(*) AS count FROM app_tenants').get() as { count: number }).count;
  const membershipsRemoved = (
    database.prepare('SELECT COUNT(*) AS count FROM app_tenant_memberships').get() as { count: number }
  ).count;
  const auditLogRemoved = (
    database.prepare('SELECT COUNT(*) AS count FROM app_auth_audit_log').get() as { count: number }
  ).count;
  const trackedWalletsRemoved = (
    database.prepare('SELECT COUNT(*) AS count FROM tracked_wallets').get() as { count: number }
  ).count;
  const botConfigRowsRemoved = (
    database.prepare('SELECT COUNT(*) AS count FROM bot_config').get() as { count: number }
  ).count;
  const executedPositionsRemoved = (
    database.prepare('SELECT COUNT(*) AS count FROM executed_positions').get() as { count: number }
  ).count;

  const tx = database.transaction(() => {
    database.prepare('DELETE FROM app_auth_audit_log').run();
    database.prepare('DELETE FROM app_tenant_memberships').run();
    database.prepare('DELETE FROM app_users').run();
    database.prepare('DELETE FROM app_tenants').run();
    database.prepare('DELETE FROM tracked_wallets').run();
    database.prepare('DELETE FROM bot_config').run();
    database.prepare('DELETE FROM executed_positions').run();
  });
  tx();

  let keystoreDirsRemoved = 0;
  const keystoresRoot = path.join(config.dataDir, 'keystores');
  try {
    const entries = await fs.readdir(keystoresRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(keystoresRoot, entry.name);
      await fs.rm(dirPath, { recursive: true, force: true });
      keystoreDirsRemoved++;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ err: message }, 'Keystore cleanup skipped or partial');
  }

  let tenantJsonFilesRemoved = 0;
  try {
    const dataEntries = await fs.readdir(config.dataDir);
    for (const name of dataEntries) {
      if (!TENANT_JSON_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      await fs.unlink(path.join(config.dataDir, name));
      tenantJsonFilesRemoved++;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ err: message }, 'Tenant JSON cleanup skipped or partial');
  }

  const result: HostedAccountPurgeResult = {
    usersRemoved,
    tenantsRemoved,
    membershipsRemoved,
    auditLogRemoved,
    trackedWalletsRemoved,
    botConfigRowsRemoved,
    executedPositionsRemoved,
    keystoreDirsRemoved,
    tenantJsonFilesRemoved,
  };

  log.info(result, 'Purged all hosted accounts and tenant-scoped bot data');
  return result;
};
