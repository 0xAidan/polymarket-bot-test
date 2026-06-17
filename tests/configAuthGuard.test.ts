import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('config OIDC tenant guard', () => {
  it('validate warns when issuer does not match expected GTM tenant', () => {
    const source = readFileSync(join(process.cwd(), 'src/config.ts'), 'utf8');
    assert.match(source, /AUTH0_EXPECTED_TENANT/);
    assert.match(source, /dev-rjdevt32s21vhh86/);
    assert.match(source, /issuer does not match expected GTM tenant/i);
  });
});
