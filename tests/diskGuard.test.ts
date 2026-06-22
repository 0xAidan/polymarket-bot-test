import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDiskMetrics,
  isEnospcError,
  DiskSpaceError,
} from '../src/diskGuard.js';

describe('diskGuard', () => {
  it('returns disk metrics with valid shape', () => {
    const metrics = getDiskMetrics();
    assert.ok(metrics.totalBytes > 0);
    assert.ok(metrics.availableBytes >= 0);
    assert.ok(['ok', 'degraded', 'critical'].includes(metrics.status));
    assert.ok(metrics.usedPercent >= 0 && metrics.usedPercent <= 100);
  });

  it('detects ENOSPC errors', () => {
    assert.equal(isEnospcError({ code: 'ENOSPC' }), true);
    assert.equal(isEnospcError({ code: 'EDQUOT' }), true);
    assert.equal(isEnospcError(new Error('fail')), false);
    assert.equal(isEnospcError(null), false);
  });

  it('DiskSpaceError exposes DISK_FULL code', () => {
    const err = new DiskSpaceError('no space');
    assert.equal(err.code, 'DISK_FULL');
    assert.match(err.message, /no space/i);
  });
});
