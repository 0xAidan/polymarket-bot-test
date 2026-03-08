import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { config } from '../src/config.js';
import { closeDatabase, initDatabase } from '../src/database.js';
import {
  buildWalletValidationRecord,
  getWalletValidation,
  upsertWalletValidation,
} from '../src/discovery/walletValidator.ts';

test('buildWalletValidationRecord summarizes realized pnl and activity mix', () => {
  const record = buildWalletValidationRecord({
    address: '0xABC',
    profile: {
      name: 'Macro Alpha',
      pseudonym: 'macro-alpha',
      xUsername: 'macroalpha',
      verifiedBadge: true,
    },
    traded: { traded: 14 },
    positions: [{ conditionId: 'c1' }, { conditionId: 'c2' }],
    closedPositions: [
      { realizedPnl: 120, title: 'Fed Market' },
      { realizedPnl: -20, title: 'Election Market' },
    ],
    activity: [
      { type: 'TRADE', side: 'BUY', marketSlug: 'fed' },
      { type: 'TRADE', side: 'SELL', marketSlug: 'fed' },
      { type: 'MAKER_REBATE', marketSlug: 'fed' },
    ],
    validatedAt: 1710000000,
  });

  assert.equal(record.address, '0xabc');
  assert.equal(record.profileName, 'Macro Alpha');
  assert.equal(record.tradedMarkets, 14);
  assert.equal(record.openPositionsCount, 2);
  assert.equal(record.closedPositionsCount, 2);
  assert.equal(record.realizedPnl, 100);
  assert.equal(record.realizedWinRate, 50);
  assert.equal(record.tradeActivityCount, 2);
  assert.equal(record.buyActivityCount, 1);
  assert.equal(record.sellActivityCount, 1);
  assert.equal(record.makerRebateCount, 1);
  assert.equal(record.marketsTouched, 1);
});

test('wallet validation records are persisted and retrieved', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-wallet-validation-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    upsertWalletValidation({
      address: '0xabc',
      profileName: 'Macro Alpha',
      pseudonym: 'macro-alpha',
      xUsername: 'macroalpha',
      verifiedBadge: true,
      tradedMarkets: 14,
      openPositionsCount: 2,
      closedPositionsCount: 2,
      realizedPnl: 100,
      realizedWinRate: 50,
      makerRebateCount: 1,
      tradeActivityCount: 2,
      buyActivityCount: 1,
      sellActivityCount: 1,
      marketsTouched: 1,
      lastValidatedAt: 1710000000,
      rawProfile: { name: 'Macro Alpha' },
      rawPositions: [{ conditionId: 'c1' }],
      rawClosedPositions: [{ realizedPnl: 120 }],
      rawActivity: [{ type: 'TRADE' }],
    });

    const record = getWalletValidation('0xabc');
    assert.ok(record);
    assert.equal(record?.profileName, 'Macro Alpha');
    assert.equal(record?.realizedPnl, 100);
    assert.equal(record?.makerRebateCount, 1);
    assert.deepEqual(record?.rawProfile, { name: 'Macro Alpha' });
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
