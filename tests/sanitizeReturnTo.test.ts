import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeReturnTo } from '../src/sanitizeReturnTo.js';

describe('sanitizeReturnTo', () => {
  it('accepts safe relative paths', () => {
    assert.equal(sanitizeReturnTo('/app'), '/app');
    assert.equal(sanitizeReturnTo('/discovery-v3?tab=alpha'), '/discovery-v3?tab=alpha');
  });

  it('rejects protocol-relative and absolute URLs', () => {
    assert.equal(sanitizeReturnTo('//evil.com'), '/app');
    assert.equal(sanitizeReturnTo('https://evil.com'), '/app');
    assert.equal(sanitizeReturnTo('/app:evil'), '/app');
    assert.equal(sanitizeReturnTo('javascript:alert(1)'), '/app');
  });

  it('uses custom fallback', () => {
    assert.equal(sanitizeReturnTo('//evil.com', '/login'), '/login');
    assert.equal(sanitizeReturnTo(null, '/admin'), '/admin');
  });
});
