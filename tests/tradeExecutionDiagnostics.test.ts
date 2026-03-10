import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTradeExecutionFailure,
  summarizeClobConnectivityDiagnosis,
} from '../src/tradeExecutionDiagnostics.js';

test('classifyTradeExecutionFailure flags invalid signature errors as auth failures', () => {
  const result = classifyTradeExecutionFailure({
    errorMessage: 'CLOB API returned HTTP error 400 - invalid signature',
    authProbeSucceeded: false,
  });

  assert.equal(result.classification, 'signature-auth');
  assert.match(result.summary, /signature/i);
});

test('classifyTradeExecutionFailure treats order rejections as payload issues when auth probe succeeds', () => {
  const result = classifyTradeExecutionFailure({
    errorMessage: 'CLOB API returned HTTP 400 - request was rejected',
    authProbeSucceeded: true,
  });

  assert.equal(result.classification, 'order-payload');
  assert.match(result.summary, /payload/i);
});

test('classifyTradeExecutionFailure identifies closed-market failures separately', () => {
  const result = classifyTradeExecutionFailure({
    errorMessage: 'MARKET_CLOSED: The orderbook for this market no longer exists.',
    authProbeSucceeded: true,
  });

  assert.equal(result.classification, 'market-state');
  assert.match(result.summary, /market/i);
});

test('classifyTradeExecutionFailure preserves cloudflare/network failures', () => {
  const result = classifyTradeExecutionFailure({
    errorMessage: 'Request blocked by Cloudflare (status 403)',
    authProbeSucceeded: false,
  });

  assert.equal(result.classification, 'cloudflare-block');
});

test('summarizeClobConnectivityDiagnosis does not report healthy access when the auth probe fails', () => {
  const diagnosis = summarizeClobConnectivityDiagnosis({
    allTestsPassed: true,
    anyCloudflareBlocks: false,
    authProbe: {
      success: false,
      classification: 'unknown',
      summary: 'Probe failed unexpectedly.',
    },
  });

  assert.match(diagnosis, /probe failed unexpectedly/i);
});
