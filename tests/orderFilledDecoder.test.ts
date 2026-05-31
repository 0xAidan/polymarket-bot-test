import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import { parseOrderFilledLog } from '../src/discovery/chainListener.js';
import {
  ORDER_FILLED_TOPIC0_V1,
  ORDER_FILLED_TOPIC0_V2,
  ORDER_FILLED_DATA_TYPES_V1,
  ORDER_FILLED_DATA_TYPES_V2,
} from '../src/discovery/types.js';

// Pad an EVM address into a 32-byte topic value (left-zero-padded).
function addrTopic(addr: string): string {
  return '0x' + '00'.repeat(12) + addr.toLowerCase().replace(/^0x/, '');
}

const ORDER_HASH = '0x' + 'ab'.repeat(32);
const MAKER = '0x1111111111111111111111111111111111111111';
const TAKER = '0x2222222222222222222222222222222222222222';
const TOKEN_ID = '12345678901234567890';
const TX_HASH = '0x' + 'cd'.repeat(32);
const CONTRACT_V2 = '0xE111180000d2663C0091e4f400237545B87B996B';
const CONTRACT_V1 = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

test('topic0 constants are pinned to the correct keccak256 values', () => {
  assert.equal(
    ORDER_FILLED_TOPIC0_V1,
    ethers.utils.id('OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'),
  );
  assert.equal(
    ORDER_FILLED_TOPIC0_V2,
    ethers.utils.id('OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)'),
  );
});

test('parseOrderFilledLog decodes a V2 BUY OrderFilled log', () => {
  const builder = '0x' + '00'.repeat(32);
  const metadata = '0x' + '11'.repeat(32);
  const data = ethers.utils.defaultAbiCoder.encode(ORDER_FILLED_DATA_TYPES_V2, [
    0,            // side: 0 = BUY
    TOKEN_ID,
    100_000_000,  // makerAmountFilled (100 pUSD, 6 decimals)
    200_000_000,  // takerAmountFilled (200 conditional tokens, 6 decimals)
    0,            // fee
    builder,
    metadata,
  ]);

  const log = {
    topics: [ORDER_FILLED_TOPIC0_V2, ORDER_HASH, addrTopic(MAKER), addrTopic(TAKER)],
    data,
    blockNumber: '0x123abc',
    transactionHash: TX_HASH,
    address: CONTRACT_V2,
  };

  const event = parseOrderFilledLog(log);
  assert.ok(event, 'expected event to decode');
  assert.equal(event!.version, 'v2');
  assert.equal(event!.orderHash, ORDER_HASH);
  assert.equal(event!.maker.toLowerCase(), MAKER.toLowerCase());
  assert.equal(event!.taker.toLowerCase(), TAKER.toLowerCase());
  assert.equal(event!.side, 0);
  assert.equal(event!.tokenId, TOKEN_ID);
  assert.equal(event!.makerAmountFilled, '100000000');
  assert.equal(event!.takerAmountFilled, '200000000');
  assert.equal(event!.fee, '0');
  assert.equal(event!.builder, builder);
  assert.equal(event!.metadata, metadata);
  assert.equal(event!.blockNumber, parseInt('0x123abc', 16));
  assert.equal(event!.transactionHash, TX_HASH);
  assert.equal(event!.contractAddress, CONTRACT_V2);
});

test('parseOrderFilledLog decodes a V2 SELL OrderFilled log', () => {
  const data = ethers.utils.defaultAbiCoder.encode(ORDER_FILLED_DATA_TYPES_V2, [
    1,            // side: 1 = SELL
    TOKEN_ID,
    50_000_000,   // makerAmountFilled (50 conditional tokens)
    25_000_000,   // takerAmountFilled (25 pUSD)
    100_000,      // fee (0.1 pUSD)
    '0x' + '22'.repeat(32),
    '0x' + '33'.repeat(32),
  ]);

  const log = {
    topics: [ORDER_FILLED_TOPIC0_V2, ORDER_HASH, addrTopic(MAKER), addrTopic(TAKER)],
    data,
    blockNumber: '0x10',
    transactionHash: TX_HASH,
    address: CONTRACT_V2,
  };

  const event = parseOrderFilledLog(log);
  assert.ok(event);
  assert.equal(event!.version, 'v2');
  assert.equal(event!.side, 1);
  assert.equal(event!.tokenId, TOKEN_ID);
  assert.equal(event!.fee, '100000');
});

test('parseOrderFilledLog still decodes a V1 OrderFilled log unchanged', () => {
  // V1 BUY: maker is providing USDC, so makerAssetId = 0, takerAssetId = tokenId
  const data = ethers.utils.defaultAbiCoder.encode(ORDER_FILLED_DATA_TYPES_V1, [
    0,            // makerAssetId: 0 = collateral side (BUY)
    TOKEN_ID,     // takerAssetId
    100_000_000,
    200_000_000,
    0,
  ]);

  const log = {
    topics: [ORDER_FILLED_TOPIC0_V1, ORDER_HASH, addrTopic(MAKER), addrTopic(TAKER)],
    data,
    blockNumber: '0x1',
    transactionHash: TX_HASH,
    address: CONTRACT_V1,
  };

  const event = parseOrderFilledLog(log);
  assert.ok(event);
  assert.equal(event!.version, 'v1');
  assert.equal(event!.makerAssetId, '0');
  assert.equal(event!.takerAssetId, TOKEN_ID);
  assert.equal(event!.makerAmountFilled, '100000000');
  assert.equal(event!.takerAmountFilled, '200000000');
  // V2-only fields should be undefined on a V1-decoded event
  assert.equal(event!.side, undefined);
  assert.equal(event!.tokenId, undefined);
});

test('parseOrderFilledLog returns null for an unknown topic0', () => {
  const log = {
    topics: ['0x' + 'ff'.repeat(32), ORDER_HASH, addrTopic(MAKER), addrTopic(TAKER)],
    data: '0x',
    blockNumber: '0x1',
    transactionHash: TX_HASH,
    address: CONTRACT_V2,
  };
  assert.equal(parseOrderFilledLog(log), null);
});

test('parseOrderFilledLog returns null when topics are missing', () => {
  assert.equal(parseOrderFilledLog({ topics: [], data: '0x' }), null);
  assert.equal(parseOrderFilledLog({}), null);
});
