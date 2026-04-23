import test from 'node:test';
import assert from 'node:assert/strict';

import { openDuckDB } from '../src/discovery/v3/duckdbClient.ts';
import {
  runV3DuckDBMigrations,
  runV3DuckDBMigrationsBackfillNoIndex,
  V3_ACTIVITY_INDEX_DDL,
} from '../src/discovery/v3/duckdbSchema.ts';

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

test('runV3DuckDBMigrationsBackfillNoIndex creates tables but skips activity ART indexes', async () => {
  // 2026-04-23 "backfill-skips-indexes" invariant. If this test breaks, the
  // backfill will OOM on the Hetzner 8GB box when 04/05 trigger index build
  // on 800M rows. See src/discovery/v3/duckdbSchema.ts for the full story.
  const db = openDuckDB(':memory:');
  try {
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => db.exec(sql));
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
    );
    const names = tables.map((r) => r.table_name);
    assert.ok(names.includes('discovery_activity_v3'));
    assert.ok(names.includes('markets_v3'));
    assert.ok(names.includes('discovery_feature_snapshots_v3'));

    const indexes = await db.query<{ index_name: string }>(
      "SELECT index_name FROM duckdb_indexes() WHERE table_name = 'discovery_activity_v3'"
    );
    assert.equal(
      indexes.length,
      0,
      `backfill migration must not create ART indexes on discovery_activity_v3; found: ${indexes.map((r) => r.index_name).join(',')}`
    );

    // Duplicate inserts must NOT throw when index is absent — this is the
    // whole point. Uniqueness is enforced upstream by 02c bucket-local dedup.
    await db.exec("INSERT INTO discovery_activity_v3 VALUES ('0xAAA','m1','c1',NULL,100,1,'tx1',0,'maker','BUY',0.5,10.0,10.0,10.0)");
    await db.exec("INSERT INTO discovery_activity_v3 VALUES ('0xAAA','m1','c1',NULL,101,2,'tx1',0,'maker','BUY',0.5,10.0,10.0,10.0)");
    const rows = await db.query<{ c: number }>(
      "SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3 WHERE tx_hash = 'tx1' AND log_index = 0"
    );
    assert.equal(Number(rows[0].c), 2, 'no UNIQUE constraint in backfill mode, both inserts land');

    assert.equal(V3_ACTIVITY_INDEX_DDL.length, 3, 'live DDL still publishes 3 activity indexes');
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
