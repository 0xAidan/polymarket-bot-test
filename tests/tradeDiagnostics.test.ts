import test from 'node:test';
import assert from 'node:assert/strict';
import { Side } from '@polymarket/clob-client';

import {
  buildTradeExecutionDiagnosticContext,
  summarizeActivityTradeForDebug,
  summarizeDetectedTradeForDebug,
  summarizeDomeTradeForDebug,
} from '../src/tradeDiagnostics.js';

test('summarizeActivityTradeForDebug keeps the critical raw activity fields', () => {
  const summary = summarizeActivityTradeForDebug({
    id: 'activity-1',
    asset: 'token-123',
    conditionId: '0xcondition',
    outcome: 'Kamala',
    outcomeIndex: 2,
    side: 'BUY',
    size: 150,
    price: 0.41,
    timestamp: 1710000000,
    title: 'Who wins?',
    transactionHash: '0xtxhash',
  });

  assert.deepEqual(summary, {
    source: 'activity',
    id: 'activity-1',
    conditionId: '0xcondition',
    asset: 'token-123',
    outcome: 'Kamala',
    outcomeIndex: 2,
    side: 'BUY',
    size: 150,
    price: 0.41,
    timestamp: 1710000000,
    title: 'Who wins?',
    transactionHash: '0xtxhash',
  });
});

test('summarizeDomeTradeForDebug keeps the critical websocket fields', () => {
  const summary = summarizeDomeTradeForDebug({
    user: '0xwallet',
    condition_id: '0xcondition',
    token_id: 'token-456',
    token_label: 'TRUMP',
    market_slug: 'who-wins',
    title: 'Who wins?',
    shares: 1000000,
    shares_normalized: 1,
    price: 0.62,
    side: 'SELL',
    timestamp: 1710000000,
    tx_hash: '0xtx',
    order_hash: '0xorder',
  });

  assert.deepEqual(summary, {
    source: 'dome',
    user: '0xwallet',
    conditionId: '0xcondition',
    tokenId: 'token-456',
    tokenLabel: 'TRUMP',
    marketSlug: 'who-wins',
    title: 'Who wins?',
    shares: 1000000,
    sharesNormalized: 1,
    price: 0.62,
    side: 'SELL',
    timestamp: 1710000000,
    txHash: '0xtx',
    orderHash: '0xorder',
  });
});

test('summarizeDetectedTradeForDebug keeps normalized trade identity and execution fields', () => {
  const summary = summarizeDetectedTradeForDebug({
    walletAddress: '0xwallet',
    marketId: '0xcondition',
    marketTitle: 'Who wins?',
    outcome: 'YES',
    amount: '10',
    price: '0.45',
    side: 'BUY',
    timestamp: new Date('2026-03-08T20:00:00.000Z'),
    transactionHash: '0xtx',
    tokenId: 'token-789',
    negRisk: true,
  });

  assert.deepEqual(summary, {
    source: 'detected-trade',
    walletAddress: '0xwallet',
    marketId: '0xcondition',
    marketTitle: 'Who wins?',
    outcome: 'YES',
    amount: '10',
    price: '0.45',
    side: 'BUY',
    timestamp: '2026-03-08T20:00:00.000Z',
    transactionHash: '0xtx',
    tokenId: 'token-789',
    negRisk: true,
  });
});

test('buildTradeExecutionDiagnosticContext summarizes order and runtime auth context', () => {
  const summary = buildTradeExecutionDiagnosticContext({
    stage: 'invalid-signature-retry-failed',
    order: {
      marketId: '0xcondition',
      outcome: 'YES',
      amount: '4.25',
      price: '0.52',
      side: 'BUY',
      tokenId: 'token-123',
      negRisk: false,
      slippagePercent: 1.5,
    },
    clobOrderParams: {
      tokenID: 'token-123',
      price: 0.5278,
      size: 4.25,
      side: Side.BUY,
      tickSize: '0.01',
      negRisk: false,
    },
    execution: {
      signatureType: 2,
      funderAddress: '0xproxy',
      clobHost: 'https://clob.polymarket.com',
      builderAuthConfigured: true,
      retryAttempted: true,
    },
    errorMessage: 'invalid signature',
  });

  assert.deepEqual(summary, {
    source: 'trade-execution',
    stage: 'invalid-signature-retry-failed',
    order: {
      marketId: '0xcondition',
      outcome: 'YES',
      amount: '4.25',
      price: '0.52',
      side: 'BUY',
      tokenId: 'token-123',
      negRisk: false,
      slippagePercent: 1.5,
    },
    clobOrderParams: {
      tokenID: 'token-123',
      price: 0.5278,
      size: 4.25,
      side: 'BUY',
      tickSize: '0.01',
      negRisk: false,
    },
    execution: {
      signatureType: 2,
      funderAddress: '0xproxy',
      clobHost: 'https://clob.polymarket.com',
      builderAuthConfigured: true,
      retryAttempted: true,
    },
    errorMessage: 'invalid signature',
  });
});
