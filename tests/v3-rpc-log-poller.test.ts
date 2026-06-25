import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ethers } from 'ethers';

import { openDuckDB } from '../src/discovery/v3/duckdbClient.ts';
import { runV3DuckDBMigrations } from '../src/discovery/v3/duckdbSchema.ts';
import { runV3SqliteMigrations } from '../src/discovery/v3/schema.ts';
import { createSqliteCursorStore } from '../src/discovery/v3/goldskyListener.ts';
import {
  createHttpRpcClient,
  pollRpcLogsOnce,
  type RpcClient,
} from '../src/discovery/v3/rpcLogPoller.ts';
import {
  ORDER_FILLED_TOPIC0_V2,
  ORDER_FILLED_DATA_TYPES_V2,
} from '../src/discovery/types.ts';

const addrTopic = (addr: string): string =>
  '0x' + '00'.repeat(12) + addr.toLowerCase().replace(/^0x/, '');

test('pollRpcLogsOnce advances block cursor and inserts decoded rows', async () => {
  const sqlite = new Database(':memory:');
  runV3SqliteMigrations(sqlite);
  const duck = await openDuckDB(':memory:');
  await runV3DuckDBMigrations((sql) => duck.exec(sql));

  const maker = '0x1111111111111111111111111111111111111111';
  const taker = '0x2222222222222222222222222222222222222222';
  const data = ethers.AbiCoder.defaultAbiCoder().encode(ORDER_FILLED_DATA_TYPES_V2, [
    0,
    '999',
    50_000_000,
    100_000_000,
    0,
    '0x' + '00'.repeat(32),
    '0x' + '11'.repeat(32),
  ]);

  const client: RpcClient = {
    async getBlockNumber() { return 10_000; },
    async getLogs(fromBlock, toBlock) {
      assert.ok(fromBlock <= toBlock);
      return [{
        address: '0xE111180000d2663C0091e4f400237545B87B996B',
        topics: [
          ORDER_FILLED_TOPIC0_V2,
          '0x' + 'ab'.repeat(32),
          addrTopic(maker),
          addrTopic(taker),
        ],
        data,
        blockNumber: '0x270f',
        transactionHash: '0x' + 'ee'.repeat(32),
        logIndex: '0x1',
      }];
    },
    async getBlockTimestamp(blockNumber) {
      assert.equal(blockNumber, 0x270f);
      return 1_700_000_000;
    },
  };

  const cursor = createSqliteCursorStore(sqlite);
  const r = await pollRpcLogsOnce({
    duck,
    cursor,
    client,
    initialLookbackBlocks: 100,
    blockChunkSize: 5000,
  });
  assert.equal(r.toBlock, 10_000);
  assert.equal(r.newCursor, 10_000);
  assert.equal(r.logsFetched, 1);
  assert.equal(r.inserted, 2);
  assert.equal(r.rpcCallsEstimated, 3);

  const count = await duck.query<{ c: number }>(
    'SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'
  );
  assert.equal(Number(count[0]?.c ?? 0), 2);

  await duck.close();
  sqlite.close();
});

test('createHttpRpcClient forwards optional RPC auth headers', async () => {
  const requests: Array<{ method: string; headers: Record<string, string> }> = [];
  const fetchStub: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    requests.push({ method: body.method, headers: rawHeaders ?? {} });

    const payloadByMethod: Record<string, unknown> = {
      eth_blockNumber: '0x2a',
      eth_getLogs: [],
      eth_getBlockByNumber: { timestamp: '0x65' },
    };
    const result = payloadByMethod[body.method];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const client = createHttpRpcClient(
    'https://rpc.example',
    fetchStub,
    { 'x-api-key': 'secret-key' },
  );

  const block = await client.getBlockNumber();
  assert.equal(block, 42);
  const logs = await client.getLogs(1, 2);
  assert.deepEqual(logs, []);
  const ts = await client.getBlockTimestamp(2);
  assert.equal(ts, 101);

  assert.equal(requests.length, 3);
  for (const req of requests) {
    assert.equal(req.headers['Content-Type'], 'application/json');
    assert.equal(req.headers['x-api-key'], 'secret-key');
  }
});
