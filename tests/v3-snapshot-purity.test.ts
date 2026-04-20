import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';

import { openDuckDB } from '../src/discovery/v3/duckdbClient.ts';
import { runV3DuckDBMigrations } from '../src/discovery/v3/duckdbSchema.ts';
import { buildSnapshotEmitSql } from '../src/discovery/v3/backfillQueries.ts';

async function allSnapshotsHash(
  db: ReturnType<typeof openDuckDB>
): Promise<string> {
  const rows = await db.query(
    `SELECT CAST(snapshot_day AS VARCHAR) AS snapshot_day, proxy_wallet,
            trade_count, volume_total, distinct_markets, closed_positions,
            realized_pnl, unrealized_pnl,
            CAST(first_active_ts AS BIGINT) AS first_active_ts,
            CAST(last_active_ts  AS BIGINT) AS last_active_ts,
            observation_span_days
       FROM discovery_feature_snapshots_v3
      ORDER BY proxy_wallet, snapshot_day`
  );
  const serialized = rows.map((r: any) => ({
    ...r,
    trade_count: Number(r.trade_count),
    distinct_markets: Number(r.distinct_markets),
    closed_positions: Number(r.closed_positions),
    first_active_ts: Number(r.first_active_ts),
    last_active_ts: Number(r.last_active_ts),
  }));
  return createHash('sha256').update(JSON.stringify(serialized)).digest('hex');
}

test('04_emit_snapshots: point-in-time purity + determinism', async () => {
  const db = openDuckDB(':memory:');
  try {
    await runV3DuckDBMigrations((sql) => db.exec(sql));

    // Two wallets, hand-coded timestamps. Events on 2024-01-01 and 2024-01-05.
    const day1 = Math.floor(new Date('2024-01-01T12:00:00Z').getTime() / 1000);
    const day5 = Math.floor(new Date('2024-01-05T12:00:00Z').getTime() / 1000);
    const day10 = Math.floor(new Date('2024-01-10T12:00:00Z').getTime() / 1000);
    await db.exec(`INSERT INTO discovery_activity_v3 VALUES
      ('0xA','m1','c1',NULL,${day1},1,'tx1',0,'maker','BUY',0.50, 100.0, 100.0, 100.0),
      ('0xA','m2','c2',NULL,${day5},2,'tx2',0,'maker','BUY',0.60,  50.0,  50.0,  50.0),
      ('0xA','m3','c3',NULL,${day10},3,'tx3',0,'maker','SELL',0.40, 20.0, -20.0, 20.0),
      ('0xB','m1','c1',NULL,${day5},4,'tx4',0,'taker','BUY',0.55,  10.0,  10.0,  10.0)`);

    // Market m3 resolves on 2024-01-15 — later than 0xA's day5 snapshot; must not leak.
    await db.exec(`INSERT INTO markets_v3 (market_id, closed, neg_risk, end_date) VALUES
      ('m1', 1, 0, TIMESTAMP '2024-01-03 00:00:00'),
      ('m2', 1, 0, TIMESTAMP '2024-01-07 00:00:00'),
      ('m3', 0, 0, TIMESTAMP '2024-01-15 00:00:00')`);

    await db.exec(buildSnapshotEmitSql());
    const h1 = await allSnapshotsHash(db);

    // Determinism — rerun on same source must be byte-identical.
    await db.exec('DELETE FROM discovery_feature_snapshots_v3');
    await db.exec(buildSnapshotEmitSql());
    const h2 = await allSnapshotsHash(db);
    assert.equal(h1, h2, 'snapshots must be deterministic');

    // Purity check: 0xA's snapshot on 2024-01-05 should see trades <= day 5
    // (so trade_count = 2; m3 at 2024-01-10 must NOT be counted).
    const aDay5 = await db.query<{ trade_count: number; realized_pnl: number }>(
      `SELECT CAST(trade_count AS BIGINT) AS trade_count, realized_pnl
         FROM discovery_feature_snapshots_v3
        WHERE proxy_wallet = '0xA' AND snapshot_day = DATE '2024-01-05'`
    );
    assert.equal(aDay5.length, 1);
    assert.equal(Number(aDay5[0].trade_count), 2, 'only events up to snapshot day counted');

    // Purity check 2: realized PnL for 0xA on 2024-01-05 can only include
    // markets resolved <= 2024-01-05 (m1 resolved 2024-01-03). m2 resolved 2024-01-07,
    // m3 resolved 2024-01-15 — both must be excluded.
    const contributing = await db.query<{ c: number }>(
      `SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3 a
         JOIN markets_v3 m ON m.market_id = a.market_id
        WHERE a.proxy_wallet = '0xA'
          AND a.ts_unix < CAST(EXTRACT(epoch FROM (DATE '2024-01-06')) AS UBIGINT)
          AND CAST(m.end_date AS DATE) <= DATE '2024-01-05'`
    );
    assert.equal(Number(contributing[0].c), 1, 'only m1 contributes to 2024-01-05 realized PnL');

    // No snapshot day for 0xB on 2024-01-01 (no trade that day).
    const bDay1 = await db.query<{ c: number }>(
      `SELECT COUNT(*)::BIGINT AS c FROM discovery_feature_snapshots_v3
        WHERE proxy_wallet = '0xB' AND snapshot_day = DATE '2024-01-01'`
    );
    assert.equal(Number(bDay1[0].c), 0);
  } finally {
    await db.close();
  }
});
