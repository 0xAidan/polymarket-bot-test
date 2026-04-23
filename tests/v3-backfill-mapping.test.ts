import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { openDuckDB } from '../src/discovery/v3/duckdbClient.ts';
import {
  buildActivityIndexSqlList,
  runV3DuckDBMigrations,
  runV3DuckDBMigrationsBackfillNoIndex,
} from '../src/discovery/v3/duckdbSchema.ts';
import {
  ACTIVITY_DEDUP_SWAP_SQL,
  buildActivityDedupCtasSql,
  buildEventIngestSqlAntiJoin,
  buildEventIngestSqlAntiJoinChunked,
  buildMarketsIngestSql,
  buildStagingCreateSql,
  buildStagingDropSql,
  buildStagingIngestSql,
  buildStagingToActivitySql,
  buildStagingSortToParquetSql,
  buildStagingSortBucketToParquetSql,
  buildSortBucketFromParquetToParquetSql,
  buildSortedParquetToActivitySql,
  buildSortedParquetToActivityRawSql,
} from '../src/discovery/v3/backfillQueries.ts';

async function runNoIndexLoadAndDedup(
  db: ReturnType<typeof openDuckDB>,
  bucketPaths: string[]
): Promise<void> {
  // Mirrors the production path: 02c raw-insert each bucket into an
  // index-less discovery_activity_v3, then 02d does the CTAS dedup +
  // index rebuild.
  for (const bp of bucketPaths) {
    await db.exec(buildSortedParquetToActivityRawSql(bp));
  }
  await db.exec('DROP TABLE IF EXISTS discovery_activity_v3_dedup');
  await db.exec(buildActivityDedupCtasSql());
  for (const sql of ACTIVITY_DEDUP_SWAP_SQL) await db.exec(sql);
  for (const sql of buildActivityIndexSqlList()) await db.exec(sql);
}

test('02_load_events: parquet → discovery_activity_v3 schema mapping + dedup', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'v3-map-'));
  const parquet = join(tmp, 'users.parquet');
  const db = openDuckDB(':memory:');
  try {
    // Build a synthetic users.parquet with the real schema quirks.
    await db.exec(`CREATE TABLE users_source (
      user VARCHAR, market_id VARCHAR, condition_id VARCHAR, event_id VARCHAR,
      timestamp BIGINT, block_number BIGINT, transaction_hash VARCHAR, log_index INTEGER,
      role VARCHAR, price DOUBLE, usd_amount DOUBLE, token_amount DOUBLE
    )`);
    await db.exec(`INSERT INTO users_source VALUES
      ('0xA','m1','c1','e1',1000,1,'tx1',0,'maker',0.5, 50.0,  100.0),
      ('0xA','m1','c1','e1',1001,1,'tx1',0,'maker',0.5, 50.0,  100.0),   -- duplicate, should dedupe
      ('0xB','m2','c2','e2',2000,2,'tx2',0,'taker',0.3, 30.0, -100.0),   -- SELL
      ('0xC','m3','c3',NULL,3000,3,'tx3',0,'MAKER',0.7, 70.0,  100.0),   -- role upper-cased in source
      ('0xD','m4','c4','e4',0,   4,'tx4',0,'taker',0.5, 50.0,  100.0),   -- timestamp 0 filtered
      ('0xE','m5','c5','e5',5000,5,'tx5',0,'taker',0.5, 50.0,    0.0),   -- token_amount 0 filtered
      ('0xF','m6','c6','e6',6000,6, NULL, 0,'taker',0.5, 50.0,  100.0),  -- tx_hash null filtered
      ('0xG','m7','c7','e7',7000,7,'tx7',1,'maker',0.9,  9.0,  -50.0)
    `);
    await db.exec(`COPY users_source TO '${parquet}' (FORMAT PARQUET)`);
    await db.exec(`DROP TABLE users_source`);

    await runV3DuckDBMigrations((sql) => db.exec(sql));
    await db.exec(buildEventIngestSqlAntiJoin(`read_parquet('${parquet}')`));
    await db.exec(buildEventIngestSqlAntiJoin(`read_parquet('${parquet}')`)); // idempotent re-ingest

    const rows = await db.query<{
      proxy_wallet: string; role: string; side: string; ts_unix: number; abs_size: number;
    }>(`SELECT proxy_wallet, role, side, CAST(ts_unix AS BIGINT) AS ts_unix, abs_size
          FROM discovery_activity_v3 ORDER BY proxy_wallet`);
    const wallets = rows.map((r) => r.proxy_wallet);
    assert.deepEqual(wallets, ['0xA', '0xB', '0xC', '0xG']);

    // Check mappings
    const a = rows.find((r) => r.proxy_wallet === '0xA')!;
    assert.equal(a.role, 'maker');
    assert.equal(a.side, 'BUY');
    assert.equal(Number(a.abs_size), 100);
    const b = rows.find((r) => r.proxy_wallet === '0xB')!;
    assert.equal(b.side, 'SELL');
    const c = rows.find((r) => r.proxy_wallet === '0xC')!;
    assert.equal(c.role, 'maker', 'role lowercased');
  } finally {
    await db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('02_load_events chunked: bucketed ingest matches unchunked result', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'v3-chunk-'));
  const parquet = join(tmp, 'users.parquet');
  const db = openDuckDB(':memory:');
  try {
    await db.exec(`CREATE TABLE users_source (
      user VARCHAR, market_id VARCHAR, condition_id VARCHAR, event_id VARCHAR,
      timestamp BIGINT, block_number BIGINT, transaction_hash VARCHAR, log_index INTEGER,
      role VARCHAR, price DOUBLE, usd_amount DOUBLE, token_amount DOUBLE
    )`);
    // 20 distinct tx hashes, plus a duplicate on tx5 to exercise dedup within a bucket.
    let values: string[] = [];
    for (let i = 1; i <= 20; i++) {
      values.push(`('0xW${i}','m${i}','c${i}','e${i}',${1000 + i},${i},'tx${i}',0,'maker',0.5,50.0,100.0)`);
    }
    values.push(`('0xW5','m5','c5','e5',1006,5,'tx5',0,'maker',0.5,50.0,100.0)`); // dup
    await db.exec(`INSERT INTO users_source VALUES ${values.join(',')}`);
    await db.exec(`COPY users_source TO '${parquet}' (FORMAT PARQUET)`);
    await db.exec(`DROP TABLE users_source`);

    await runV3DuckDBMigrations((sql) => db.exec(sql));

    const BUCKETS = 4;
    for (let b = 0; b < BUCKETS; b++) {
      await db.exec(buildEventIngestSqlAntiJoinChunked(`read_parquet('${parquet}')`, b, BUCKETS));
    }
    // Re-run to confirm idempotency across chunks.
    for (let b = 0; b < BUCKETS; b++) {
      await db.exec(buildEventIngestSqlAntiJoinChunked(`read_parquet('${parquet}')`, b, BUCKETS));
    }

    const rows = await db.query<{ c: number }>(`SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3`);
    assert.equal(Number(rows[0].c), 20, 'chunked ingest union should equal 20 distinct (tx_hash,log_index)');

    // Bucket assertions: union(bucket_i) must equal full set, intersection must be empty.
    const perBucket: number[] = [];
    for (let b = 0; b < BUCKETS; b++) {
      const r = await db.query<{ c: number }>(
        `SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3 WHERE (abs(hash(tx_hash)) % ${BUCKETS}) = ${b}`
      );
      perBucket.push(Number(r[0].c));
    }
    assert.equal(perBucket.reduce((a, b) => a + b, 0), 20, 'bucket counts sum to total');

    // Arg validation.
    assert.throws(() => buildEventIngestSqlAntiJoinChunked(`read_parquet('x')`, -1, 4), /bucketIdx/);
    assert.throws(() => buildEventIngestSqlAntiJoinChunked(`read_parquet('x')`, 4, 4), /bucketIdx/);
    assert.throws(() => buildEventIngestSqlAntiJoinChunked(`read_parquet('x')`, 0, 0), /totalBuckets/);
  } finally {
    await db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('02_load_events staging: two-phase streaming ingest equals single-shot result', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'v3-stage-'));
  const parquet = join(tmp, 'users.parquet');
  const db = openDuckDB(':memory:');
  try {
    // Same synthetic fixture as the first test — so the expected output is identical.
    await db.exec(`CREATE TABLE users_source (
      user VARCHAR, market_id VARCHAR, condition_id VARCHAR, event_id VARCHAR,
      timestamp BIGINT, block_number BIGINT, transaction_hash VARCHAR, log_index INTEGER,
      role VARCHAR, price DOUBLE, usd_amount DOUBLE, token_amount DOUBLE
    )`);
    await db.exec(`INSERT INTO users_source VALUES
      ('0xA','m1','c1','e1',1000,1,'tx1',0,'maker',0.5, 50.0,  100.0),
      ('0xA','m1','c1','e1',1001,1,'tx1',0,'maker',0.5, 50.0,  100.0),
      ('0xB','m2','c2','e2',2000,2,'tx2',0,'taker',0.3, 30.0, -100.0),
      ('0xC','m3','c3',NULL,3000,3,'tx3',0,'MAKER',0.7, 70.0,  100.0),
      ('0xD','m4','c4','e4',0,   4,'tx4',0,'taker',0.5, 50.0,  100.0),
      ('0xE','m5','c5','e5',5000,5,'tx5',0,'taker',0.5, 50.0,    0.0),
      ('0xF','m6','c6','e6',6000,6, NULL, 0,'taker',0.5, 50.0,  100.0),
      ('0xG','m7','c7','e7',7000,7,'tx7',1,'maker',0.9,  9.0,  -50.0)
    `);
    await db.exec(`COPY users_source TO '${parquet}' (FORMAT PARQUET)`);
    await db.exec(`DROP TABLE users_source`);
    await runV3DuckDBMigrations((sql) => db.exec(sql));

    // Two-phase path:
    await db.exec(buildStagingDropSql());
    await db.exec(buildStagingCreateSql());
    await db.exec(buildStagingIngestSql(`read_parquet('${parquet}')`));

    // Verify plan is HASH_GROUP_BY, not WINDOW — this is the whole point.
    const plan = await db.query<{ explain_key: string; explain_value: string }>(
      `EXPLAIN ${buildStagingToActivitySql()}`
    );
    const planText = plan.map((r) => r.explain_value).join('\n');
    assert.ok(planText.includes('HASH_GROUP_BY'), 'phase B uses HASH_GROUP_BY (streaming+spillable)');
    assert.ok(!planText.includes('WINDOW'), 'phase B must NOT use WINDOW operator (pinned memory)');

    await db.exec(buildStagingToActivitySql());
    await db.exec(buildStagingDropSql());

    const rows = await db.query<{
      proxy_wallet: string; role: string; side: string; ts_unix: number; abs_size: number;
      price_yes: number; usd_notional: number;
    }>(`SELECT proxy_wallet, role, side, CAST(ts_unix AS BIGINT) AS ts_unix,
               abs_size, price_yes, usd_notional
          FROM discovery_activity_v3 ORDER BY proxy_wallet`);

    const wallets = rows.map((r) => r.proxy_wallet);
    assert.deepEqual(wallets, ['0xA', '0xB', '0xC', '0xG'], 'same 4 wallets as single-shot path');

    const a = rows.find((r) => r.proxy_wallet === '0xA')!;
    assert.equal(a.role, 'maker');
    assert.equal(a.side, 'BUY');
    assert.equal(Number(a.abs_size), 100);
    assert.equal(Number(a.ts_unix), 1000, 'dedup picks smallest timestamp (matches ROW_NUMBER ORDER BY timestamp)');

    const b = rows.find((r) => r.proxy_wallet === '0xB')!;
    assert.equal(b.side, 'SELL');
    const c = rows.find((r) => r.proxy_wallet === '0xC')!;
    assert.equal(c.role, 'maker', 'role lowercased');
  } finally {
    await db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('02_load_events sort-based: external-sort-then-LAG dedup matches single-shot result', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'v3-sort-'));
  const parquet = join(tmp, 'users.parquet');
  const sortedParquet = join(tmp, 'sorted.parquet');
  const db = openDuckDB(':memory:');
  try {
    await db.exec(`CREATE TABLE users_source (
      user VARCHAR, market_id VARCHAR, condition_id VARCHAR, event_id VARCHAR,
      timestamp BIGINT, block_number BIGINT, transaction_hash VARCHAR, log_index INTEGER,
      role VARCHAR, price DOUBLE, usd_amount DOUBLE, token_amount DOUBLE
    )`);
    await db.exec(`INSERT INTO users_source VALUES
      ('0xA','m1','c1','e1',1000,1,'tx1',0,'maker',0.5, 50.0,  100.0),
      ('0xA','m1','c1','e1',1001,1,'tx1',0,'maker',0.5, 50.0,  100.0),
      ('0xB','m2','c2','e2',2000,2,'tx2',0,'taker',0.3, 30.0, -100.0),
      ('0xC','m3','c3',NULL,3000,3,'tx3',0,'MAKER',0.7, 70.0,  100.0),
      ('0xD','m4','c4','e4',0,   4,'tx4',0,'taker',0.5, 50.0,  100.0),
      ('0xE','m5','c5','e5',5000,5,'tx5',0,'taker',0.5, 50.0,    0.0),
      ('0xF','m6','c6','e6',6000,6, NULL, 0,'taker',0.5, 50.0,  100.0),
      ('0xG','m7','c7','e7',7000,7,'tx7',1,'maker',0.9,  9.0,  -50.0)
    `);
    await db.exec(`COPY users_source TO '${parquet}' (FORMAT PARQUET)`);
    await db.exec(`DROP TABLE users_source`);
    await runV3DuckDBMigrations((sql) => db.exec(sql));

    // New three-phase path: stage → external sort → streaming LAG dedup.
    await db.exec(buildStagingDropSql());
    await db.exec(buildStagingCreateSql());
    await db.exec(buildStagingIngestSql(`read_parquet('${parquet}')`));
    await db.exec(buildStagingSortToParquetSql(sortedParquet));
    await db.exec(buildStagingDropSql());

    // Verify plan for phase B2 (RAW path): the bucket INSERT MUST be a pure
    // projection — no GROUP BY, no arg_min, no ROW_NUMBER, no LAG. Dedup is
    // deferred to the separate CTAS step (buildActivityDedupCtasSql) so that
    // DuckDB never sees an aggregate-insert into a table with a UNIQUE INDEX
    // (the path that produced spurious "Duplicate key" errors in production).
    const rawSql = buildSortedParquetToActivityRawSql(sortedParquet);
    assert.ok(!/GROUP\s+BY/i.test(rawSql), 'phase B2 RAW path must NOT contain GROUP BY');
    assert.ok(!/arg_min\(/i.test(rawSql), 'phase B2 RAW path must NOT use arg_min');
    assert.ok(!/ROW_NUMBER\s*\(/i.test(rawSql), 'phase B2 RAW path must NOT use ROW_NUMBER');
    assert.ok(!/LAG\s*\(/i.test(rawSql), 'phase B2 RAW path must NOT use LAG');

    // And the dedup CTAS MUST use GROUP BY + arg_min.
    const dedupSql = buildActivityDedupCtasSql();
    assert.ok(/CREATE\s+TABLE\s+discovery_activity_v3_dedup/i.test(dedupSql), 'dedup CTAS must target _dedup table');
    assert.ok(/GROUP\s+BY\s+tx_hash,\s*log_index/i.test(dedupSql), 'dedup CTAS must GROUP BY (tx_hash, log_index)');
    assert.ok(/arg_min\(/i.test(dedupSql), 'dedup CTAS must use arg_min to pick winner row');

    // Emulate the full production flow: drop the indexes (simulating
    // runV3DuckDBMigrationsBackfillNoIndex), raw-insert, then dedup+reindex.
    await db.exec('DROP INDEX IF EXISTS idx_activity_v3_dedup');
    await db.exec('DROP INDEX IF EXISTS idx_activity_v3_wallet_ts');
    await db.exec('DROP INDEX IF EXISTS idx_activity_v3_market_ts');
    await runNoIndexLoadAndDedup(db, [sortedParquet]);

    const rows = await db.query<{
      proxy_wallet: string; role: string; side: string; ts_unix: number; abs_size: number;
    }>(`SELECT proxy_wallet, role, side, CAST(ts_unix AS BIGINT) AS ts_unix, abs_size
          FROM discovery_activity_v3 ORDER BY proxy_wallet`);
    const wallets = rows.map((r) => r.proxy_wallet);
    assert.deepEqual(wallets, ['0xA', '0xB', '0xC', '0xG'], 'same 4 wallets as other paths');

    const a = rows.find((r) => r.proxy_wallet === '0xA')!;
    assert.equal(a.role, 'maker');
    assert.equal(a.side, 'BUY');
    assert.equal(Number(a.abs_size), 100);
    assert.equal(Number(a.ts_unix), 1000, 'dedup keeps first row (earliest timestamp after sort tie-break)');
    const b = rows.find((r) => r.proxy_wallet === '0xB')!;
    assert.equal(b.side, 'SELL');
    const c = rows.find((r) => r.proxy_wallet === '0xC')!;
    assert.equal(c.role, 'maker', 'role lowercased');
  } finally {
    await db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('02_load_events bucketed sort: per-bucket dedup matches single-sort dedup', async () => {
  // Correctness guarantee of the bucketed path: abs(hash(tx_hash)) % N is
  // deterministic, so every duplicate (tx_hash, log_index) lands in the same
  // bucket. Per-bucket dedup must therefore produce the same output as the
  // single-sort dedup. This is what lets Phase B fit on the production volume.
  const tmp = mkdtempSync(join(tmpdir(), 'v3-bucketed-'));
  const parquet = join(tmp, 'users.parquet');
  const dbSingle = openDuckDB(':memory:');
  const dbBucketed = openDuckDB(':memory:');
  try {
    // Build a fixture with duplicates spread across many transaction_hash
    // values so buckets get non-trivial content.
    const values: string[] = [];
    for (let i = 0; i < 40; i++) {
      const tx = `tx${i.toString().padStart(3, '0')}`;
      values.push(`('0xW${i % 7}','m${i % 5}','c${i % 5}','e${i}',${1000 + i},${i},'${tx}',0,'maker',0.5,${10 + i}.0, 100.0)`);
      // Add a duplicate of half the rows at a later timestamp — dedup must
      // keep the earlier one.
      if (i % 2 === 0) {
        values.push(`('0xW${i % 7}','m${i % 5}','c${i % 5}','e${i}',${2000 + i},${i},'${tx}',0,'maker',0.5,${10 + i}.0, 100.0)`);
      }
    }

    for (const db of [dbSingle, dbBucketed]) {
      await db.exec(`CREATE TABLE users_source (
        user VARCHAR, market_id VARCHAR, condition_id VARCHAR, event_id VARCHAR,
        timestamp BIGINT, block_number BIGINT, transaction_hash VARCHAR, log_index INTEGER,
        role VARCHAR, price DOUBLE, usd_amount DOUBLE, token_amount DOUBLE
      )`);
      await db.exec(`INSERT INTO users_source VALUES ${values.join(', ')}`);
    }
    await dbSingle.exec(`COPY users_source TO '${parquet}' (FORMAT PARQUET)`);
    await dbSingle.exec(`DROP TABLE users_source`);
    await dbBucketed.exec(`DROP TABLE users_source`);
    await runV3DuckDBMigrations((sql) => dbSingle.exec(sql));
    await runV3DuckDBMigrations((sql) => dbBucketed.exec(sql));

    // --- Single-sort baseline ---
    const singleSorted = join(tmp, 'single.parquet');
    await dbSingle.exec(buildStagingDropSql());
    await dbSingle.exec(buildStagingCreateSql());
    await dbSingle.exec(buildStagingIngestSql(`read_parquet('${parquet}')`));
    await dbSingle.exec(buildStagingSortToParquetSql(singleSorted));
    await dbSingle.exec(buildStagingDropSql());
    await dbSingle.exec('DROP INDEX IF EXISTS idx_activity_v3_dedup');
    await dbSingle.exec('DROP INDEX IF EXISTS idx_activity_v3_wallet_ts');
    await dbSingle.exec('DROP INDEX IF EXISTS idx_activity_v3_market_ts');
    await runNoIndexLoadAndDedup(dbSingle, [singleSorted]);

    // --- Bucketed path ---
    const totalBuckets = 4;
    await dbBucketed.exec(buildStagingDropSql());
    await dbBucketed.exec(buildStagingCreateSql());
    await dbBucketed.exec(buildStagingIngestSql(`read_parquet('${parquet}')`));
    await dbBucketed.exec('DROP INDEX IF EXISTS idx_activity_v3_dedup');
    await dbBucketed.exec('DROP INDEX IF EXISTS idx_activity_v3_wallet_ts');
    await dbBucketed.exec('DROP INDEX IF EXISTS idx_activity_v3_market_ts');
    const bucketPaths: string[] = [];
    for (let b = 0; b < totalBuckets; b++) {
      const bp = join(tmp, `bucket_${b}.parquet`);
      await dbBucketed.exec(buildStagingSortBucketToParquetSql(b, totalBuckets, bp));
      bucketPaths.push(bp);
    }
    await runNoIndexLoadAndDedup(dbBucketed, bucketPaths);
    await dbBucketed.exec(buildStagingDropSql());

    // --- Compare ---
    const asRows = async (db: ReturnType<typeof openDuckDB>) =>
      db.query<{ k: string }>(
        `SELECT tx_hash || '|' || log_index || '|' || CAST(ts_unix AS VARCHAR) || '|' || proxy_wallet AS k
           FROM discovery_activity_v3
          ORDER BY tx_hash, log_index, ts_unix, proxy_wallet`
      );
    const singleRows = (await asRows(dbSingle)).map((r) => r.k);
    const bucketedRows = (await asRows(dbBucketed)).map((r) => r.k);
    assert.deepEqual(bucketedRows, singleRows, 'bucketed path must produce identical rows to single-sort path');
    assert.ok(singleRows.length === 40, `expected 40 unique (tx_hash, log_index), got ${singleRows.length}`);

    // Argument validation.
    assert.throws(() => buildStagingSortBucketToParquetSql(0, 0, '/tmp/x.parquet'), /totalBuckets/);
    assert.throws(() => buildStagingSortBucketToParquetSql(-1, 4, '/tmp/x.parquet'), /bucketIdx/);
    assert.throws(() => buildStagingSortBucketToParquetSql(4, 4, '/tmp/x.parquet'), /bucketIdx/);
  } finally {
    await dbSingle.close();
    await dbBucketed.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('02_load_events parquet-direct: no staging table, result matches staging path', async () => {
  // parquet-direct mode reads users.parquet 1/N of the way each iteration
  // (bucket filter pushed into the parquet scan). Must produce identical
  // output to the staging-based bucketed path.
  const tmp = mkdtempSync(join(tmpdir(), 'v3-pqdirect-'));
  const parquet = join(tmp, 'users.parquet');
  const dbStaging = openDuckDB(':memory:');
  const dbDirect = openDuckDB(':memory:');
  try {
    const values: string[] = [];
    for (let i = 0; i < 40; i++) {
      const tx = `tx${i.toString().padStart(3, '0')}`;
      values.push(`('0xW${i % 7}','m${i % 5}','c${i % 5}','e${i}',${1000 + i},${i},'${tx}',0,'maker',0.5,${10 + i}.0, 100.0)`);
      if (i % 2 === 0) {
        values.push(`('0xW${i % 7}','m${i % 5}','c${i % 5}','e${i}',${2000 + i},${i},'${tx}',0,'maker',0.5,${10 + i}.0, 100.0)`);
      }
    }
    for (const db of [dbStaging, dbDirect]) {
      await db.exec(`CREATE TABLE users_source (
        user VARCHAR, market_id VARCHAR, condition_id VARCHAR, event_id VARCHAR,
        timestamp BIGINT, block_number BIGINT, transaction_hash VARCHAR, log_index INTEGER,
        role VARCHAR, price DOUBLE, usd_amount DOUBLE, token_amount DOUBLE
      )`);
      await db.exec(`INSERT INTO users_source VALUES ${values.join(', ')}`);
    }
    await dbStaging.exec(`COPY users_source TO '${parquet}' (FORMAT PARQUET)`);
    await dbStaging.exec(`DROP TABLE users_source`);
    await dbDirect.exec(`DROP TABLE users_source`);
    await runV3DuckDBMigrations((sql) => dbStaging.exec(sql));
    await runV3DuckDBMigrations((sql) => dbDirect.exec(sql));

    const totalBuckets = 4;

    // Staging path baseline.
    await dbStaging.exec(buildStagingDropSql());
    await dbStaging.exec(buildStagingCreateSql());
    await dbStaging.exec(buildStagingIngestSql(`read_parquet('${parquet}')`));
    await dbStaging.exec('DROP INDEX IF EXISTS idx_activity_v3_dedup');
    await dbStaging.exec('DROP INDEX IF EXISTS idx_activity_v3_wallet_ts');
    await dbStaging.exec('DROP INDEX IF EXISTS idx_activity_v3_market_ts');
    const stagingBuckets: string[] = [];
    for (let b = 0; b < totalBuckets; b++) {
      const bp = join(tmp, `s_${b}.parquet`);
      await dbStaging.exec(buildStagingSortBucketToParquetSql(b, totalBuckets, bp));
      stagingBuckets.push(bp);
    }
    await runNoIndexLoadAndDedup(dbStaging, stagingBuckets);
    await dbStaging.exec(buildStagingDropSql());

    // Parquet-direct path.
    await dbDirect.exec('DROP INDEX IF EXISTS idx_activity_v3_dedup');
    await dbDirect.exec('DROP INDEX IF EXISTS idx_activity_v3_wallet_ts');
    await dbDirect.exec('DROP INDEX IF EXISTS idx_activity_v3_market_ts');
    const directBuckets: string[] = [];
    for (let b = 0; b < totalBuckets; b++) {
      const bp = join(tmp, `d_${b}.parquet`);
      await dbDirect.exec(
        buildSortBucketFromParquetToParquetSql(b, totalBuckets, `read_parquet('${parquet}')`, bp)
      );
      directBuckets.push(bp);
    }
    await runNoIndexLoadAndDedup(dbDirect, directBuckets);

    const asRows = async (db: ReturnType<typeof openDuckDB>) =>
      db.query<{ k: string }>(
        `SELECT tx_hash || '|' || log_index || '|' || CAST(ts_unix AS VARCHAR) || '|' || proxy_wallet AS k
           FROM discovery_activity_v3
          ORDER BY tx_hash, log_index, ts_unix, proxy_wallet`
      );
    const stagingRows = (await asRows(dbStaging)).map((r) => r.k);
    const directRows = (await asRows(dbDirect)).map((r) => r.k);
    assert.deepEqual(directRows, stagingRows, 'parquet-direct must match staging-based dedup');
    assert.ok(stagingRows.length === 40, `expected 40 unique keys, got ${stagingRows.length}`);

    assert.throws(() => buildSortBucketFromParquetToParquetSql(0, 0, 'x', '/tmp/x.parquet'), /totalBuckets/);
    assert.throws(() => buildSortBucketFromParquetToParquetSql(-1, 4, 'x', '/tmp/x.parquet'), /bucketIdx/);
    assert.throws(() => buildSortBucketFromParquetToParquetSql(4, 4, 'x', '/tmp/x.parquet'), /bucketIdx/);
  } finally {
    await dbStaging.close();
    await dbDirect.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('03_load_markets: Python-list outcome_prices parsed to JSON, neg_risk column preserved', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'v3-markets-'));
  const parquet = join(tmp, 'markets.parquet');
  const db = openDuckDB(':memory:');
  try {
    await db.exec(`CREATE TABLE markets_source (
      market_id VARCHAR, condition_id VARCHAR, event_id VARCHAR, question VARCHAR,
      slug VARCHAR, token1 VARCHAR, token2 VARCHAR, answer1 VARCHAR, answer2 VARCHAR,
      closed INTEGER, neg_risk INTEGER, outcome_prices VARCHAR, volume_total DOUBLE,
      created_at VARCHAR, end_date VARCHAR, updated_at VARCHAR
    )`);
    await db.exec(`INSERT INTO markets_source VALUES
      ('m1','c1','e1','Q1','s1','t1','t2','Yes','No',1, 0, '[''0.53'', ''0.47'']', 1000.0,
        '2024-01-01 00:00:00', '2024-02-01 00:00:00', '2024-02-01 00:00:00'),
      ('m2','c2','e2','Q2','s2','t3','t4','Yes','No',0, 1, '[''None'', ''0.5'']', 500.0,
        '2024-03-01 00:00:00', NULL, '2024-03-01 00:00:00')
    `);
    await db.exec(`COPY markets_source TO '${parquet}' (FORMAT PARQUET)`);
    await db.exec(`DROP TABLE markets_source`);
    await runV3DuckDBMigrations((sql) => db.exec(sql));
    await db.exec(buildMarketsIngestSql({ sourceRef: `read_parquet('${parquet}')` }));

    const rows = await db.query<{
      market_id: string; neg_risk: number; outcome_prices: string; closed: number;
    }>('SELECT market_id, CAST(neg_risk AS INTEGER) AS neg_risk, outcome_prices, CAST(closed AS INTEGER) AS closed FROM markets_v3 ORDER BY market_id');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].neg_risk, 0);
    assert.equal(rows[1].neg_risk, 1);
    assert.equal(rows[0].outcome_prices, '["0.53", "0.47"]');
    assert.equal(rows[1].outcome_prices, '[null, "0.5"]');
  } finally {
    await db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
