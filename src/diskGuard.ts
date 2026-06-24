import { statfsSync, statSync } from 'fs';
import path from 'path';
import { config } from './config.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('DiskGuard');

export type DiskHealthStatus = 'ok' | 'degraded' | 'critical';

export type DiskMetrics = {
  path: string;
  totalBytes: number;
  freeBytes: number;
  availableBytes: number;
  usedPercent: number;
  status: DiskHealthStatus;
};

export class DiskSpaceError extends Error {
  readonly code = 'DISK_FULL';

  constructor(message: string) {
    super(message);
    this.name = 'DiskSpaceError';
  }
}

const MIN_WRITE_BYTES = 50 * 1024 * 1024;

const resolveStatus = (usedPercent: number, availableBytes: number): DiskHealthStatus => {
  if (availableBytes < MIN_WRITE_BYTES || usedPercent >= 98) return 'critical';
  if (usedPercent >= 90 || availableBytes < 512 * 1024 * 1024) return 'degraded';
  return 'ok';
};

export type DiskBreakdownEntry = {
  path: string;
  bytes: number;
};

const BREAKDOWN_CANDIDATES = [
  'copytrade.db',
  'copytrade.db-wal',
  'discovery_v3.duckdb',
  'discovery_v3.duckdb-wal',
];

export const getDiskBreakdown = (dataDir?: string): DiskBreakdownEntry[] => {
  const resolved = path.resolve(dataDir || config.dataDir || process.cwd());
  const entries: DiskBreakdownEntry[] = [];

  for (const name of BREAKDOWN_CANDIDATES) {
    const filePath = path.join(resolved, name);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      entries.push({ path: name, bytes: stat.size });
    } catch {
      // file may not exist
    }
  }

  return entries.sort((a, b) => b.bytes - a.bytes);
};

export const getDiskMetrics = (targetPath?: string): DiskMetrics => {
  const resolved = path.resolve(targetPath || config.dataDir || process.cwd());
  const stats = statfsSync(resolved);
  const blockSize = stats.bsize;
  const totalBytes = stats.blocks * blockSize;
  const freeBytes = stats.bfree * blockSize;
  const availableBytes = stats.bavail * blockSize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  const status = resolveStatus(usedPercent, availableBytes);

  return {
    path: resolved,
    totalBytes,
    freeBytes,
    availableBytes,
    usedPercent: Math.round(usedPercent * 10) / 10,
    status,
  };
};

export const assertDiskWritable = (targetPath?: string, minBytes = MIN_WRITE_BYTES): void => {
  const metrics = getDiskMetrics(targetPath);
  if (metrics.status === 'critical' || metrics.availableBytes < minBytes) {
    throw new DiskSpaceError(
      `Disk space is critically low (${metrics.usedPercent}% used, ${Math.floor(metrics.availableBytes / 1024 / 1024)} MiB available). Free space before saving.`
    );
  }
};

export const isEnospcError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const err = error as NodeJS.ErrnoException;
  return err.code === 'ENOSPC' || err.code === 'EDQUOT';
};

export const logDiskPressure = (context: string): void => {
  try {
    const metrics = getDiskMetrics();
    if (metrics.status === 'ok') return;
    log.warn({ context, metrics }, 'Disk space pressure detected');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ context, err: message }, 'Unable to read disk metrics');
  }
};

export const cleanupOrphanTempFiles = async (): Promise<number> => {
  const { promises: fs } = await import('fs');
  const dataDir = config.dataDir;
  let removed = 0;
  try {
    const entries = await fs.readdir(dataDir);
    for (const name of entries) {
      if (!name.includes('.tmp')) continue;
      try {
        await fs.unlink(path.join(dataDir, name));
        removed++;
      } catch {
        // ignore individual failures
      }
    }
  } catch {
    // data dir may not exist yet
  }
  if (removed > 0) {
    log.info({ removed }, 'Removed orphan temp files from data directory');
  }
  return removed;
};
