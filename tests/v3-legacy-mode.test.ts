import test from 'node:test';
import assert from 'node:assert/strict';
import { isLegacyDiscoveryWriteAllowed, legacyWriteGuardReason } from '../src/discovery/v3/legacyMode.ts';

test('legacyMode: legacy writes allowed when v3 flag off', () => {
  const prev = process.env.DISCOVERY_V3;
  const prevL = process.env.DISCOVERY_V3_LEGACY_WRITES;
  process.env.DISCOVERY_V3 = 'false';
  delete process.env.DISCOVERY_V3_LEGACY_WRITES;
  try {
    assert.equal(isLegacyDiscoveryWriteAllowed(), true);
    assert.equal(legacyWriteGuardReason(), null);
  } finally {
    if (prev === undefined) delete process.env.DISCOVERY_V3; else process.env.DISCOVERY_V3 = prev;
    if (prevL !== undefined) process.env.DISCOVERY_V3_LEGACY_WRITES = prevL;
  }
});

test('legacyMode: v3 on + override flag → writes allowed', () => {
  const prev = process.env.DISCOVERY_V3;
  const prevL = process.env.DISCOVERY_V3_LEGACY_WRITES;
  process.env.DISCOVERY_V3 = 'true';
  process.env.DISCOVERY_V3_LEGACY_WRITES = 'true';
  try {
    assert.equal(isLegacyDiscoveryWriteAllowed(), true);
  } finally {
    if (prev === undefined) delete process.env.DISCOVERY_V3; else process.env.DISCOVERY_V3 = prev;
    if (prevL === undefined) delete process.env.DISCOVERY_V3_LEGACY_WRITES; else process.env.DISCOVERY_V3_LEGACY_WRITES = prevL;
  }
});

test('legacyMode: v3 on + no override → writes blocked with reason', () => {
  const prev = process.env.DISCOVERY_V3;
  const prevL = process.env.DISCOVERY_V3_LEGACY_WRITES;
  process.env.DISCOVERY_V3 = 'true';
  delete process.env.DISCOVERY_V3_LEGACY_WRITES;
  try {
    assert.equal(isLegacyDiscoveryWriteAllowed(), false);
    assert.match(legacyWriteGuardReason() ?? '', /legacy writes disabled/);
  } finally {
    if (prev === undefined) delete process.env.DISCOVERY_V3; else process.env.DISCOVERY_V3 = prev;
    if (prevL !== undefined) process.env.DISCOVERY_V3_LEGACY_WRITES = prevL;
  }
});
