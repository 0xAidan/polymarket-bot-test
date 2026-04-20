/**
 * Phase 1.5 step 1: initialize DuckDB file and apply v3 DDL. Idempotent.
 */
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrations } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

async function main(): Promise<void> {
  const path = getDuckDBPath();
  mkdirSync(dirname(path), { recursive: true });
  console.log(`[01] initializing DuckDB at ${path}`);
  const db = openDuckDB(path);
  try {
    await runV3DuckDBMigrations((sql) => db.exec(sql));
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name"
    );
    console.log('[01] tables:', tables.map((t) => t.table_name).join(', '));
  } finally {
    await db.close();
  }
  console.log('[01] done.');
}

main().catch((err) => {
  console.error('[01] failed:', err);
  process.exit(1);
});
