import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscoveryMarketPoolEntries,
  deriveSeedCategory,
} from '../src/discovery/categorySeeder.ts';
import {
  buildTokenMapEntries,
  getTokenIdsForConditionId,
  getTokenMappingForTokenId,
  upsertTokenMapEntries,
} from '../src/discovery/tokenMapper.ts';
import { closeDatabase, initDatabase } from '../src/database.js';
import { config } from '../src/config.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, existsSync, rmSync } from 'fs';

test('deriveSeedCategory prefers first-party event tags over title heuristics', () => {
  const category = deriveSeedCategory({
    title: 'Will Bitcoin hit $150k this year?',
    slug: 'will-bitcoin-hit-150k',
    tags: [
      { slug: 'politics', label: 'Politics' },
    ],
  });

  assert.equal(category, 'politics');
});

test('buildDiscoveryMarketPoolEntries filters sports-like events out of the whitelist', () => {
  const entries = buildDiscoveryMarketPoolEntries([
    {
      id: 'event-1',
      slug: 'nba-finals',
      title: 'NBA Finals',
      tags: [{ slug: 'sports', label: 'Sports' }],
      markets: [
        {
          id: 'market-1',
          conditionId: 'condition-sports',
          slug: 'lakers-vs-celtics',
          question: 'Lakers vs Celtics',
          clobTokenIds: JSON.stringify(['yes-sports', 'no-sports']),
          outcomes: ['Yes', 'No'],
          volume24hr: '250000',
        },
      ],
    },
  ], Math.floor(Date.now() / 1000));

  assert.deepEqual(entries, []);
});

test('buildDiscoveryMarketPoolEntries keeps whitelisted real-world markets and attaches token ids', () => {
  const entries = buildDiscoveryMarketPoolEntries([
    {
      id: 'event-2',
      slug: 'fed-rates',
      title: 'Fed Rates',
      tags: [{ slug: 'economics', label: 'Economics' }],
      liquidity: 120000,
      volume24hr: 450000,
      openInterest: 320000,
      markets: [
        {
          id: 'market-2',
          conditionId: 'condition-fed',
          slug: 'will-the-fed-cut-rates-in-june',
          question: 'Will the Fed cut rates in June?',
          clobTokenIds: JSON.stringify(['yes-fed', 'no-fed']),
          outcomes: ['Yes', 'No'],
          volume24hr: '450000',
          acceptingOrders: true,
          competitive: true,
        },
      ],
    },
  ], 1710000000);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.conditionId, 'condition-fed');
  assert.equal(entries[0]?.focusCategory, 'macro');
  assert.deepEqual(entries[0]?.tokenIds, ['yes-fed', 'no-fed']);
});

test('buildTokenMapEntries creates condition to token mappings for each outcome', () => {
  const entries = buildTokenMapEntries([
    {
      conditionId: 'condition-fed',
      tokenIds: ['yes-fed', 'no-fed'],
      outcomes: ['Yes', 'No'],
      updatedAt: 1710000000,
    } as any,
  ]);

  assert.deepEqual(entries, [
    {
      conditionId: 'condition-fed',
      tokenId: 'yes-fed',
      outcome: 'Yes',
      updatedAt: 1710000000,
    },
    {
      conditionId: 'condition-fed',
      tokenId: 'no-fed',
      outcome: 'No',
      updatedAt: 1710000000,
    },
  ]);
});

test('tokenMapper stores and resolves token mappings by condition id and token id', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'discovery-token-map-'));
  (config as any).dataDir = tempDir;
  closeDatabase();
  await initDatabase();

  try {
    upsertTokenMapEntries([
      { conditionId: 'condition-fed', tokenId: 'yes-fed', outcome: 'Yes', updatedAt: 1710000000 },
      { conditionId: 'condition-fed', tokenId: 'no-fed', outcome: 'No', updatedAt: 1710000000 },
    ]);

    assert.deepEqual(getTokenIdsForConditionId('condition-fed'), ['yes-fed', 'no-fed']);
    assert.deepEqual(getTokenMappingForTokenId('yes-fed'), {
      conditionId: 'condition-fed',
      tokenId: 'yes-fed',
      outcome: 'Yes',
      updatedAt: 1710000000,
    });
  } finally {
    closeDatabase();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
