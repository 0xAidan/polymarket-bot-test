import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import { orderFilledLogToV3Rows } from '../src/discovery/v3/orderFilledToV3.ts';
import {
  ORDER_FILLED_TOPIC0_V2,
  ORDER_FILLED_DATA_TYPES_V2,
} from '../src/discovery/types.ts';

const addrTopic = (addr: string): string =>
  '0x' + '00'.repeat(12) + addr.toLowerCase().replace(/^0x/, '');

test('orderFilledLogToV3Rows emits maker + taker rows with real log_index', () => {
  const maker = '0x1111111111111111111111111111111111111111';
  const taker = '0x2222222222222222222222222222222222222222';
  const data = ethers.utils.defaultAbiCoder.encode(ORDER_FILLED_DATA_TYPES_V2, [
    0,
    '999',
    50_000_000,
    100_000_000,
    0,
    '0x' + '00'.repeat(32),
    '0x' + '11'.repeat(32),
  ]);
  const log = {
    address: '0xE111180000d2663C0091e4f400237545B87B996B',
    topics: [
      ORDER_FILLED_TOPIC0_V2,
      '0x' + 'ab'.repeat(32),
      addrTopic(maker),
      addrTopic(taker),
    ],
    data,
    blockNumber: '0x64',
    transactionHash: '0x' + 'cd'.repeat(32),
    logIndex: '0x2a',
  };
  const rows = orderFilledLogToV3Rows(log, 1_700_000_000);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].log_index, 0x2a);
  assert.equal(rows[1].log_index, 0x2a + 1_000_000_000);
  assert.equal(rows[0].proxy_wallet, maker);
  assert.equal(rows[1].proxy_wallet, taker);
  assert.equal(rows[0].role, 'maker');
  assert.equal(rows[1].role, 'taker');
});
