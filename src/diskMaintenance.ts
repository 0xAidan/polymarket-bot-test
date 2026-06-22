import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config.js';
import {
  cleanupOrphanTempFiles,
  getDiskMetrics,
  logDiskPressure,
  type DiskHealthStatus,
} from './diskGuard.js';
import { checkpointWalIfDiskPressure, vacuumDatabaseIfDiskPressure } from './database.js';
import { runRetentionCleanupWithDiskPressure } from './discovery/statsStore.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('DiskMaintenance');

const STALE_DATA_DIR_PATTERN = /^data\.(backup-.+|bak-on-root|local-backup-.+)$/;
const ENV_BACKUP_PATTERN = /^\.env\.backup/;
const TEMP_TEST_DIR_PATTERN = /^cross-platform-test-/;
const DEFAULT_BACKUP_RETENTION_DAYS = 14;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

export type DiskMaintenanceResult = {
  statusBefore: DiskHealthStatus;
  statusAfter: DiskHealthStatus;
  orphanTempsRemoved: number;
  staleBackupDirsRemoved: number;
  envBackupsRemoved: number;
  backupFilesPruned: number;
  tempTestDirsRemoved: number;
  retentionRowsRemoved: number;
  walCheckpointed: boolean;
  vacuumed: boolean;
};

const dirSizeBytes = async (targetPath: string): Promise<number> => {
  let total = 0;
  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(entryPath);
          total += stat.size;
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  return total;
};

export const removeStaleBackupDirectories = async (
  appRoot: string,
  activeDataDir: string,
): Promise<number> => {
  const resolvedActive = path.resolve(activeDataDir);
  const resolvedRoot = path.resolve(appRoot);
  let removed = 0;

  let entries;
  try {
    entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!STALE_DATA_DIR_PATTERN.test(entry.name)) continue;

    const candidate = path.resolve(resolvedRoot, entry.name);
    if (candidate === resolvedActive) continue;

    let realPath = candidate;
    try {
      realPath = await fs.realpath(candidate);
    } catch {
      // keep candidate
    }
    if (realPath === resolvedActive) continue;

    try {
      const sizeBytes = await dirSizeBytes(candidate);
      await fs.rm(candidate, { recursive: true, force: true });
      removed++;
      log.info(
        { path: candidate, sizeMb: Math.round(sizeBytes / 1024 / 1024) },
        'Removed stale data backup directory',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ path: candidate, err: message }, 'Failed to remove stale backup directory');
    }
  }

  return removed;
};

export const pruneEnvBackupFiles = async (appRoot: string): Promise<number> => {
  const resolvedRoot = path.resolve(appRoot);
  let removed = 0;
  let entries;
  try {
    entries = await fs.readdir(resolvedRoot);
  } catch {
    return 0;
  }

  for (const name of entries) {
    if (!ENV_BACKUP_PATTERN.test(name)) continue;
    try {
      await fs.unlink(path.join(resolvedRoot, name));
      removed++;
    } catch {
      // ignore individual failures
    }
  }
  return removed;
};

export const pruneBackupDirectory = async (
  backupDir: string,
  retentionDays = DEFAULT_BACKUP_RETENTION_DAYS,
): Promise<number> => {
  const resolved = path.resolve(backupDir);
  const cutoffMs = Date.now() - retentionDays * 86400 * 1000;
  let removed = 0;

  let entries;
  try {
    entries = await fs.readdir(resolved);
  } catch {
    return 0;
  }

  for (const name of entries) {
    const filePath = path.join(resolved, name);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs >= cutoffMs) continue;
      await fs.unlink(filePath);
      removed++;
    } catch {
      // ignore individual failures
    }
  }
  return removed;
};

export const pruneTempTestDirectories = async (): Promise<number> => {
  const tmpRoot = path.resolve('/tmp');
  let removed = 0;
  let entries;
  try {
    entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  const cutoffMs = Date.now() - 86400 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory() || !TEMP_TEST_DIR_PATTERN.test(entry.name)) continue;
    const dirPath = path.join(tmpRoot, entry.name);
    try {
      const stat = await fs.stat(dirPath);
      if (stat.mtimeMs >= cutoffMs) continue;
      await fs.rm(dirPath, { recursive: true, force: true });
      removed++;
    } catch {
      // ignore individual failures
    }
  }
  return removed;
};

export const runDiskMaintenance = async (
  appRoot = process.cwd(),
): Promise<DiskMaintenanceResult> => {
  const before = getDiskMetrics();
  logDiskPressure('disk-maintenance');

  const orphanTempsRemoved = await cleanupOrphanTempFiles();
  const staleBackupDirsRemoved = await removeStaleBackupDirectories(appRoot, config.dataDir);
  const envBackupsRemoved = await pruneEnvBackupFiles(appRoot);
  const backupFilesPruned = await pruneBackupDirectory(
    path.join(appRoot, 'backups'),
    parseInt(process.env.BACKUP_RETENTION_DAYS || String(DEFAULT_BACKUP_RETENTION_DAYS), 10),
  );
  const tempTestDirsRemoved =
    before.status !== 'ok' ? await pruneTempTestDirectories() : 0;

  const walCheckpointed = checkpointWalIfDiskPressure();
  const retentionRowsRemoved = runRetentionCleanupWithDiskPressure();
  const vacuumed = vacuumDatabaseIfDiskPressure();

  const after = getDiskMetrics();
  const result: DiskMaintenanceResult = {
    statusBefore: before.status,
    statusAfter: after.status,
    orphanTempsRemoved,
    staleBackupDirsRemoved,
    envBackupsRemoved,
    backupFilesPruned,
    tempTestDirsRemoved,
    retentionRowsRemoved,
    walCheckpointed,
    vacuumed,
  };

  if (
    orphanTempsRemoved > 0 ||
    staleBackupDirsRemoved > 0 ||
    envBackupsRemoved > 0 ||
    backupFilesPruned > 0 ||
    tempTestDirsRemoved > 0 ||
    retentionRowsRemoved > 0 ||
    vacuumed
  ) {
    log.info(
      {
        ...result,
        usedPercentBefore: before.usedPercent,
        usedPercentAfter: after.usedPercent,
        availableMbBefore: Math.floor(before.availableBytes / 1024 / 1024),
        availableMbAfter: Math.floor(after.availableBytes / 1024 / 1024),
      },
      'Disk maintenance completed',
    );
  }

  return result;
};

export const startDiskMaintenanceScheduler = (
  appRoot = process.cwd(),
): NodeJS.Timeout => {
  const intervalMs = parseInt(
    process.env.DISK_MAINTENANCE_INTERVAL_MS || String(DEFAULT_MAINTENANCE_INTERVAL_MS),
    10,
  );

  const tick = () => {
    void runDiskMaintenance(appRoot).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ err: message }, 'Scheduled disk maintenance failed (non-fatal)');
    });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
};
