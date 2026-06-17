import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('discovery purge gating', () => {
  it('requires platform admin middleware for full purge', () => {
    const source = readFileSync(join(process.cwd(), 'src/api/discoveryRoutes.ts'), 'utf8');
    assert.match(source, /router\.post\('\/purge'/);
    assert.match(source, /requirePlatformAdmin/);
    assert.match(source, /req\.body\?\.full === true/);
  });
});
