/**
 * Phase 1.5 step 4: emit point-in-time daily snapshots into
 * discovery_feature_snapshots_v3. See `src/discovery/v3/backfillQueries.ts`
 * for the SQL. Deterministic: running twice produces identical output.
 */
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrations } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { buildSnapshotEmitSql } from '../../src/discovery/v3/backfillQueries.js';

async function main(): Promise<void> {
  const db = openDuckDB(getDuckDBPath());
  try {
    await runV3DuckDBMigrations((sql) => db.exec(sql));
    console.log('[04] clearing old snapshots (determinism requires full rebuild)');
    await db.exec('DELETE FROM discovery_feature_snapshots_v3');
    console.log('[04] emitting snapshots…');
    const t0 = Date.now();
    await db.exec(buildSnapshotEmitSql());
    const c = (await db.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_feature_snapshots_v3'))[0].c;
    console.log(`[04] wrote ${c} snapshot rows in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    await db.close();
  }
  console.log('[04] done.');
}

main().catch((err) => {
  console.error('[04] failed:', err);
  process.exit(1);
});
