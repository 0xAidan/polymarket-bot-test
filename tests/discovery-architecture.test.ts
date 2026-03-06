import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequestBudgetStatus } from '../src/discovery/apiPoller.js';
import { buildDiscoveryShadowComparison } from '../src/api/discoveryRoutes.ts';

test('buildRequestBudgetStatus flags over-budget discovery request volume', () => {
  const withinBudget = buildRequestBudgetStatus({
    gammaRefreshRequests: 3,
    tradePollRequests: 120,
    verificationRequests: 8,
  }, 200);
  const overBudget = buildRequestBudgetStatus({
    gammaRefreshRequests: 10,
    tradePollRequests: 180,
    verificationRequests: 25,
  }, 200);

  assert.equal(withinBudget.withinBudget, true);
  assert.equal(withinBudget.totalRequests, 131);
  assert.equal(overBudget.withinBudget, false);
});

test('buildDiscoveryShadowComparison compares grouped cards against the wallet table feed', () => {
  const shadow = buildDiscoveryShadowComparison(
    [
      { address: '0x1', trustLevel: 'verified' },
      { address: '0x2', trustLevel: 'provisional' },
    ] as any,
    {
      groups: [
        { id: 'emerging', title: 'Emerging Wallets', items: [{ address: '0x1' }] },
        { id: 'conviction', title: 'Conviction Builds', items: [{ address: '0x2' }] },
        { id: 'coordinated', title: 'Coordinated Markets', items: [] },
      ],
    },
  );

  assert.equal(shadow.legacyWalletCount, 2);
  assert.equal(shadow.groupedOpportunityCount, 2);
  assert.equal(shadow.groups[0].id, 'emerging');
});
