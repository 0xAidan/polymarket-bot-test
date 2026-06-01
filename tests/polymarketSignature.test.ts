import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PolymarketSignatureType,
  describeSignatureType,
  shouldUseDistinctFunder,
  shouldUseProxyRelayerTxType,
} from '../src/polymarketSignature.js';

test('describeSignatureType returns official V2 labels', () => {
  assert.equal(describeSignatureType(PolymarketSignatureType.EOA), 'EOA (0)');
  assert.equal(describeSignatureType(PolymarketSignatureType.POLY_PROXY), 'POLY_PROXY (1)');
  assert.equal(describeSignatureType(PolymarketSignatureType.POLY_GNOSIS_SAFE), 'POLY_GNOSIS_SAFE (2)');
  assert.equal(describeSignatureType(PolymarketSignatureType.POLY_1271), 'POLY_1271 (3)');
  assert.equal(describeSignatureType(999), 'UNKNOWN (999)');
});

test('shouldUseDistinctFunder matches proxy/safe/deposit flows', () => {
  assert.equal(shouldUseDistinctFunder(PolymarketSignatureType.EOA), false);
  assert.equal(shouldUseDistinctFunder(PolymarketSignatureType.POLY_PROXY), true);
  assert.equal(shouldUseDistinctFunder(PolymarketSignatureType.POLY_GNOSIS_SAFE), true);
  assert.equal(shouldUseDistinctFunder(PolymarketSignatureType.POLY_1271), true);
});

test('shouldUseProxyRelayerTxType only enables PROXY flow for proxy signatures', () => {
  assert.equal(shouldUseProxyRelayerTxType(PolymarketSignatureType.EOA), false);
  assert.equal(shouldUseProxyRelayerTxType(PolymarketSignatureType.POLY_PROXY), true);
  assert.equal(shouldUseProxyRelayerTxType(PolymarketSignatureType.POLY_GNOSIS_SAFE), false);
  assert.equal(shouldUseProxyRelayerTxType(PolymarketSignatureType.POLY_1271), false);
});
