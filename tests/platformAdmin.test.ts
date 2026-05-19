import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { config } from '../src/config.js';
import {
  isPlatformAdminEmail,
  isLegacyPlatformAdminBearer,
  resetPlatformAdminEmailCache,
} from '../src/platformAdmin.js';

describe('platformAdmin', () => {
  let savedEmails: string;
  let savedSecret: string;
  let savedAuthMode: string;

  beforeEach(() => {
    savedEmails = config.platformAdminEmails;
    savedSecret = config.apiSecret;
    savedAuthMode = config.authMode;
    resetPlatformAdminEmailCache();
  });

  afterEach(() => {
    (config as { platformAdminEmails: string }).platformAdminEmails = savedEmails;
    (config as { apiSecret: string }).apiSecret = savedSecret;
    (config as { authMode: 'legacy' | 'oidc' }).authMode = savedAuthMode as 'legacy' | 'oidc';
    resetPlatformAdminEmailCache();
  });

  it('matches platform admin emails case-insensitively', () => {
    (config as { platformAdminEmails: string }).platformAdminEmails = 'Ops@Jungle.win, aidan@example.com';
    resetPlatformAdminEmailCache();
    assert.equal(isPlatformAdminEmail('ops@jungle.win'), true);
    assert.equal(isPlatformAdminEmail('AIDAN@example.com'), true);
    assert.equal(isPlatformAdminEmail('other@example.com'), false);
  });

  it('grants legacy platform admin when bearer matches API_SECRET', () => {
    (config as { authMode: 'legacy' | 'oidc' }).authMode = 'legacy';
    (config as { apiSecret: string }).apiSecret = 'test-secret';
    const req = {
      headers: { authorization: 'Bearer test-secret' },
    } as Request;
    assert.equal(isLegacyPlatformAdminBearer(req), true);

    const badReq = {
      headers: { authorization: 'Bearer wrong' },
    } as Request;
    assert.equal(isLegacyPlatformAdminBearer(badReq), false);
  });
});
