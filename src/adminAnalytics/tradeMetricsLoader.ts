import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { DEFAULT_TENANT_ID } from '../tenantContext.js';
import type { TradeMetricsFileRow } from './adminAnalyticsTypes.js';

const MAX_METRICS_FILE_BYTES = 25 * 1024 * 1024;
const TENANT_ID_RE = /^[A-Za-z0-9_-]+$/;

export const sanitizeTenantIdForFile = (tenantId: string): string => (
  tenantId.replace(/[^A-Za-z0-9_-]/g, '_')
);

export const metricsFilePathForTenant = (tenantId: string): string => (
  path.join(config.dataDir, `trade_metrics_${sanitizeTenantIdForFile(tenantId)}.json`)
);

export const discoverMetricsTenantIds = async (): Promise<string[]> => {
  let files: string[] = [];
  try {
    files = await fs.readdir(config.dataDir);
  } catch {
    return [];
  }

  const ids = files
    .filter((file) => file.startsWith('trade_metrics_') && file.endsWith('.json'))
    .map((file) => file.slice('trade_metrics_'.length, -'.json'.length));

  return [...new Set(ids)];
};

export const loadTradeMetricsForTenant = async (tenantId: string): Promise<TradeMetricsFileRow[]> => {
  if (!TENANT_ID_RE.test(tenantId) && tenantId !== DEFAULT_TENANT_ID) {
    return [];
  }

  const filePath = metricsFilePathForTenant(tenantId);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return [];
  }

  if (stat.size > MAX_METRICS_FILE_BYTES) {
    throw new Error(`Trade metrics file too large for tenant ${tenantId}`);
  }

  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.map((row: TradeMetricsFileRow) => ({
    ...row,
    timestamp: new Date(row.timestamp),
  }));
};
