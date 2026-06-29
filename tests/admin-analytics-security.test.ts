import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAdminAnalyticsPayload } from '../src/adminAnalytics/sanitizeAdminAnalyticsPayload.js';
import { toAdminTradingWalletDto } from '../src/adminAnalytics/toAdminTradingWalletDto.js';
import { resolveTimeRange } from '../src/adminAnalytics/timeRange.js';
import { inferBalanceActivity } from '../src/adminAnalytics/balanceHistoryLoader.js';
import { computeNotionalUsd } from '../src/adminAnalytics/tradeAnalytics.js';

describe('sanitizeAdminAnalyticsPayload', () => {
  it('removes forbidden keys at any depth', () => {
    const input = {
      tenantId: 'tenant_abc',
      wallet: {
        address: '0x123',
        privateKey: '0x' + 'a'.repeat(64),
        apiSecret: 'secret-value',
        polymarketBuilderCode: 'builder-xyz',
      },
      nested: [{ credentials: { apiKey: 'k', apiPassphrase: 'p' } }],
    };

    const output = sanitizeAdminAnalyticsPayload(input);
    const json = JSON.stringify(output);

    assert.equal(json.includes('privateKey'), false);
    assert.equal(json.includes('apiSecret'), false);
    assert.equal(json.includes('polymarketBuilderCode'), false);
    assert.equal(json.includes('apiPassphrase'), false);
    assert.equal(json.includes('credentials'), false);
    assert.equal((output as any).tenantId, 'tenant_abc');
    assert.equal((output as any).wallet.address, '0x123');
  });

  it('redacts standalone private key hex strings', () => {
    const key = `0x${'b'.repeat(64)}`;
    const output = sanitizeAdminAnalyticsPayload({ note: key });
    assert.equal((output as any).note, '[REDACTED]');
  });
});

describe('toAdminTradingWalletDto', () => {
  it('omits builder code and only exposes hasCredentials boolean', () => {
    const dto = toAdminTradingWalletDto({
      id: 'main',
      label: 'Main',
      address: '0xabc',
      proxyAddress: '0xproxy',
      polymarketBuilderCode: 'SECRET_BUILDER',
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      hasCredentials: true,
    });

    assert.equal(dto.hasCredentials, true);
    assert.equal((dto as any).polymarketBuilderCode, undefined);
    assert.equal(dto.proxyAddress, '0xproxy');
  });
});

describe('resolveTimeRange', () => {
  it('supports custom from/to', () => {
    const range = resolveTimeRange({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-02T00:00:00.000Z',
    });
    assert.equal(range.preset, 'custom');
    assert.equal(range.fromMs, Date.parse('2026-06-01T00:00:00.000Z'));
  });
});

describe('inferBalanceActivity', () => {
  it('detects inferred deposits above threshold', () => {
    const activity = inferBalanceActivity([
      { timestamp: new Date('2026-06-01T00:00:00.000Z'), balance: 100 },
      { timestamp: new Date('2026-06-01T01:00:00.000Z'), balance: 150 },
    ], 5);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].type, 'inferred_deposit');
    assert.equal(activity[0].deltaUsd, 50);
  });
});

describe('computeNotionalUsd', () => {
  it('multiplies amount and price', () => {
    assert.equal(computeNotionalUsd('10', '0.5'), 5);
  });
});
