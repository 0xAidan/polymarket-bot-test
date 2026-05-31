/**
 * One-shot RPC forward-fill probe (last ~300 blocks).
 *   npx tsx scripts/diagnostics/rpc_poll_probe.ts
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrations } from '../../src/discovery/v3/duckdbSchema.js';
import { runV3SqliteMigrations } from '../../src/discovery/v3/schema.js';
import { createSqliteCursorStore } from '../../src/discovery/v3/goldskyListener.js';
import {
  createHttpRpcClient,
  pollRpcLogsOnce,
  getDefaultRpcUrl,
} from '../../src/discovery/v3/rpcLogPoller.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { config } from '../../src/config.js';
import { join } from 'path';

async function main(): Promise<void> {
  const duckPath = getDuckDBPath();
  mkdirSync(dirname(duckPath), { recursive: true });
  const sqlitePath = join(config.dataDir, 'copytrade.db');
  const sqlite = new Database(sqlitePath);
  runV3SqliteMigrations(sqlite);
  const duck = await openDuckDB(duckPath);
  await runV3DuckDBMigrations((sql) => duck.exec(sql));
  const client = createHttpRpcClient(getDefaultRpcUrl());
  const r = await pollRpcLogsOnce({
    duck,
    cursor: createSqliteCursorStore(sqlite),
    client,
    initialLookbackBlocks: Number(process.env.PROBE_LOOKBACK_BLOCKS ?? 300),
  });
  const rows = await duck.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3');
  console.log(JSON.stringify({
    rpcUrl: getDefaultRpcUrl(),
    result: r,
    activityRows: Number(rows[0]?.c ?? 0),
  }, null, 2));
  await duck.close();
  sqlite.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
