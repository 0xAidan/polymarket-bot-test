import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('discovery v3 static gate', () => {
  it('serves discovery-v3 only after auth with platform admin check', () => {
    const source = readFileSync(join(process.cwd(), 'src/server.ts'), 'utf8');
    assert.match(source, /mountProtectedDiscoveryV3Static/);
    assert.match(source, /resolveIsPlatformAdmin\(req\)/);
    assert.match(source, /express\.static\(path\.join\(publicPath, 'discovery-v3'\)\)/);
  });
});
