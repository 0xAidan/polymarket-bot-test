import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { openDuckDB } from '../src/discovery/v3/duckdbClient.ts';
import { runV3DuckDBMigrations } from '../src/discovery/v3/duckdbSchema.ts';
import { runV3SqliteMigrations } from '../src/discovery/v3/schema.ts';
import {
  normalizeOrderFilled,
  pollGoldskyOnce,
  createSqliteCursorStore,
  GoldskyClient,
  GoldskyOrderFilled,
} from '../src/discovery/v3/goldskyListener.ts';

test('normalizeOrderFilled produces two rows (maker + taker) with unique log_index', () => {
  const ev: GoldskyOrderFilled = {
    id: 'e1',
    transactionHash: '0xabc',
    logIndex: '7',
    blockNumber: '1000',
    timestamp: '1700000000',
    maker: '0xMAKER',
    taker: '0xTAKER',
    makerAssetId: '0',                // collateral
    takerAssetId: '999',              // outcome token
    makerAmountFilled: '50',          // USDC notional
    takerAmountFilled: '100',         // size
    conditionId: 'c1',
    marketId: 'm1',
    eventId: 'ev1',
  };
  const rows = normalizeOrderFilled(ev);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].log_index, rows[1].log_index, 'maker/taker rows must have distinct log_index');

  const maker = rows[0];
  assert.equal(maker.proxy_wallet, '0xMAKER');
  assert.equal(maker.role, 'maker');
  assert.equal(maker.side, 'BUY', 'maker delivering collateral = BUY');
  assert.equal(maker.usd_notional, 50);
  assert.equal(maker.abs_size, 100);
  assert.equal(maker.price_yes, 0.5);

  const taker = rows[1];
  assert.equal(taker.role, 'taker');
  assert.equal(taker.side, 'SELL');
});

test('pollGoldskyOnce advances cursor + inserts rows + deduplicates via mock client', async () => {
  const sqlite = new Database(':memory:');
  runV3SqliteMigrations(sqlite);
  const duck = openDuckDB(':memory:');
  await runV3DuckDBMigrations((sql) => duck.exec(sql));

  const responses: GoldskyOrderFilled[][] = [
    [
      {
        id: 'e1',
        transactionHash: '0xa',
        logIndex: '1',
        blockNumber: '100',
        timestamp: '1700000000',
        maker: '0xM1',
        taker: '0xT1',
        makerAssetId: '0',
        takerAssetId: '1',
        makerAmountFilled: '25',
        takerAmountFilled: '50',
        conditionId: 'c1',
        marketId: 'm1',
        eventId: 'ev1',
      },
    ],
    [], // second call: nothing new
  ];

  let calls = 0;
  const client: GoldskyClient = {
    async fetchOrderFilledSince(lastBlock: number): Promise<GoldskyOrderFilled[]> {
      calls++;
      return responses.shift() ?? [];
    },
  };

  const cursor = createSqliteCursorStore(sqlite);
  const r1 = await pollGoldskyOnce({ duck, cursor, client });
  assert.equal(r1.fetched, 1);
  assert.equal(r1.inserted, 2, 'maker + taker rows');
  assert.equal(r1.newCursor, 100);

  // Second poll: nothing new.
  const r2 = await pollGoldskyOnce({ duck, cursor, client });
  assert.equal(r2.fetched, 0);
  assert.equal(r2.newCursor, 100);

  const rows = await duck.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3');
  assert.equal(Number(rows[0].c), 2);

  // Simulate replaying the same event (overlap at backfill boundary):
  // UNIQUE(tx_hash, log_index) must absorb duplicates without throwing.
  await pollGoldskyOnce({
    duck,
    cursor: {
      getLastBlock: () => 0,
      setLastBlock: () => undefined,
    },
    client: {
      async fetchOrderFilledSince() {
        return [
          {
            id: 'e1',
            transactionHash: '0xa',
            logIndex: '1',
            blockNumber: '100',
            timestamp: '1700000000',
            maker: '0xM1',
            taker: '0xT1',
            makerAssetId: '0',
            takerAssetId: '1',
            makerAmountFilled: '25',
            takerAmountFilled: '50',
            conditionId: 'c1',
            marketId: 'm1',
            eventId: 'ev1',
          },
        ];
      },
    },
  });
  const rows2 = await duck.query<{ c: number }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3');
  assert.equal(Number(rows2[0].c), 2, 'dedup absorbs duplicate events');

  await duck.close();
  sqlite.close();
  assert.ok(calls >= 2);
});
