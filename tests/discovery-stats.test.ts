import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tempDir = mkdtempSync(join(tmpdir(), 'discovery-stats-test-'));

let initDatabase: typeof import('../src/database.js').initDatabase;
let closeDatabase: typeof import('../src/database.js').closeDatabase;
let getDatabase: typeof import('../src/database.js').getDatabase;
let initDiscoveryDatabase: typeof import('../src/discovery/discoveryDatabase.js').initDiscoveryDatabase;
let closeDiscoveryDatabase: typeof import('../src/discovery/discoveryDatabase.js').closeDiscoveryDatabase;
let getDiscoveryDatabase: typeof import('../src/discovery/discoveryDatabase.js').getDiscoveryDatabase;
let getSourceCheckpoint: typeof import('../src/discovery/sourceCheckpointStore.js').getSourceCheckpoint;
let upsertSourceCheckpoint: typeof import('../src/discovery/sourceCheckpointStore.js').upsertSourceCheckpoint;
let applyDiscoveredTradesToState: typeof import('../src/discovery/discoveryState.js').applyDiscoveredTradesToState;
let getWalletState: typeof import('../src/discovery/discoveryState.js').getWalletState;
let getMarketState: typeof import('../src/discovery/discoveryState.js').getMarketState;
let getWalletMarketState: typeof import('../src/discovery/discoveryState.js').getWalletMarketState;
let insertTradeBatch: typeof import('../src/discovery/statsStore.js').insertTradeBatch;
let upsertWallet: typeof import('../src/discovery/statsStore.js').upsertWallet;
let aggregateStats: typeof import('../src/discovery/statsStore.js').aggregateStats;
let getWalletStats: typeof import('../src/discovery/statsStore.js').getWalletStats;
let refreshWalletStats: typeof import('../src/discovery/statsStore.js').refreshWalletStats;
let upsertMarketCache: typeof import('../src/discovery/statsStore.js').upsertMarketCache;
let getMarketByConditionId: typeof import('../src/discovery/statsStore.js').getMarketByConditionId;
let upsertPosition: typeof import('../src/discovery/statsStore.js').upsertPosition;
let insertSignal: typeof import('../src/discovery/statsStore.js').insertSignal;
let dismissSignal: typeof import('../src/discovery/statsStore.js').dismissSignal;
let cleanupOldSignals: typeof import('../src/discovery/statsStore.js').cleanupOldSignals;
let getSignalsForAddress: typeof import('../src/discovery/statsStore.js').getSignalsForAddress;
let refreshPositionPrices: typeof import('../src/discovery/positionTracker.js').refreshPositionPrices;

const hasMountedRoutePrefix = (app: any, prefix: string): boolean => {
  const stack = app?._router?.stack ?? [];
  return stack.some((layer: any) => String(layer.regexp || '').includes(prefix));
};

beforeEach(async () => {
  const configMod = await import('../src/config.js');
  (configMod.config as any).dataDir = tempDir;

  try {
    const dbMod = await import('../src/database.js');
    dbMod.closeDatabase();
  } catch {
    /* noop */
  }

  const dbMod = await import('../src/database.js');
  initDatabase = dbMod.initDatabase;
  closeDatabase = dbMod.closeDatabase;
  getDatabase = dbMod.getDatabase;

  const discoveryDbMod = await import('../src/discovery/discoveryDatabase.js');
  initDiscoveryDatabase = discoveryDbMod.initDiscoveryDatabase;
  closeDiscoveryDatabase = discoveryDbMod.closeDiscoveryDatabase;
  getDiscoveryDatabase = discoveryDbMod.getDiscoveryDatabase;

  const checkpointMod = await import('../src/discovery/sourceCheckpointStore.js');
  getSourceCheckpoint = checkpointMod.getSourceCheckpoint;
  upsertSourceCheckpoint = checkpointMod.upsertSourceCheckpoint;

  const discoveryStateMod = await import('../src/discovery/discoveryState.js');
  applyDiscoveredTradesToState = discoveryStateMod.applyDiscoveredTradesToState;
  getWalletState = discoveryStateMod.getWalletState;
  getMarketState = discoveryStateMod.getMarketState;
  getWalletMarketState = discoveryStateMod.getWalletMarketState;

  const statsMod = await import('../src/discovery/statsStore.js');
  insertTradeBatch = statsMod.insertTradeBatch;
  upsertWallet = statsMod.upsertWallet;
  aggregateStats = statsMod.aggregateStats;
  getWalletStats = statsMod.getWalletStats;
  refreshWalletStats = statsMod.refreshWalletStats;
  upsertMarketCache = statsMod.upsertMarketCache;
  getMarketByConditionId = statsMod.getMarketByConditionId;
  upsertPosition = statsMod.upsertPosition;
  insertSignal = statsMod.insertSignal;
  dismissSignal = statsMod.dismissSignal;
  cleanupOldSignals = statsMod.cleanupOldSignals;
  getSignalsForAddress = statsMod.getSignalsForAddress;

  const positionMod = await import('../src/discovery/positionTracker.js');
  refreshPositionPrices = positionMod.refreshPositionPrices;

  await initDatabase();
  await initDiscoveryDatabase();
});

afterEach(() => {
  closeDiscoveryDatabase();
  closeDatabase();
  const dbPath = join(tempDir, 'copytrade.db');
  const discoveryDbPath = join(tempDir, 'discovery.db');
  if (existsSync(dbPath)) rmSync(dbPath);
  if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
  if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
  if (existsSync(discoveryDbPath)) rmSync(discoveryDbPath);
  if (existsSync(`${discoveryDbPath}-wal`)) rmSync(`${discoveryDbPath}-wal`);
  if (existsSync(`${discoveryDbPath}-shm`)) rmSync(`${discoveryDbPath}-shm`);
});

test('aggregateStats credits discovery activity to the observed wallet side only', () => {
  const detectedAt = Date.now();
  insertTradeBatch([
    {
      txHash: 'tx-1',
      eventKey: 'tx-1:event',
      maker: '0xmaker000000000000000000000000000000000001',
      taker: '0xtaker000000000000000000000000000000000001',
      assetId: 'asset-1',
      conditionId: 'condition-1',
      marketTitle: 'Will the Fed cut rates?',
      side: 'BUY',
      size: 100,
      price: 0.5,
      notionalUsd: 50,
      fee: 0,
      source: 'api',
      detectedAt,
    },
  ]);

  upsertWallet('0xmaker000000000000000000000000000000000001', detectedAt);
  upsertWallet('0xtaker000000000000000000000000000000000001', detectedAt);

  aggregateStats();

  const makerStats = getWalletStats('0xmaker000000000000000000000000000000000001');
  const takerStats = getWalletStats('0xtaker000000000000000000000000000000000001');

  assert.ok(makerStats);
  assert.ok(takerStats);
  assert.equal(makerStats.tradeCount7d, 1);
  assert.equal(makerStats.volume7d, 50);
  assert.equal(takerStats.tradeCount7d, 0);
  assert.equal(takerStats.volume7d, 0);
});

test('upsertMarketCache persists priority metadata for the discovery universe', () => {
  upsertMarketCache({
    conditionId: 'condition-tier-a',
    slug: 'will-the-fed-cut-rates-in-june',
    title: 'Will the Fed cut rates in June?',
    volume24h: 125000,
    tokenIds: ['yes-token', 'no-token'],
    outcomes: ['Yes', 'No'],
    category: 'macro',
    primaryDiscoveryEligible: true,
    highInformationPriority: true,
    priorityTier: 'A',
    priorityScore: 97,
    noveltyScore: 22,
    activityScore: 75,
    inclusionReason: 'High-information market with strong activity',
    updatedAt: Math.floor(Date.now() / 1000),
  } as any);

  const persisted = getMarketByConditionId('condition-tier-a');

  assert.ok(persisted);
  assert.equal(persisted.priorityTier, 'A');
  assert.equal(persisted.priorityScore, 97);
  assert.equal(persisted.noveltyScore, 22);
  assert.equal(persisted.activityScore, 75);
  assert.equal(persisted.inclusionReason, 'High-information market with strong activity');
});

test('source checkpoints persist bounded recovery cursors', () => {
  upsertSourceCheckpoint('market-stream', 'cursor-123', {
    lastEventAt: 1710000000000,
    markets: ['condition-a', 'condition-b'],
  });

  const checkpoint = getSourceCheckpoint('market-stream');

  assert.ok(checkpoint);
  assert.equal(checkpoint.cursor, 'cursor-123');
  assert.deepEqual(checkpoint.metadata, {
    lastEventAt: 1710000000000,
    markets: ['condition-a', 'condition-b'],
  });
});

test('applyDiscoveredTradesToState updates only touched wallet and market projections', () => {
  const detectedAt = Date.now();
  applyDiscoveredTradesToState([
    {
      txHash: 'state-1',
      eventKey: 'state-1:event',
      maker: '0xmaker000000000000000000000000000000000010',
      taker: '',
      assetId: 'asset-a',
      conditionId: 'condition-a',
      marketTitle: 'Will the Fed cut rates?',
      marketSlug: 'will-the-fed-cut-rates',
      side: 'BUY',
      size: 100,
      price: 0.5,
      notionalUsd: 50,
      fee: 0,
      source: 'api',
      detectedAt,
    },
    {
      txHash: 'state-2',
      eventKey: 'state-2:event',
      maker: '0xmaker000000000000000000000000000000000010',
      taker: '',
      assetId: 'asset-b',
      conditionId: 'condition-b',
      marketTitle: 'Will inflation fall below 3%?',
      marketSlug: 'will-inflation-fall-below-3',
      side: 'BUY',
      size: 60,
      price: 0.4,
      notionalUsd: 24,
      fee: 0,
      source: 'api',
      detectedAt: detectedAt + 1,
    },
  ] as any);

  const walletState = getWalletState('0xmaker000000000000000000000000000000000010');
  const marketState = getMarketState('condition-a');
  const walletMarketState = getWalletMarketState('0xmaker000000000000000000000000000000000010', 'condition-b');

  assert.ok(walletState);
  assert.equal(walletState.tradeCount, 2);
  assert.equal(walletState.totalVolume, 74);

  assert.ok(marketState);
  assert.equal(marketState.tradeCount, 1);
  assert.equal(marketState.totalVolume, 50);

  assert.ok(walletMarketState);
  assert.equal(walletMarketState.tradeCount, 1);
  assert.equal(walletMarketState.totalVolume, 24);
});

test('refreshWalletStats updates wallet aggregates immediately for a touched wallet', () => {
  const detectedAt = Date.now();
  const address = '0xmaker000000000000000000000000000000000002';

  upsertWallet(address, detectedAt);
  insertTradeBatch([
    {
      txHash: 'tx-2',
      eventKey: 'tx-2:event',
      maker: address,
      taker: '',
      assetId: 'asset-2',
      conditionId: 'condition-2',
      marketTitle: 'Will the Fed cut rates in June?',
      marketSlug: 'will-the-fed-cut-rates-in-june',
      side: 'BUY',
      size: 20,
      price: 0.75,
      notionalUsd: 15,
      fee: 0,
      source: 'api',
      detectedAt,
    },
  ]);

  const beforeRefresh = getWalletStats(address);
  assert.ok(beforeRefresh);
  assert.equal(beforeRefresh.tradeCount7d, 0);

  refreshWalletStats([address]);

  const afterRefresh = getWalletStats(address);
  assert.ok(afterRefresh);
  assert.equal(afterRefresh.tradeCount7d, 1);
  assert.equal(afterRefresh.volume7d, 15);
  assert.equal(afterRefresh.avgTradeSize, 15);
});

test('refreshPositionPrices nulls roi when a wallet has no active priced positions', async () => {
  const detectedAt = Date.now();
  const address = '0xmaker000000000000000000000000000000000003';

  upsertWallet(address, detectedAt);

  const beforeRefresh = getWalletStats(address);
  assert.ok(beforeRefresh);
  assert.equal(beforeRefresh.roiPct, 0);

  await refreshPositionPrices();

  const afterRefresh = getWalletStats(address);
  assert.ok(afterRefresh);
  assert.equal(afterRefresh.activePositions, 0);
  assert.equal(afterRefresh.roiPct, null);
});

test('initDatabase repairs legacy discovery_positions uniqueness so separate outcomes can coexist', async () => {
  closeDatabase();
  const dbPath = join(tempDir, 'copytrade.db');
  if (existsSync(dbPath)) rmSync(dbPath);
  if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
  if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
  const Database = (await import('better-sqlite3')).default;
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE discovery_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      market_slug TEXT,
      market_title TEXT,
      side TEXT,
      shares REAL DEFAULT 0,
      avg_entry REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      total_trades INTEGER DEFAULT 0,
      first_entry INTEGER,
      last_entry INTEGER,
      current_price REAL,
      unrealized_pnl REAL DEFAULT 0,
      roi_pct REAL DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch()),
      asset_id TEXT,
      outcome TEXT,
      price_updated_at INTEGER,
      UNIQUE(address, condition_id)
    );
  `);
  legacyDb.close();

  await initDatabase();

  assert.doesNotThrow(() => {
    upsertPosition('0xmaker000000000000000000000000000000000099', 'condition-legacy', 'asset-yes', 'BUY', 10, 0.4, 'Yes');
    upsertPosition('0xmaker000000000000000000000000000000000099', 'condition-legacy', 'asset-no', 'BUY', 12, 0.6, 'No');
  });
});

test('aggregateStats resets stale wallet activity when no recent trades remain', () => {
  const detectedAt = Date.now() - 15 * 86400 * 1000;
  const address = '0xmaker000000000000000000000000000000000004';

  upsertWallet(address, detectedAt);
  insertTradeBatch([
    {
      txHash: 'tx-3',
      eventKey: 'tx-3:event',
      maker: address,
      taker: '',
      assetId: 'asset-3',
      conditionId: 'condition-3',
      marketTitle: 'Old market activity',
      side: 'BUY',
      size: 10,
      price: 0.5,
      notionalUsd: 5,
      fee: 0,
      source: 'api',
      detectedAt,
    },
  ]);

  refreshWalletStats([address], Math.floor(detectedAt / 1000));
  const beforeAggregate = getWalletStats(address);
  assert.ok(beforeAggregate);
  assert.equal(beforeAggregate.tradeCount7d, 1);

  aggregateStats();

  const afterAggregate = getWalletStats(address);
  assert.ok(afterAggregate);
  assert.equal(afterAggregate.tradeCount7d, 0);
  assert.equal(afterAggregate.volume7d, 0);
});

test('aggregateStats counts market diversity by condition rather than outcome token', () => {
  const detectedAt = Date.now();
  const address = '0xmaker000000000000000000000000000000000005';

  upsertWallet(address, detectedAt);
  insertTradeBatch([
    {
      txHash: 'tx-4',
      eventKey: 'tx-4:event:yes',
      maker: address,
      taker: '',
      assetId: 'asset-yes',
      conditionId: 'condition-4',
      marketTitle: 'Same market yes',
      side: 'BUY',
      size: 100,
      price: 0.4,
      notionalUsd: 40,
      fee: 0,
      source: 'api',
      detectedAt,
    },
    {
      txHash: 'tx-5',
      eventKey: 'tx-5:event:no',
      maker: address,
      taker: '',
      assetId: 'asset-no',
      conditionId: 'condition-4',
      marketTitle: 'Same market no',
      side: 'SELL',
      size: 60,
      price: 0.6,
      notionalUsd: 36,
      fee: 0,
      source: 'api',
      detectedAt: detectedAt + 1,
    },
  ]);

  aggregateStats();

  const stats = getWalletStats(address);
  assert.ok(stats);
  assert.equal(stats.uniqueMarkets7d, 1);
});

test('aggregateStats excludes crypto trades from discovery wallet stats', () => {
  const detectedAt = Date.now();
  const address = '0xmaker000000000000000000000000000000000008';

  upsertWallet(address, detectedAt);
  insertTradeBatch([
    {
      txHash: 'tx-crypto',
      eventKey: 'tx-crypto:event',
      maker: address,
      taker: '',
      assetId: 'asset-crypto',
      conditionId: 'condition-crypto',
      marketTitle: 'Will Bitcoin be above $150k by June?',
      marketSlug: 'will-bitcoin-be-above-150k-by-june',
      side: 'BUY',
      size: 100,
      price: 0.6,
      notionalUsd: 60,
      fee: 0,
      source: 'api',
      detectedAt,
    },
    {
      txHash: 'tx-politics',
      eventKey: 'tx-politics:event',
      maker: address,
      taker: '',
      assetId: 'asset-politics',
      conditionId: 'condition-politics',
      marketTitle: 'Will Democrats win the House in 2026?',
      marketSlug: 'will-democrats-win-the-house-in-2026',
      side: 'BUY',
      size: 200,
      price: 0.5,
      notionalUsd: 100,
      fee: 0,
      source: 'api',
      detectedAt: detectedAt + 1,
    },
  ]);

  aggregateStats();

  const stats = getWalletStats(address);
  assert.ok(stats);
  assert.equal(stats.tradeCount7d, 1);
  assert.equal(stats.volume7d, 100);
  assert.equal(stats.focusCategory, 'politics');
});

test('dismissSignal clears stale wallet signal markers when no active signals remain', () => {
  const detectedAt = Date.now();
  const address = '0xmaker000000000000000000000000000000000006';

  upsertWallet(address, detectedAt);
  insertSignal({
    signalType: 'SIZE_ANOMALY',
    severity: 'high',
    address,
    conditionId: 'condition-6',
    marketTitle: 'Signal market',
    title: 'Signal title',
    description: 'Signal description',
    detectedAt,
  });

  const insertedSignals = getSignalsForAddress(address, 10);
  assert.equal(insertedSignals.length, 1);

  dismissSignal(insertedSignals[0]!.id!);

  const stats = getWalletStats(address);
  assert.ok(stats);
  assert.equal(stats.lastSignalAt, undefined);
  assert.equal(stats.lastSignalType, undefined);
});

test('cleanupOldSignals clears wallet signal markers when old signals are removed', () => {
  const oldDetectedAt = Date.now() - 40 * 86400 * 1000;
  const address = '0xmaker000000000000000000000000000000000007';

  upsertWallet(address, oldDetectedAt);
  insertSignal({
    signalType: 'VOLUME_SPIKE',
    severity: 'high',
    address,
    title: 'Old signal',
    description: 'Old signal description',
    detectedAt: oldDetectedAt,
  });

  cleanupOldSignals(30);

  const stats = getWalletStats(address);
  assert.ok(stats);
  assert.equal(stats.lastSignalAt, undefined);
  assert.equal(stats.lastSignalType, undefined);
});

test('createServer initializes the main database and mounts the discovery proxy route', async () => {
  closeDatabase();

  const { createServer } = await import('../src/server.js');
  const app = await createServer({
    getPerformanceTracker: () => ({}),
  } as any);

  assert.doesNotThrow(() => getDatabase());
  assert.equal(hasMountedRoutePrefix(app, '\\/api\\/discovery'), true);
});

test('createDiscoveryServiceServer mounts discovery routes in the discovery process', async () => {
  const { createDiscoveryServiceServer } = await import('../src/discovery/serviceServer.js');
  const app = await createDiscoveryServiceServer();

  assert.equal(hasMountedRoutePrefix(app, '\\/api\\/discovery'), true);
});

test('initDiscoveryDatabase uses a separate discovery.db file', async () => {
  closeDiscoveryDatabase();
  const dbPath = join(tempDir, 'copytrade.db');
  const discoveryDbPath = join(tempDir, 'discovery.db');

  if (existsSync(discoveryDbPath)) rmSync(discoveryDbPath);
  if (existsSync(`${discoveryDbPath}-wal`)) rmSync(`${discoveryDbPath}-wal`);
  if (existsSync(`${discoveryDbPath}-shm`)) rmSync(`${discoveryDbPath}-shm`);

  closeDatabase();
  if (existsSync(dbPath)) rmSync(dbPath);
  if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
  if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);

  await initDiscoveryDatabase();

  assert.doesNotThrow(() => getDiscoveryDatabase());
  assert.equal(existsSync(discoveryDbPath), true);
  assert.equal(existsSync(dbPath), false);
  assert.throws(() => getDatabase(), /Database not initialized/);
});
