import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================================
// Cross-Platform Module Tests
// Tests platform abstraction, executor, and P&L tracker
// ============================================================================

let tmpDir = path.join(os.tmpdir(), `cross-platform-test-${Date.now()}`);

describe('Platform Abstraction Layer', () => {
  it('platformRegistry exports correct functions', async () => {
    const reg = await import('../src/platform/platformRegistry.js');
    assert.ok(typeof reg.getAdapter === 'function');
    assert.ok(typeof reg.getAllAdapters === 'function');
    assert.ok(typeof reg.getConfiguredAdapters === 'function');
    assert.ok(typeof reg.getExecutableAdapters === 'function');
    assert.ok(typeof reg.isPlatformConfigured === 'function');
    assert.ok(typeof reg.getAllPlatformStatuses === 'function');
  });

  it('getAdapter returns adapters for known platforms', async () => {
    const reg = await import('../src/platform/platformRegistry.js');
    const poly = reg.getAdapter('polymarket');
    assert.equal(poly.platform, 'polymarket');

    const kalshi = reg.getAdapter('kalshi');
    assert.equal(kalshi.platform, 'kalshi');
  });

  it('getAdapter throws for unknown platform', async () => {
    const reg = await import('../src/platform/platformRegistry.js');
    assert.throws(() => reg.getAdapter('unknown' as any), /Unknown platform/);
  });

  it('getAllAdapters returns both adapters', async () => {
    const reg = await import('../src/platform/platformRegistry.js');
    const adapters = reg.getAllAdapters();
    assert.equal(adapters.length, 2);
    const platforms = adapters.map(a => a.platform);
    assert.ok(platforms.includes('polymarket'));
    assert.ok(platforms.includes('kalshi'));
  });

  it('getAllPlatformStatuses returns status for each', async () => {
    const reg = await import('../src/platform/platformRegistry.js');
    const statuses = reg.getAllPlatformStatuses();
    assert.equal(statuses.length, 2);
    for (const s of statuses) {
      assert.ok('platform' in s);
      assert.ok('configured' in s);
      assert.ok('canExecute' in s);
      assert.ok('label' in s);
    }
  });

  it('adapter getStatus returns correct structure', async () => {
    const reg = await import('../src/platform/platformRegistry.js');
    const polyStatus = reg.getAdapter('polymarket').getStatus();
    assert.ok('configured' in polyStatus);
    assert.ok('canExecute' in polyStatus);
    assert.ok('label' in polyStatus);
    assert.equal(polyStatus.label, 'Polymarket');

    const kalshiStatus = reg.getAdapter('kalshi').getStatus();
    assert.equal(kalshiStatus.label, 'Kalshi');
  });

  it('polymarket adapter derives prices from the order book directly', async () => {
    const { PolymarketApi } = await import('../src/polymarketApi.js');
    const originalGetOrderBook = PolymarketApi.prototype.getOrderBook;

    PolymarketApi.prototype.getOrderBook = async () => ({
      market: {
        tokens: [
          { token_id: 'token-yes', price: '0.63' },
        ],
      },
    });

    try {
      const { PolymarketAdapter } = await import('../src/platform/polymarketAdapter.js');
      const adapter = new PolymarketAdapter();
      const price = await adapter.getMarketPrice('token-yes');

      assert.deepEqual(price, {
        yesPrice: 0.63,
        noPrice: 0.37,
      });
    } finally {
      PolymarketApi.prototype.getOrderBook = originalGetOrderBook;
    }
  });

  it('polymarket adapter normalizes positions from the Polymarket API directly', async () => {
    const { PolymarketApi } = await import('../src/polymarketApi.js');
    const originalGetUserPositions = PolymarketApi.prototype.getUserPositions;

    PolymarketApi.prototype.getUserPositions = async () => ([
      {
        asset: 'token-1',
        title: 'Who wins?',
        outcome: 'Yes',
        size: '12',
        avgPrice: '0.42',
        curPrice: '0.55',
        conditionId: 'condition-1',
      },
    ]);

    try {
      const { PolymarketAdapter } = await import('../src/platform/polymarketAdapter.js');
      const adapter = new PolymarketAdapter();
      const positions = await adapter.getPositions('0xwallet');

      assert.deepEqual(positions, [
        {
          platform: 'polymarket',
          marketId: 'token-1',
          marketTitle: 'Who wins?',
          outcome: 'Yes',
          side: 'YES',
          size: 12,
          avgPrice: 0.42,
          currentPrice: 0.55,
          conditionId: 'condition-1',
        },
      ]);
    } finally {
      PolymarketApi.prototype.getUserPositions = originalGetUserPositions;
    }
  });

  it('kalshi adapter derives prices from the native Kalshi market API directly', async () => {
    const kalshiSdk = await import('kalshi-typescript');
    const originalGetMarket = kalshiSdk.MarketApi.prototype.getMarket;
    const { config } = await import('../src/config.js');
    const savedKalshiApiKeyId = config.kalshiApiKeyId;
    const savedKalshiPrivateKeyPem = config.kalshiPrivateKeyPem;

    config.kalshiApiKeyId = 'test-kalshi-key';
    config.kalshiPrivateKeyPem = '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----';

    kalshiSdk.MarketApi.prototype.getMarket = async () => ({
      data: {
        market: {
          yes_bid: 58,
          yes_ask: 62,
          no_bid: 38,
          no_ask: 42,
        },
      },
    });

    try {
      const { KalshiAdapter } = await import('../src/platform/kalshiAdapter.js');
      const adapter = new KalshiAdapter();
      const price = await adapter.getMarketPrice('KXTEST-2026');

      assert.deepEqual(price, {
        yesPrice: 0.6,
        noPrice: 0.4,
      });
    } finally {
      kalshiSdk.MarketApi.prototype.getMarket = originalGetMarket;
      config.kalshiApiKeyId = savedKalshiApiKeyId;
      config.kalshiPrivateKeyPem = savedKalshiPrivateKeyPem;
    }
  });
});

describe('CrossPlatformExecutor', () => {
  let savedDataDir: string;

  beforeEach(async () => {
    // Fresh directory per test to avoid config leaking between tests
    tmpDir = path.join(os.tmpdir(), `cross-platform-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const { config } = await import('../src/config.js');
    savedDataDir = config.dataDir;
    config.dataDir = tmpDir;
  });

  after(async () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const { config } = await import('../src/config.js');
    config.dataDir = savedDataDir;
  });

  it('imports and initializes', async () => {
    const { CrossPlatformExecutor } = await import('../src/crossPlatformExecutor.js');
    const executor = new CrossPlatformExecutor();
    await executor.init();
    const status = executor.getStatus();
    assert.equal(status.paperMode, true); // default
    assert.equal(status.totalExecutions, 0);
  });

  it('getConfig returns default config', async () => {
    const { CrossPlatformExecutor } = await import('../src/crossPlatformExecutor.js');
    const executor = new CrossPlatformExecutor();
    await executor.init();
    const config = executor.getConfig();
    assert.equal(config.paperMode, true);
    assert.equal(config.maxTradeSize, 50);
    assert.equal(config.minSpread, 2);
    assert.equal(config.simultaneousExecution, true);
  });

  it('updateConfig persists changes', async () => {
    const { CrossPlatformExecutor } = await import('../src/crossPlatformExecutor.js');
    const executor = new CrossPlatformExecutor();
    await executor.init();
    await executor.updateConfig({ maxTradeSize: 100, minSpread: 5 });
    const config = executor.getConfig();
    assert.equal(config.maxTradeSize, 100);
    assert.equal(config.minSpread, 5);
  });

  it('executeArbPair in paper mode returns success', async () => {
    const { CrossPlatformExecutor } = await import('../src/crossPlatformExecutor.js');
    const executor = new CrossPlatformExecutor();
    await executor.init();

    const result = await executor.executeArbPair({
      id: 'test-arb-1',
      eventTitle: 'Test Event',
      buyPlatform: 'polymarket',
      buyMarketId: 'token-123',
      buySide: 'YES',
      buyPrice: 0.45,
      buySize: 10,
      sellPlatform: 'kalshi',
      sellMarketId: 'TICKER-123',
      sellSide: 'NO',
      sellPrice: 0.48,
      sellSize: 10,
      expectedProfit: 0.30,
      spreadPercent: 3,
    });

    assert.equal(result.paperMode, true);
    assert.equal(result.bothSucceeded, true);
    assert.equal(result.partialFill, false);
    assert.ok(result.buyResult.orderId?.startsWith('paper-'));

    // History should have 1 entry
    assert.equal(executor.getHistory().length, 1);
  });

  it('executeArbPair rejects low spread', async () => {
    const { CrossPlatformExecutor } = await import('../src/crossPlatformExecutor.js');
    const executor = new CrossPlatformExecutor();
    await executor.init();

    const result = await executor.executeArbPair({
      id: 'test-arb-low',
      eventTitle: 'Low Spread',
      buyPlatform: 'polymarket',
      buyMarketId: 'token-456',
      buySide: 'YES',
      buyPrice: 0.50,
      buySize: 10,
      sellPlatform: 'kalshi',
      sellMarketId: 'TICKER-456',
      sellSide: 'NO',
      sellPrice: 0.51,
      sellSize: 10,
      expectedProfit: 0.10,
      spreadPercent: 1, // Below minimum of 2
    });

    assert.equal(result.bothSucceeded, false);
    assert.ok(result.buyResult.error?.includes('below minimum'));
  });

  it('executeHedge in paper mode returns success', async () => {
    const { CrossPlatformExecutor } = await import('../src/crossPlatformExecutor.js');
    const executor = new CrossPlatformExecutor();
    await executor.init();

    const result = await executor.executeHedge({
      platform: 'polymarket',
      marketId: 'token-789',
      side: 'YES',
      action: 'BUY',
      size: 5,
      price: 0.60,
    });

    assert.equal(result.success, true);
    assert.ok(result.orderId?.startsWith('paper-hedge-'));
  });
});

describe('CrossPlatformPnlTracker', () => {
  let savedDataDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cross-platform-pnl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const { config } = await import('../src/config.js');
    savedDataDir = config.dataDir;
    config.dataDir = tmpDir;
  });

  after(async () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const { config } = await import('../src/config.js');
    config.dataDir = savedDataDir;
  });

  it('imports and initializes', async () => {
    const { CrossPlatformPnlTracker } = await import('../src/crossPlatformPnl.js');
    const tracker = new CrossPlatformPnlTracker();
    await tracker.init();
    const status = tracker.getStatus();
    assert.equal(status.matchedMarkets, 0);
    assert.equal(status.pnlSnapshots, 0);
  });

  it('smartRoute returns cheapest platform for BUY', async () => {
    const { CrossPlatformPnlTracker } = await import('../src/crossPlatformPnl.js');
    const tracker = new CrossPlatformPnlTracker();
    await tracker.init();

    const route = await tracker.smartRoute({
      side: 'YES',
      action: 'BUY',
      matchedMarket: {
        eventTitle: 'Test',
        polymarketTokenId: 'token-1',
        polymarketPrice: 0.55,
        kalshiTicker: 'TICKER-1',
        kalshiPrice: 0.50,
        lastUpdated: new Date().toISOString(),
      },
    });

    assert.ok(route);
    assert.equal(route.platform, 'kalshi'); // Cheaper
    assert.equal(route.price, 0.50);
    assert.ok(route.savings > 0);
  });

  it('smartRoute returns highest platform for SELL', async () => {
    const { CrossPlatformPnlTracker } = await import('../src/crossPlatformPnl.js');
    const tracker = new CrossPlatformPnlTracker();
    await tracker.init();

    const route = await tracker.smartRoute({
      side: 'YES',
      action: 'SELL',
      matchedMarket: {
        eventTitle: 'Test',
        polymarketTokenId: 'token-1',
        polymarketPrice: 0.55,
        kalshiTicker: 'TICKER-1',
        kalshiPrice: 0.50,
        lastUpdated: new Date().toISOString(),
      },
    });

    assert.ok(route);
    assert.equal(route.platform, 'polymarket'); // Higher price for selling
    assert.equal(route.price, 0.55);
  });

  it('getMatchedMarkets returns empty initially', async () => {
    const { CrossPlatformPnlTracker } = await import('../src/crossPlatformPnl.js');
    const tracker = new CrossPlatformPnlTracker();
    await tracker.init();
    assert.deepEqual(tracker.getMatchedMarkets(), []);
  });

  it('updateMatchedMarkets persists', async () => {
    const { CrossPlatformPnlTracker } = await import('../src/crossPlatformPnl.js');
    const tracker = new CrossPlatformPnlTracker();
    await tracker.init();

    const markets = [
      { eventTitle: 'Election 2024', polymarketTokenId: 't1', kalshiTicker: 'ELECT-YES', lastUpdated: new Date().toISOString() },
    ];
    await tracker.updateMatchedMarkets(markets);
    assert.equal(tracker.getMatchedMarkets().length, 1);
    assert.equal(tracker.getMatchedMarkets()[0].eventTitle, 'Election 2024');
  });
});
