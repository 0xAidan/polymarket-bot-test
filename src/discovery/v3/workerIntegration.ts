/**
 * Thin bootstrap that `discoveryWorker.ts` calls behind the DISCOVERY_V3 flag.
 * Owns the DuckDB connection, Goldsky listener interval, and refresh loop.
 * No-op when the flag is off.
 */
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type Database from 'better-sqlite3';
import { isDiscoveryV3Enabled, getDuckDBPath } from './featureFlag.js';
import { openDuckDB, DuckDBClient } from './duckdbClient.js';
import { runV3DuckDBMigrations } from './duckdbSchema.js';
import { applyV3SqliteMigrationsIfEnabled } from './migrations.js';
import {
  createGoldskyClient,
  createSqliteCursorStore,
  pollGoldskyOnce,
} from './goldskyListener.js';
import { startRefreshLoop, RefreshLoopHandle } from './refreshWorker.js';

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

export async function startDiscoveryV3Worker(
  opts: V3WorkerOptions
): Promise<V3WorkerHandle | null> {
  if (!isDiscoveryV3Enabled()) return null;
  const log = opts.log ?? ((m: string) => console.log(m));

  applyV3SqliteMigrationsIfEnabled(opts.sqlite);

  const dbPath = getDuckDBPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const duck = openDuckDB(dbPath);
  await runV3DuckDBMigrations((sql) => duck.exec(sql));
  log(`[v3] DuckDB open at ${dbPath}`);

  // Goldsky live listener
  const client = createGoldskyClient();
  const cursor = createSqliteCursorStore(opts.sqlite);
  const goldskyInterval = opts.goldskyIntervalMs ?? 5 * 60 * 1000;
  let goldskyRunning = false;
  const goldskyTimer = setInterval(() => {
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

  // Refresh loop
  const refresh: RefreshLoopHandle = startRefreshLoop({
    duck,
    sqlite: opts.sqlite,
    intervalMs: opts.refreshIntervalMs,
    log,
  });

  log('[v3] live ingest + refresh loop started');

  return {
    duck,
    async stop(): Promise<void> {
      clearInterval(goldskyTimer);
      refresh.stop();
      await duck.close();
    },
  };
}
