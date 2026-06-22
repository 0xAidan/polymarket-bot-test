/**
 * Discovery v3 preflight for server sizing and budget planning.
 *
 * This script does two things:
 * 1) Verifies the current machine can safely run the requested mode.
 * 2) Computes deterministic monthly cost from caller-supplied pricing inputs.
 *
 * Usage:
 *   npx tsx scripts/backfill/00_preflight_capacity.ts --mode full-backfill
 *   npx tsx scripts/backfill/00_preflight_capacity.ts --mode forward-only
 *
 * Optional pricing env vars for exact cost math:
 *   COST_SERVER_USD_MONTH
 *   COST_STORAGE_USD_MONTH
 *   COST_RPC_USD_PER_1M_CALLS
 *   EST_RPC_CALLS_PER_DAY
 */
import os from 'os';
import { mkdirSync, statfsSync } from 'fs';

type Mode = 'forward-only' | 'full-backfill';

interface Profile {
  mode: Mode;
  minCpuCores: number;
  minRamGiB: number;
  minDiskGiB: number;
  recommendedCpuCores: number;
  recommendedRamGiB: number;
  recommendedDiskGiB: number;
  notes: string[];
}

const USERS_PARQUET_GIB = 51.5;
const DUCKDB_WORKING_SET_GIB = 90;
const TEMP_SPILL_GIB = 120;
const SAFETY_GIB = 40;

const profiles: Record<Mode, Profile> = {
  'forward-only': {
    mode: 'forward-only',
    minCpuCores: 4,
    minRamGiB: 12,
    minDiskGiB: 100,
    recommendedCpuCores: 4,
    recommendedRamGiB: 16,
    recommendedDiskGiB: 160,
    notes: [
      'Runs hourly RPC ingest + hourly refresh.',
      'Assumes historical backfill is already complete elsewhere.',
    ],
  },
  'full-backfill': {
    mode: 'full-backfill',
    minCpuCores: 8,
    minRamGiB: 24,
    minDiskGiB: Math.ceil(USERS_PARQUET_GIB + DUCKDB_WORKING_SET_GIB + TEMP_SPILL_GIB + SAFETY_GIB),
    recommendedCpuCores: 8,
    recommendedRamGiB: 32,
    recommendedDiskGiB: 400,
    notes: [
      'Supports scripts 00→07, including large DuckDB spill phases.',
      'Uses safety headroom so scoring and indexing do not thrash disk.',
    ],
  },
};

function parseMode(argv: string[]): Mode {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') {
      const value = argv[i + 1];
      if (value === 'forward-only' || value === 'full-backfill') {
        return value;
      }
      throw new Error(`Invalid --mode "${value}". Use forward-only|full-backfill.`);
    }
  }
  return 'full-backfill';
}

function toGiB(bytes: number): number {
  return bytes / (1024 ** 3);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function main(): void {
  const mode = parseMode(process.argv.slice(2));
  const profile = profiles[mode];

  const dataDir = process.env.DATA_DIR || './data';
  mkdirSync(dataDir, { recursive: true });
  const fsStats: any = statfsSync(dataDir);
  const freeDiskGiB = toGiB(Number(fsStats.bavail) * Number(fsStats.bsize));
  const totalRamGiB = toGiB(os.totalmem());
  const cpuCores = os.cpus().length;

  const cpuOk = cpuCores >= profile.minCpuCores;
  const ramOk = totalRamGiB >= profile.minRamGiB;
  const diskOk = freeDiskGiB >= profile.minDiskGiB;
  const pass = cpuOk && ramOk && diskOk;

  const serverUsdMonth = numberFromEnv('COST_SERVER_USD_MONTH', 0);
  const storageUsdMonth = numberFromEnv('COST_STORAGE_USD_MONTH', 0);
  const rpcUsdPer1M = numberFromEnv('COST_RPC_USD_PER_1M_CALLS', 0);
  const rpcCallsPerDay = numberFromEnv('EST_RPC_CALLS_PER_DAY', 0);
  const rpcUsdDay = (rpcCallsPerDay / 1_000_000) * rpcUsdPer1M;
  const rpcUsdMonth = rpcUsdDay * 30;
  const totalUsdMonth = serverUsdMonth + storageUsdMonth + rpcUsdMonth;
  const totalUsdDay = totalUsdMonth / 30;

  console.log(`[preflight] mode=${mode}`);
  console.log(`[preflight] machine cpu=${cpuCores} cores, ram=${totalRamGiB.toFixed(1)} GiB, freeDisk=${freeDiskGiB.toFixed(1)} GiB (${dataDir})`);
  console.log(`[preflight] minimum cpu>=${profile.minCpuCores}, ram>=${profile.minRamGiB} GiB, disk>=${profile.minDiskGiB} GiB`);
  console.log(
    `[preflight] recommended cpu=${profile.recommendedCpuCores}, ram=${profile.recommendedRamGiB} GiB, disk=${profile.recommendedDiskGiB} GiB`
  );
  for (const note of profile.notes) {
    console.log(`[preflight] note: ${note}`);
  }

  if (mode === 'full-backfill') {
    console.log(
      `[preflight] disk breakdown (GiB): users.parquet=${USERS_PARQUET_GIB}, duckdb_working_set~${DUCKDB_WORKING_SET_GIB}, temp_spill~${TEMP_SPILL_GIB}, safety=${SAFETY_GIB}`
    );
  }

  if (serverUsdMonth > 0 || storageUsdMonth > 0 || rpcUsdPer1M > 0 || rpcCallsPerDay > 0) {
    console.log('[preflight] cost model (set by env):');
    console.log(`  server: ${formatUsd(serverUsdMonth)}/mo`);
    console.log(`  storage: ${formatUsd(storageUsdMonth)}/mo`);
    console.log(`  rpc: ${formatUsd(rpcUsdMonth)}/mo (${rpcCallsPerDay.toLocaleString('en-US')} calls/day @ ${formatUsd(rpcUsdPer1M)}/1M)`);
    console.log(`  total: ${formatUsd(totalUsdMonth)}/mo (${formatUsd(totalUsdDay)}/day)`);
  } else {
    console.log('[preflight] cost model skipped (set COST_* env vars for exact pricing math).');
  }

  if (!pass) {
    const blockers: string[] = [];
    if (!cpuOk) blockers.push(`cpu ${cpuCores} < ${profile.minCpuCores}`);
    if (!ramOk) blockers.push(`ram ${totalRamGiB.toFixed(1)} < ${profile.minRamGiB} GiB`);
    if (!diskOk) blockers.push(`disk ${freeDiskGiB.toFixed(1)} < ${profile.minDiskGiB} GiB`);
    console.error(`[preflight] FAIL: ${blockers.join(', ')}`);
    process.exit(2);
  }

  console.log('[preflight] PASS');
}

try {
  main();
} catch (err) {
  console.error('[preflight] failed:', err);
  process.exit(1);
}
