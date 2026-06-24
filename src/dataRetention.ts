import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config.js';
import { getDatabase } from './database.js';
import { getDiskMetrics, type DiskHealthStatus } from './diskGuard.js';
import { isDiscoveryV3Enabled, getDuckDBPath } from './discovery/v3/featureFlag.js';
import { openDuckDB } from './discovery/v3/duckdbClient.js';
import {
  cleanupOldSignals,
  cleanupStalePositions,
  purgeAllDiscoveryData,
  purgeOldDiscoveryRunLogs,
  purgeOldEvalSnapshots,
  purgeOldTrades,
  runRetentionCleanup,
} from './discovery/statsStore.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('DataRetention');

const DEFAULT_EXECUTED_POSITIONS_DAYS = 180;
const DEFAULT_EXECUTED_POSITIONS_MAX_ROWS = 5000;
const DEFAULT_AUTH_AUDIT_DAYS = 90;
const DEFAULT_DISCOVERY_RUN_LOG_DAYS = 14;
const DEFAULT_DUCKDB_ACTIVITY_DAYS = 30;

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const isDiscoveryDisabled = (): boolean =>
  !config.discoveryEnabled && process.env.DISCOVERY_V3 !== 'true';

const retentionDaysForStatus = (baseDays: number, status: DiskHealthStatus): number => {
  if (status === 'critical') return Math.min(3, baseDays);
  if (status === 'degraded') return Math.min(7, baseDays);
  return baseDays;
};

export const purgeOldTradeFactsV2 = (olderThanDays: number): number => {
  const db = getDatabase();
  const cutoff = Date.now() - olderThanDays * 86400 * 1000;
  return db.prepare('DELETE FROM discovery_trade_facts_v2 WHERE detected_at < ?').run(cutoff).changes;
};

export const purgeOldAuthAuditLog = (olderThanDays: number): number => {
  const db = getDatabase();
  const cutoff = Date.now() - olderThanDays * 86400 * 1000;
  return db.prepare('DELETE FROM app_auth_audit_log WHERE created_at_ms < ?').run(cutoff).changes;
};

export const pruneOldExecutedPositions = (olderThanDays: number, maxRowsPerTenant: number): number => {
  const db = getDatabase();
  const cutoff = Date.now() - olderThanDays * 86400 * 1000;
  let removed = db.prepare('DELETE FROM executed_positions WHERE timestamp < ?').run(cutoff).changes;

  const tenants = db
    .prepare('SELECT DISTINCT tenant_id FROM executed_positions')
    .all() as { tenant_id: string }[];

  for (const { tenant_id: tenantId } of tenants) {
    const countRow = db
      .prepare('SELECT COUNT(*) AS count FROM executed_positions WHERE tenant_id = ?')
      .get(tenantId) as { count: number };
    const excess = countRow.count - maxRowsPerTenant;
    if (excess <= 0) continue;
    const result = db
      .prepare(
        `DELETE FROM executed_positions WHERE rowid IN (
          SELECT rowid FROM executed_positions
          WHERE tenant_id = ?
          ORDER BY timestamp ASC
          LIMIT ?
        )`,
      )
      .run(tenantId, excess);
    removed += result.changes;
  }

  return removed;
};

export const purgeDiscoveryWalletScoresV3 = (): number => {
  const db = getDatabase();
  try {
    return db.prepare('DELETE FROM discovery_wallet_scores_v3').run().changes;
  } catch {
    return 0;
  }
};

export const countDiscoverySqliteRows = (): number => {
  const db = getDatabase();
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'discovery%'`,
    )
    .all() as { name: string }[];

  let total = 0;
  for (const { name } of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number };
    total += row.count;
  }
  return total;
};

export const purgeAllDiscoveryDataIncludingV3 = (): number => {
  const v3Removed = purgeDiscoveryWalletScoresV3();
  const result = purgeAllDiscoveryData();
  return result.total + v3Removed;
};

export const purgeOldDuckDBActivity = async (olderThanDays: number): Promise<number> => {
  if (!isDiscoveryV3Enabled()) return 0;

  const dbPath = path.resolve(getDuckDBPath());
  try {
    await fs.access(dbPath);
  } catch {
    return 0;
  }

  const cutoffSec = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  const duck = await openDuckDB(dbPath);
  try {
    const before = await duck.query<{ count: number }>(
      'SELECT COUNT(*)::BIGINT AS count FROM discovery_activity_v3',
    );
    await duck.exec(`DELETE FROM discovery_activity_v3 WHERE block_timestamp < ${cutoffSec}`);
    const after = await duck.query<{ count: number }>(
      'SELECT COUNT(*)::BIGINT AS count FROM discovery_activity_v3',
    );
    const beforeCount = Number(before[0]?.count ?? 0);
    const afterCount = Number(after[0]?.count ?? 0);
    return Math.max(0, beforeCount - afterCount);
  } finally {
    await duck.close();
  }
};

export type AppDataRetentionResult = {
  discoveryDisabledPurge: number;
  tradesRemoved: number;
  tradeFactsRemoved: number;
  signalsRemoved: number;
  positionsRemoved: number;
  runLogsRemoved: number;
  evalSnapshotsRemoved: number;
  executedPositionsRemoved: number;
  authAuditRemoved: number;
  duckdbActivityRemoved: number;
  totalRowsRemoved: number;
};

export const runAppDataRetention = async (): Promise<AppDataRetentionResult> => {
  const metrics = getDiskMetrics();
  const status = metrics.status;

  const result: AppDataRetentionResult = {
    discoveryDisabledPurge: 0,
    tradesRemoved: 0,
    tradeFactsRemoved: 0,
    signalsRemoved: 0,
    positionsRemoved: 0,
    runLogsRemoved: 0,
    evalSnapshotsRemoved: 0,
    executedPositionsRemoved: 0,
    authAuditRemoved: 0,
    duckdbActivityRemoved: 0,
    totalRowsRemoved: 0,
  };

  if (isDiscoveryDisabled()) {
    const discoveryRows = countDiscoverySqliteRows();
    if (discoveryRows > 0) {
      result.discoveryDisabledPurge = purgeAllDiscoveryDataIncludingV3();
      log.info({ rowsRemoved: result.discoveryDisabledPurge }, 'Purged Discovery SQLite data (Discovery disabled)');
    }
  } else {
    const tradeDays = retentionDaysForStatus(30, status);
    result.tradesRemoved = purgeOldTrades(tradeDays);
    result.tradeFactsRemoved = purgeOldTradeFactsV2(tradeDays);
    result.signalsRemoved = cleanupOldSignals(retentionDaysForStatus(30, status));
    result.positionsRemoved = cleanupStalePositions(retentionDaysForStatus(90, status));
    result.runLogsRemoved = purgeOldDiscoveryRunLogs(
      retentionDaysForStatus(DEFAULT_DISCOVERY_RUN_LOG_DAYS, status),
    );
    result.evalSnapshotsRemoved = purgeOldEvalSnapshots(
      retentionDaysForStatus(DEFAULT_DISCOVERY_RUN_LOG_DAYS, status),
    );

    if (status === 'ok') {
      result.tradesRemoved += runRetentionCleanup();
    }
  }

  const executedDays = parsePositiveInt(
    process.env.EXECUTED_POSITIONS_RETENTION_DAYS,
    DEFAULT_EXECUTED_POSITIONS_DAYS,
  );
  const executedMaxRows = parsePositiveInt(
    process.env.EXECUTED_POSITIONS_MAX_ROWS,
    DEFAULT_EXECUTED_POSITIONS_MAX_ROWS,
  );
  result.executedPositionsRemoved = pruneOldExecutedPositions(
    retentionDaysForStatus(executedDays, status),
    executedMaxRows,
  );

  const auditDays = parsePositiveInt(process.env.AUTH_AUDIT_RETENTION_DAYS, DEFAULT_AUTH_AUDIT_DAYS);
  result.authAuditRemoved = purgeOldAuthAuditLog(retentionDaysForStatus(auditDays, status));

  if (isDiscoveryV3Enabled()) {
    const duckDays = parsePositiveInt(
      process.env.DUCKDB_ACTIVITY_RETENTION_DAYS,
      DEFAULT_DUCKDB_ACTIVITY_DAYS,
    );
    try {
      result.duckdbActivityRemoved = await purgeOldDuckDBActivity(
        retentionDaysForStatus(duckDays, status),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ err: message }, 'DuckDB activity retention skipped (non-fatal)');
    }
  }

  result.totalRowsRemoved =
    result.discoveryDisabledPurge +
    result.tradesRemoved +
    result.tradeFactsRemoved +
    result.signalsRemoved +
    result.positionsRemoved +
    result.runLogsRemoved +
    result.evalSnapshotsRemoved +
    result.executedPositionsRemoved +
    result.authAuditRemoved +
    result.duckdbActivityRemoved;

  return result;
};
