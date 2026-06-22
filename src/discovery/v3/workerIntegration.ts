/**
 * Thin bootstrap that `discoveryWorker.ts` calls behind the DISCOVERY_V3 flag.
 * Owns the DuckDB connection, Goldsky listener interval, and refresh loop.
 * No-op when the flag is off.
 */
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type Database from 'better-sqlite3';
import { parseNullableBooleanInput } from '../../utils/booleanParsing.js';
import { isDiscoveryV3Enabled, isDiscoveryV3GoldskyEnabled, isDiscoveryV3RpcPollEnabled, getDuckDBPath, getRpcPollIntervalMs } from './featureFlag.js';
import { openDuckDB, DuckDBClient } from './duckdbClient.js';
import { saveDiscoveryV3WorkerState } from './workerState.js';
import {
  runV3DuckDBMigrations,
  runV3DuckDBMigrationsBackfillNoIndex,
} from './duckdbSchema.js';
import { applyV3SqliteMigrationsIfEnabled } from './migrations.js';
import {
  createGoldskyClient,
  createSqliteCursorStore,
  pollGoldskyOnce,
} from './goldskyListener.js';
import { startRefreshLoop, RefreshLoopHandle } from './refreshWorker.js';
import {
  createHttpRpcClient,
  getDefaultRpcHeaders,
  pollRpcLogsOnce,
  getDefaultRpcUrl,
} from './rpcLogPoller.js';

export interface V3WorkerHandle {
  stop(): Promise<void>;
  duck: DuckDBClient;
}

export interface V3WorkerOptions {
  sqlite: Database.Database;
  goldskyIntervalMs?: number;
  refreshIntervalMs?: number;
  log?: (msg: string) => void;
}

/** Large backfilled DBs: creating ART indexes on discovery_activity_v3 can OOM (DuckDB 1.4.x). */
const skipActivityArtIndexes = (): boolean =>
  parseNullableBooleanInput(process.env.DISCOVERY_V3_SKIP_ACTIVITY_ART_INDEXES) === true;

export async function startDiscoveryV3Worker(
  opts: V3WorkerOptions
): Promise<V3WorkerHandle | null> {
  if (!isDiscoveryV3Enabled()) return null;
  const log = opts.log ?? ((m: string) => console.log(m));

  applyV3SqliteMigrationsIfEnabled(opts.sqlite);

  const dbPath = getDuckDBPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const duck = await openDuckDB(dbPath);
  if (skipActivityArtIndexes()) {
    log(
      '[v3] skip activity ART indexes (DISCOVERY_V3_SKIP_ACTIVITY_ART_INDEXES); live dupes need offline index or dedup'
    );
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => duck.exec(sql));
  } else {
    await runV3DuckDBMigrations((sql) => duck.exec(sql));
  }
  log(`[v3] DuckDB open at ${dbPath}`);
  log(
    `[v3] coverage contract source=${process.env.DISCOVERY_V3_HISTORICAL_BACKFILL_SOURCE || 'huggingface:SII-WANGZJ/Polymarket_data/users.parquet'} max_ts=${process.env.DISCOVERY_V3_HISTORICAL_COVERAGE_MAX_TS || '1772668800'}`
  );

  // Goldsky live listener — disabled post-V2 cutover unless DISCOVERY_V3_GOLDSKY_ENABLED=true
  // (subgraph 0.0.1 uses V1 OrderFilled schema; chain listener + Data API poller cover V2).
  let goldskyTimer: ReturnType<typeof setInterval> | null = null;
  if (isDiscoveryV3GoldskyEnabled()) {
    const client = createGoldskyClient();
    const cursor = createSqliteCursorStore(opts.sqlite);
    const goldskyInterval = opts.goldskyIntervalMs ?? 5 * 60 * 1000;
    let goldskyRunning = false;
    goldskyTimer = setInterval(() => {
      if (goldskyRunning) return;
      goldskyRunning = true;
      void (async () => {
        try {
          const r = await pollGoldskyOnce({ duck, cursor, client });
          if (r.fetched > 0) log(`[v3-goldsky] fetched=${r.fetched} inserted=${r.inserted} cursor=${r.newCursor}`);
        } catch (err) {
          log(`[v3-goldsky] error: ${(err as Error).message}`);
        } finally {
          goldskyRunning = false;
        }
      })();
    }, goldskyInterval);
    log(`[v3] Goldsky listener active (interval ${goldskyInterval / 1000}s)`);
  } else {
    log(
      '[v3] Goldsky listener disabled — V2 cutover passed and subgraph 0.0.1 is V1-shaped. ' +
        'Set DISCOVERY_V3_GOLDSKY_ENABLED=true to force-enable. Copy-trading uses Data API + chain listener.',
    );
  }

  // Polygon HTTP eth_getLogs — hourly forward-fill (budget-friendly, V1+V2).
  let rpcTimer: ReturnType<typeof setInterval> | null = null;
  if (isDiscoveryV3RpcPollEnabled()) {
    const rpcUrl = getDefaultRpcUrl();
    const rpcHeaders = getDefaultRpcHeaders();
    const rpcClient = createHttpRpcClient(rpcUrl, fetch, rpcHeaders);
    const rpcCursor = createSqliteCursorStore(opts.sqlite);
    const rpcInterval = getRpcPollIntervalMs();
    let rpcRunning = false;
    const runRpcPoll = async (): Promise<void> => {
      if (rpcRunning) return;
      rpcRunning = true;
      try {
        const r = await pollRpcLogsOnce({ duck, cursor: rpcCursor, client: rpcClient });
        if (r.logsFetched > 0 || r.inserted > 0) {
          log(
            `[v3-rpc] blocks=${r.fromBlock}-${r.toBlock} logs=${r.logsFetched} inserted=${r.inserted} rpc_calls_est=${r.rpcCallsEstimated} cursor=${r.newCursor}`
          );
        }
      } catch (err) {
        log(`[v3-rpc] error: ${(err as Error).message}`);
      } finally {
        rpcRunning = false;
      }
    };
    void runRpcPoll();
    rpcTimer = setInterval(() => { void runRpcPoll(); }, rpcInterval);
    const rpcHeaderKeys = Object.keys(rpcHeaders);
    const headerNote =
      rpcHeaderKeys.length > 0 ? `, headers=${rpcHeaderKeys.join(',')}` : '';
    log(`[v3] RPC log poller active (${rpcUrl}, interval ${rpcInterval / 1000}s${headerNote})`);
  } else {
    log('[v3] RPC log poller disabled (DISCOVERY_V3_RPC_POLL_ENABLED=false)');
  }

  // Refresh loop
  const refresh: RefreshLoopHandle = startRefreshLoop({
    duck,
    sqlite: opts.sqlite,
    intervalMs: opts.refreshIntervalMs,
    log,
  });

  log('[v3] live ingest + refresh loop started');

  saveDiscoveryV3WorkerState({
    enabled: true,
    bootstrapOk: true,
    goldskyEnabled: isDiscoveryV3GoldskyEnabled(),
    rpcPollEnabled: isDiscoveryV3RpcPollEnabled(),
    duckdbPath: dbPath,
    updatedAt: Math.floor(Date.now() / 1000),
  });

  return {
    duck,
    async stop(): Promise<void> {
      if (goldskyTimer) clearInterval(goldskyTimer);
      if (rpcTimer) clearInterval(rpcTimer);
      refresh.stop();
      await duck.close();
    },
  };
}
