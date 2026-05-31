import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveStopLossPositionValue } from '../src/stopLossPolicy.ts';
import { resolveHostedTenantId } from '../src/tenantPolicy.ts';
import { config } from '../src/config.ts';

test('resolveStopLossPositionValue uses curPrice for valuation', () => {
  const value = resolveStopLossPositionValue({
    size: '10',
    curPrice: '0.42',
    asset: 'token-1',
  });

  assert.equal(value, 4.2);
});

test('resolveStopLossPositionValue fails safe when curPrice is missing', () => {
  assert.throws(
    () => resolveStopLossPositionValue({ size: '10', asset: 'token-2' }),
    /curPrice is missing\/invalid/i
  );
});

test('resolveHostedTenantId enforces tenant in hosted mode', () => {
  const previousAuthMode = config.authMode;
  const previousStorageBackend = config.storageBackend;

  try {
    config.authMode = 'oidc';
    config.storageBackend = 'sqlite';

    assert.throws(
      () => resolveHostedTenantId(undefined, 'Detected trade'),
      /missing tenantId in hosted multi-tenant mode/i
    );
  } finally {
    config.authMode = previousAuthMode;
    config.storageBackend = previousStorageBackend;
  }
});

test('resolveHostedTenantId uses fallback tenant outside hosted mode', () => {
  const previousAuthMode = config.authMode;
  const previousStorageBackend = config.storageBackend;

  try {
    config.authMode = 'legacy';
    config.storageBackend = 'json';

    assert.equal(resolveHostedTenantId(undefined, 'Tracked wallet'), 'default');
    assert.equal(resolveHostedTenantId('tenant_123', 'Tracked wallet'), 'tenant_123');
  } finally {
    config.authMode = previousAuthMode;
    config.storageBackend = previousStorageBackend;
  }
});
