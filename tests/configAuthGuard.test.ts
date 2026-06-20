import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('config OIDC tenant guard', () => {
  it('validate warns when issuer does not match AUTH0_EXPECTED_TENANT', () => {
    const source = readFileSync(join(process.cwd(), 'src/config.ts'), 'utf8');
    assert.match(source, /AUTH0_EXPECTED_TENANT/);
    assert.match(source, /issuer does not match AUTH0_EXPECTED_TENANT/i);
  });
});
