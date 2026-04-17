import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { isHostedMultiTenantMode } from '../src/hostedMode.js';

describe('hostedMode', () => {
  let savedAuthMode: string;
  let savedStorage: string;

  beforeEach(() => {
    savedAuthMode = config.authMode;
    savedStorage = config.storageBackend;
  });

  afterEach(() => {
    (config as any).authMode = savedAuthMode;
    (config as any).storageBackend = savedStorage;
  });

  it('isHostedMultiTenantMode is true only for OIDC + SQLite', () => {
    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'sqlite';
    assert.equal(isHostedMultiTenantMode(), true);

    (config as any).authMode = 'legacy';
    (config as any).storageBackend = 'sqlite';
    assert.equal(isHostedMultiTenantMode(), false);

    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'json';
    assert.equal(isHostedMultiTenantMode(), false);
  });
});
