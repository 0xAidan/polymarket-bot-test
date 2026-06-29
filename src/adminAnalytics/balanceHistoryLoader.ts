import { promises as fs } from 'fs';
import path from 'path';
import { realpath } from 'fs/promises';
import { config } from '../config.js';
import { sanitizeTenantIdForFile } from './tradeMetricsLoader.js';

export type BalanceSnapshot = {
  timestamp: Date;
  balance: number;
};

export type WalletBalanceHistory = {
  address: string;
  snapshots: BalanceSnapshot[];
};

const TENANT_ID_RE = /^[A-Za-z0-9_-]+$/;

const resolveSafeBalanceHistoryPath = async (tenantId: string): Promise<string | null> => {
  if (!TENANT_ID_RE.test(tenantId)) {
    return null;
  }

  const safeId = sanitizeTenantIdForFile(tenantId);
  const candidate = path.resolve(config.dataDir, `balance_history_${safeId}.json`);
  const dataRoot = await realpath(config.dataDir).catch(() => path.resolve(config.dataDir));
  const resolved = await realpath(candidate).catch(() => candidate);

  if (!resolved.startsWith(dataRoot)) {
    return null;
  }

  return resolved;
};

export const loadBalanceHistoryForTenant = async (
  tenantId: string,
): Promise<Map<string, WalletBalanceHistory>> => {
  const filePath = await resolveSafeBalanceHistoryPath(tenantId);
  if (!filePath) {
    return new Map();
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return new Map();
  }

  const parsed = JSON.parse(raw) as Record<string, { address: string; snapshots: Array<{ timestamp: string; balance: number }> }>;
  const store = new Map<string, WalletBalanceHistory>();

  for (const [addressKey, walletHistory] of Object.entries(parsed)) {
    store.set(addressKey.toLowerCase(), {
      address: walletHistory.address,
      snapshots: (walletHistory.snapshots ?? []).map((snapshot) => ({
        timestamp: new Date(snapshot.timestamp),
        balance: snapshot.balance,
      })),
    });
  }

  return store;
};

export type InferredBalanceActivity = {
  timestamp: string;
  type: 'inferred_deposit' | 'inferred_withdrawal';
  deltaUsd: number;
};

export const inferBalanceActivity = (
  snapshots: BalanceSnapshot[],
  thresholdUsd = 1,
): InferredBalanceActivity[] => {
  if (snapshots.length < 2) {
    return [];
  }

  const sorted = [...snapshots].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const activity: InferredBalanceActivity[] = [];

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const delta = curr.balance - prev.balance;
    if (Math.abs(delta) < thresholdUsd) {
      continue;
    }
    activity.push({
      timestamp: curr.timestamp.toISOString(),
      type: delta > 0 ? 'inferred_deposit' : 'inferred_withdrawal',
      deltaUsd: Math.round(Math.abs(delta) * 100) / 100,
    });
  }

  return activity;
};
