import test from 'node:test';
import assert from 'node:assert/strict';

import { openDuckDB } from '../src/discovery/v3/duckdbClient.ts';
import { runV3DuckDBMigrations } from '../src/discovery/v3/duckdbSchema.ts';

test('DuckDB v3 DDL creates all tables + UNIQUE dedup index (idempotent)', async () => {
  const db = openDuckDB(':memory:');
  try {
    await runV3DuckDBMigrations((sql) => db.exec(sql));
    await runV3DuckDBMigrations((sql) => db.exec(sql));

    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
    );
    const names = tables.map((r) => r.table_name);
    assert.ok(names.includes('discovery_activity_v3'), 'discovery_activity_v3 missing');
    assert.ok(names.includes('markets_v3'), 'markets_v3 missing');
    assert.ok(names.includes('discovery_feature_snapshots_v3'), 'discovery_feature_snapshots_v3 missing');

    await db.exec("INSERT INTO discovery_activity_v3 VALUES ('0xAAA','m1','c1',NULL,100,1,'tx1',0,'maker','BUY',0.5,10.0,10.0,10.0)");
    let failed = false;
    try {
      await db.exec("INSERT INTO discovery_activity_v3 VALUES ('0xAAA','m1','c1',NULL,101,2,'tx1',0,'maker','BUY',0.5,10.0,10.0,10.0)");
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, 'UNIQUE(tx_hash, log_index) must reject duplicates');
  } finally {
    await db.close();
  }
});

test('SQLite v3 DDL idempotent on better-sqlite3', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { runV3SqliteMigrations } = await import('../src/discovery/v3/schema.ts');
  const db = new Database(':memory:');
  try {
    runV3SqliteMigrations(db);
    runV3SqliteMigrations(db);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('discovery_wallet_scores_v3'));
    assert.ok(names.includes('pipeline_cursor'));
  } finally {
    db.close();
  }
});
