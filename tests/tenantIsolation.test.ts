import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { PolymarketApi } from '../src/polymarketApi.js';
import { resolveFunderAddress } from '../src/clobClientFactory.js';
import { getTenantIdStrict } from '../src/tenantContext.js';
import { runWithTenant } from '../src/tenantContext.js';
import { Storage } from '../src/storage.js';
import { closeDatabase } from '../src/database.js';
import { TradeExecutor } from '../src/tradeExecutor.js';

describe('tenant isolation hardening', () => {
  let savedAuthMode: string;
  let savedStorage: string;
  let savedPrivateKey: string;
  let savedDataDir: string;
  let savedFunderEnv: string | undefined;

  beforeEach(() => {
    savedAuthMode = config.authMode;
    savedStorage = config.storageBackend;
    savedPrivateKey = config.privateKey;
    savedDataDir = config.dataDir;
    savedFunderEnv = process.env.POLYMARKET_FUNDER_ADDRESS;
  });

  afterEach(() => {
    (config as any).authMode = savedAuthMode;
    (config as any).storageBackend = savedStorage;
    (config as any).privateKey = savedPrivateKey;
    (config as any).dataDir = savedDataDir;
    if (savedFunderEnv === undefined) {
      delete process.env.POLYMARKET_FUNDER_ADDRESS;
    } else {
      process.env.POLYMARKET_FUNDER_ADDRESS = savedFunderEnv;
    }
    closeDatabase();
  });

  it('hosted mode never uses env funder fallback for proxy lookup', async () => {
    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'sqlite';
    process.env.POLYMARKET_FUNDER_ADDRESS = '0x1111111111111111111111111111111111111111';

    const api = new PolymarketApi();
    (api as any).signer = { address: '0x2222222222222222222222222222222222222222' };
    (api as any).getUserPositions = async () => [];

    const proxy = await api.getProxyWalletAddress('0x3333333333333333333333333333333333333333');
    assert.equal(proxy, null);
  });

  it('hosted mode resolveFunderAddress does not use env fallback', async () => {
    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'sqlite';
    process.env.POLYMARKET_FUNDER_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const wallet = {
      id: 'tw1',
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      label: 'tw',
      isActive: true,
      createdAt: new Date().toISOString(),
      hasCredentials: true,
    } as any;

    const api = {
      getProxyWalletAddress: async () => null,
    } as any;

    const funder = await resolveFunderAddress(wallet, api);
    assert.equal(funder.toLowerCase(), wallet.address.toLowerCase());
  });

  it('getTenantIdStrict throws in hosted mode without context', () => {
    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'sqlite';
    assert.throws(() => getTenantIdStrict(), /Tenant context is required/);
  });

  it('getTenantIdStrict works when tenant context is set', () => {
    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'sqlite';
    const tenantId = runWithTenant('tenant-alpha', () => getTenantIdStrict());
    assert.equal(tenantId, 'tenant-alpha');
  });

  it('hosted mode forbids global trade executor client access', () => {
    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'sqlite';
    (config as any).privateKey = '';
    const executor = new TradeExecutor();
    assert.throws(() => executor.getClobClient(), /Hosted mode forbids global CLOB client access/);
  });

  it('hosted mode fails closed when sqlite init fails', async () => {
    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'sqlite';
    (config as any).dataDir = '/dev/null';
    await assert.rejects(() => Storage.loadTrackedWallets(), /SQLite initialization failed in hosted mode/);
  });

  it('config validation rejects hosted mode with PRIVATE_KEY set', () => {
    (config as any).authMode = 'oidc';
    (config as any).storageBackend = 'sqlite';
    (config as any).privateKey = '0xabc123';
    assert.throws(() => config.validate(), /forbids PRIVATE_KEY/);
  });
});
