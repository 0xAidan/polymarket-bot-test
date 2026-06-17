import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePolymarketWalletInput,
  resolveTrackedWalletAddress,
} from '../src/trackedWalletAddress.js';
import {
  verifyPolymarketAddress,
  resolveAgentPolymarketProxy,
} from '../src/jungleAgentsPolymarketSync.js';

describe('trackedWalletAddress', () => {
  it('parsePolymarketWalletInput accepts raw addresses', () => {
    const parsed = parsePolymarketWalletInput('0x6a417ef3ce4c45a0579fdeffdd82609ed36ee8d5');
    assert.deepEqual(parsed, {
      kind: 'address',
      value: '0x6a417ef3ce4c45a0579fdeffdd82609ed36ee8d5',
    });
  });

  it('parsePolymarketWalletInput accepts @usernames', () => {
    const parsed = parsePolymarketWalletInput('@junglekingagent');
    assert.deepEqual(parsed, { kind: 'username', value: 'junglekingagent' });
  });

  it('parsePolymarketWalletInput accepts Polymarket profile URLs', () => {
    const parsed = parsePolymarketWalletInput('https://polymarket.com/profile/@junglekingagent?tab=activity');
    assert.deepEqual(parsed, { kind: 'username', value: 'junglekingagent' });
  });

  it('resolveTrackedWalletAddress resolves junglekingagent to active proxy wallet', async () => {
    const resolved = await resolveTrackedWalletAddress('@junglekingagent');
    assert.equal(resolved.monitoringAddress, '0x6a417ef3ce4c45a0579fdeffdd82609ed36ee8d5');
    assert.equal(resolved.verification.isLikelyValid, true);
    assert.equal(resolved.source, 'gamma_username');
  });

  it('resolveTrackedWalletAddress rejects inactive wallet addresses', async () => {
    const resolved = await resolveTrackedWalletAddress('0x426771707e3dfeab030be6fdb9b2a328568fd315');
    assert.equal(resolved.verification.isLikelyValid, false);
  });
});

describe('jungleAgentsPolymarketSync', () => {
  it('verifyPolymarketAddress marks inactive wallets as invalid', async () => {
    const result = await verifyPolymarketAddress('0x426771707e3dfeab030be6fdb9b2a328568fd315');
    assert.equal(result.hasActivity, false);
    assert.equal(result.portfolioValueUsd, 0);
    assert.equal(result.isLikelyValid, false);
  });

  it('verifyPolymarketAddress marks active proxy wallets as valid', async () => {
    const result = await verifyPolymarketAddress('0xa42451f52ee663df451a6fecc704850469b2ee6f');
    assert.equal(result.isLikelyValid, true);
    assert.ok(result.portfolioValueUsd > 0 || result.hasActivity);
  });

  it('resolveAgentPolymarketProxy resolves Jungle King to active @junglekingagent wallet', async () => {
    const proxy = await resolveAgentPolymarketProxy({
      id: 'test',
      displayName: 'Jungle King',
      tagline: 'King Algorithm',
      modelLabel: 'King Algorithm',
      polymarketAddress: '0x426771707e3dfeab030be6fdb9b2a328568fd315',
      polymarketUsername: 'junglekingagent',
      olympicsProfileUrl: 'https://olympics.jungle.win/agents',
      sortOrder: 2,
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
    });
    assert.equal(proxy, '0x6a417ef3ce4c45a0579fdeffdd82609ed36ee8d5');
  });
});
