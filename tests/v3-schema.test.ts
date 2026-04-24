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

test('discovery_wallet_scores_v3 allows one row per (wallet, tier) pair', async () => {
  // Regression test: rev5 fixed a PK-on-wallet-only bug. The tier scorer
  // emits each eligible wallet across alpha + whale + specialist, which
  // requires composite PK (proxy_wallet, tier).
  const Database = (await import('better-sqlite3')).default;
  const { runV3SqliteMigrations } = await import('../src/discovery/v3/schema.ts');
  const db = new Database(':memory:');
  try {
    runV3SqliteMigrations(db);
    const ins = db.prepare(
      `INSERT INTO discovery_wallet_scores_v3
         (proxy_wallet, tier, tier_rank, score, volume_total, trade_count,
          distinct_markets, closed_positions, realized_pnl, hit_rate,
          last_active_ts, reasons_json, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const w = '0xaaaa';
    ins.run(w, 'alpha', 1, 0.9, 1000, 10, 5, 3, 100, 0.6, 1700000000, '[]', 1700000100);
    ins.run(w, 'whale', 2, 0.8, 1000, 10, 5, 3, 100, 0.6, 1700000000, '[]', 1700000100);
    ins.run(w, 'specialist', 3, 0.7, 1000, 10, 5, 3, 100, 0.6, 1700000000, '[]', 1700000100);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM discovery_wallet_scores_v3 WHERE proxy_wallet = ?').get(w) as { c: number }).c;
    assert.equal(count, 3, 'wallet should be allowed across 3 tiers');
    // But (wallet, tier) must still be unique:
    assert.throws(
      () => ins.run(w, 'alpha', 99, 0.5, 1000, 10, 5, 3, 100, 0.6, 1700000000, '[]', 1700000100),
      /UNIQUE|constraint/i,
      'duplicate (wallet, tier) must be rejected'
    );
  } finally {
    db.close();
  }
});

test('runV3SqliteMigrations upgrades legacy (proxy_wallet-only PK) schema', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { runV3SqliteMigrations } = await import('../src/discovery/v3/schema.ts');
  const db = new Database(':memory:');
  try {
    // Simulate the pre-rev5 schema
    db.exec(`CREATE TABLE discovery_wallet_scores_v3 (
      proxy_wallet        TEXT PRIMARY KEY,
      tier                TEXT NOT NULL,
      tier_rank           INTEGER NOT NULL,
      score               REAL NOT NULL,
      volume_total        REAL NOT NULL,
      trade_count         INTEGER NOT NULL,
      distinct_markets    INTEGER NOT NULL,
      closed_positions    INTEGER NOT NULL,
      realized_pnl        REAL NOT NULL,
      hit_rate            REAL,
      last_active_ts      INTEGER NOT NULL,
      reasons_json        TEXT NOT NULL,
      updated_at          INTEGER NOT NULL
    )`);
    runV3SqliteMigrations(db);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='discovery_wallet_scores_v3'").get() as { sql: string }).sql;
    assert.match(sql, /PRIMARY KEY \(proxy_wallet, tier\)/i, 'schema must be upgraded to composite PK');
  } finally {
    db.close();
  }
});
