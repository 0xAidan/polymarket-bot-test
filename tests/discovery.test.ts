import test from 'node:test';
import assert from 'node:assert/strict';

import type { MarketCacheEntry } from '../src/discovery/types.js';
import {
  classifyMarketEntry,
} from '../src/discovery/tradeEnricher.js';
import {
  mapApiTradeToDiscoveredTrade,
} from '../src/discovery/apiPoller.js';
import {
  getTradeParticipantAddresses,
  buildSignalEvaluationTrades,
  buildPositionTrackingTrades,
} from '../src/discovery/tradeIngestion.js';
import {
  isEmergingSignalEligibleTrade,
  isPrimaryDiscoveryTrade,
  shouldFlagDormantActivation,
  shouldFlagNewWhale,
  findCoordinatedEntryCandidates,
} from '../src/discovery/signalEngine.ts';
import {
  shouldExposeDiscoverySignal,
} from '../src/discovery/statsStore.ts';
import {
  applyAuthoritativeWalletSummary,
  buildWalletPositionsResponse,
  applyDiscoveryWalletScore,
  buildDiscoveryOverview,
  buildDiscoveryWalletExplanation,
  matchesDiscoveryFocusFilter,
  paginateDiscoveryWalletsForPresentation,
  shouldIncludeDiscoveryWallet,
  sortWalletsForResponse,
} from '../src/api/discoveryRoutes.ts';
import {
  buildMarketTradesRequestParams,
  canStartPollCycle,
} from '../src/discovery/apiPoller.js';
import {
  computeDiscoveryWalletScore,
} from '../src/discovery/walletScorer.ts';
import {
  mapOfficialPositionToWalletPosition,
  summarizeAuthoritativePositions,
  buildPositionVerificationSummary,
  buildBackfillPositionTrades,
} from '../src/discovery/positionTracker.ts';

test('classifyMarketEntry keeps sports markets out of emerging feed but eligible for sharp-wallet tracking', () => {
  const market: MarketCacheEntry = {
    conditionId: '0xabc',
    slug: 'nba-lakers-vs-celtics-march-5',
    title: 'Los Angeles Lakers vs Boston Celtics',
    tokenIds: ['yes-token', 'no-token'],
    updatedAt: 1,
  };

  const classified = classifyMarketEntry(market);

  assert.equal(classified.isSportsLike, true);
  assert.equal(classified.isRecurring, true);
  assert.equal(classified.emergingEligible, false);
  assert.equal(classified.sharpWalletEligible, true);
});

test('classifyMarketEntry keeps event-driven non-sports markets eligible for emerging discovery', () => {
  const market: MarketCacheEntry = {
    conditionId: '0xdef',
    slug: 'will-the-fed-cut-rates-in-june',
    title: 'Will the Fed cut rates in June?',
    tokenIds: ['yes-token', 'no-token'],
    updatedAt: 1,
  };

  const classified = classifyMarketEntry(market);

  assert.equal(classified.isSportsLike, false);
  assert.equal(classified.emergingEligible, true);
  assert.equal(classified.sharpWalletEligible, true);
});

test('classifyMarketEntry excludes crypto markets from primary discovery', () => {
  const market: MarketCacheEntry = {
    conditionId: '0xcrypto',
    slug: 'will-bitcoin-be-above-150k-by-june',
    title: 'Will Bitcoin be above $150k by June?',
    tokenIds: ['yes-token', 'no-token'],
    updatedAt: 1,
  };

  const classified = classifyMarketEntry(market);

  assert.equal(classified.category, 'crypto');
  assert.equal(classified.emergingEligible, false);
  assert.equal(classified.sharpWalletEligible, false);
});

test('classifyMarketEntry does not misclassify real-world titles that merely contain crypto substrings', () => {
  const market: MarketCacheEntry = {
    conditionId: '0xlegal',
    slug: 'will-ethics-reform-pass-in-congress',
    title: 'Will ethics reform pass in Congress?',
    tokenIds: ['yes-token', 'no-token'],
    updatedAt: 1,
  };

  const classified = classifyMarketEntry(market);

  assert.notEqual(classified.category, 'crypto');
  assert.equal(classified.primaryDiscoveryEligible, true);
});

test('classifyMarketEntry keeps entertainment markets in discovery but marks them lower priority', () => {
  const market: MarketCacheEntry = {
    conditionId: '0xentertainment',
    slug: 'will-taylor-swift-announce-reputation-tv-in-2026',
    title: 'Will Taylor Swift announce Reputation TV in 2026?',
    tokenIds: ['yes-token', 'no-token'],
    updatedAt: 1,
  };

  const classified = classifyMarketEntry(market);

  assert.equal(classified.category, 'entertainment');
  assert.equal(classified.emergingEligible, true);
  assert.equal(classified.sharpWalletEligible, true);
  assert.equal(classified.highInformationPriority, false);
});

test('classifyMarketEntry marks politics and macro markets as high-information discovery candidates', () => {
  const politics = classifyMarketEntry({
    conditionId: '0xpolitics',
    slug: 'will-democrats-win-the-house-in-2026',
    title: 'Will Democrats win the House in 2026?',
    tokenIds: ['yes-token', 'no-token'],
    updatedAt: 1,
  });
  const macro = classifyMarketEntry({
    conditionId: '0xmacro',
    slug: 'will-the-fed-cut-rates-in-september',
    title: 'Will the Fed cut rates in September?',
    tokenIds: ['yes-token', 'no-token'],
    updatedAt: 1,
  });

  assert.equal(politics.category, 'politics');
  assert.equal(politics.highInformationPriority, true);
  assert.equal(macro.category, 'macro');
  assert.equal(macro.highInformationPriority, true);
});

test('mapApiTradeToDiscoveredTrade uses proxyWallet as the discovered wallet owner', () => {
  const market: MarketCacheEntry = {
    conditionId: '0xmarket',
    slug: 'will-fed-cut-rates',
    title: 'Will the Fed cut rates?',
    tokenIds: ['asset-yes', 'asset-no'],
    outcomes: ['Yes', 'No'],
    updatedAt: 1,
  };

  const trade = mapApiTradeToDiscoveredTrade({
    proxyWallet: '0x123400000000000000000000000000000000abcd',
    side: 'BUY',
    asset: 'asset-yes',
    conditionId: '0xmarket',
    size: 150,
    price: 0.61,
    timestamp: 1710000000000,
    transactionHash: '0xtxhash',
    outcome: 'Yes',
  }, market, 1710000000000);

  assert.equal(trade.maker, '0x123400000000000000000000000000000000abcd');
  assert.equal(trade.taker, '');
  assert.equal(trade.conditionId, '0xmarket');
  assert.equal(trade.assetId, 'asset-yes');
  assert.equal(trade.outcome, 'Yes');
  assert.equal(trade.notionalUsd, 91.5);
  assert.match(trade.txHash, /^0xtxhash/);
});

test('getTradeParticipantAddresses ignores empty counterparties', () => {
  const addresses = getTradeParticipantAddresses({
    maker: '0x123400000000000000000000000000000000abcd',
    taker: '',
  });

  assert.deepEqual(addresses, ['0x123400000000000000000000000000000000abcd']);
});

test('getTradeParticipantAddresses returns both maker and taker when present', () => {
  const addresses = getTradeParticipantAddresses({
    maker: '0x123400000000000000000000000000000000abcd',
    taker: '0x987600000000000000000000000000000000dcba',
  });

  assert.deepEqual(addresses, [
    '0x123400000000000000000000000000000000abcd',
    '0x987600000000000000000000000000000000dcba',
  ]);
});

test('mapApiTradeToDiscoveredTrade normalizes ISO timestamps', () => {
  const market: MarketCacheEntry = {
    conditionId: '0xmarket',
    slug: 'will-fed-cut-rates',
    title: 'Will the Fed cut rates?',
    tokenIds: ['asset-yes', 'asset-no'],
    outcomes: ['Yes', 'No'],
    updatedAt: 1,
  };
  const trade = mapApiTradeToDiscoveredTrade({
    proxyWallet: '0x123400000000000000000000000000000000abcd',
    side: 'BUY',
    asset: 'asset-yes',
    conditionId: '0xmarket',
    size: 10,
    price: 0.55,
    timestamp: '2026-03-09T12:00:00.000Z',
    transactionHash: '0xiso',
  }, market, 0);
  assert.equal(trade.detectedAt, new Date('2026-03-09T12:00:00.000Z').getTime());
});

test('mapOfficialPositionToWalletPosition marks authoritative wallet state correctly', () => {
  const mapped = mapOfficialPositionToWalletPosition({
    proxyWallet: '0x123400000000000000000000000000000000abcd',
    asset: 'asset-yes',
    conditionId: '0xmarket',
    size: 200,
    avgPrice: 0.42,
    initialValue: 84,
    currentValue: 118,
    cashPnl: 34,
    percentPnl: 40.5,
    realizedPnl: 12,
    curPrice: 0.59,
    title: 'Will the Fed cut rates?',
    slug: 'will-fed-cut-rates',
    outcome: 'Yes',
  });

  assert.equal(mapped.address, '0x123400000000000000000000000000000000abcd');
  assert.equal(mapped.assetId, 'asset-yes');
  assert.equal(mapped.shares, 200);
  assert.equal(mapped.totalCost, 84);
  assert.equal(mapped.currentPrice, 0.59);
  assert.equal(mapped.unrealizedPnl, 34);
  assert.equal(mapped.roiPct, 40.5);
  assert.equal(mapped.realizedPnl, 12);
  assert.equal(mapped.dataSource, 'verified');
});

test('summarizeAuthoritativePositions derives wallet-level pnl and roi from official positions', () => {
  const summary = summarizeAuthoritativePositions([
    mapOfficialPositionToWalletPosition({
      proxyWallet: '0x123400000000000000000000000000000000abcd',
      asset: 'asset-yes',
      conditionId: '0xmarket-1',
      size: 100,
      avgPrice: 0.4,
      initialValue: 40,
      currentValue: 65,
      cashPnl: 25,
      percentPnl: 62.5,
      curPrice: 0.65,
      title: 'Market 1',
      outcome: 'Yes',
    }),
    mapOfficialPositionToWalletPosition({
      proxyWallet: '0x123400000000000000000000000000000000abcd',
      asset: 'asset-no',
      conditionId: '0xmarket-2',
      size: 50,
      avgPrice: 0.5,
      initialValue: 25,
      currentValue: 20,
      cashPnl: -5,
      percentPnl: -20,
      curPrice: 0.4,
      title: 'Market 2',
      outcome: 'No',
    }),
  ]);

  assert.equal(summary.activePositions, 2);
  assert.equal(summary.totalPnl, 20);
  assert.equal(summary.totalCost, 65);
  assert.equal(summary.roiPct, 30.76923076923077);
});

test('isEmergingSignalEligibleTrade excludes recurring sports trades from event-driven signals', () => {
  assert.equal(isEmergingSignalEligibleTrade({
    marketTitle: 'Los Angeles Lakers vs Boston Celtics',
    marketSlug: 'nba-lakers-vs-celtics',
  }), false);

  assert.equal(isEmergingSignalEligibleTrade({
    marketTitle: 'Will Bitcoin be above $150k by June?',
    marketSlug: 'will-bitcoin-be-above-150k-by-june',
  }), false);

  assert.equal(isEmergingSignalEligibleTrade({
    marketTitle: 'Will the Fed cut rates in June?',
    marketSlug: 'will-the-fed-cut-rates-in-june',
  }), true);
});

test('isPrimaryDiscoveryTrade excludes crypto and sports but keeps real-world markets', () => {
  assert.equal(isPrimaryDiscoveryTrade({
    marketTitle: 'Will Bitcoin be above $150k by June?',
    marketSlug: 'will-bitcoin-be-above-150k-by-june',
  }), false);

  assert.equal(isPrimaryDiscoveryTrade({
    marketTitle: 'Los Angeles Lakers vs Boston Celtics',
    marketSlug: 'nba-lakers-vs-celtics',
  }), false);

  assert.equal(isPrimaryDiscoveryTrade({
    marketTitle: 'Will the Fed cut rates in June?',
    marketSlug: 'will-the-fed-cut-rates-in-june',
  }), true);
});

test('shouldExposeDiscoverySignal hides low-value size anomaly noise in backend responses', () => {
  assert.equal(shouldExposeDiscoverySignal({
    signalType: 'SIZE_ANOMALY',
    severity: 'medium',
    metadata: { notionalUsd: 2000 },
  } as any), false);

  assert.equal(shouldExposeDiscoverySignal({
    signalType: 'SIZE_ANOMALY',
    severity: 'high',
    metadata: { notionalUsd: 7000 },
  } as any), true);

  assert.equal(shouldExposeDiscoverySignal({
    signalType: 'CONVICTION_BUILD',
    severity: 'medium',
  } as any), true);
});

test('buildPositionVerificationSummary compares derived and verified position keys', () => {
  const verified = [
    mapOfficialPositionToWalletPosition({
      proxyWallet: '0x123400000000000000000000000000000000abcd',
      asset: 'asset-yes',
      conditionId: '0xmarket-1',
      size: 100,
      avgPrice: 0.4,
      initialValue: 40,
      currentValue: 65,
      cashPnl: 25,
      percentPnl: 62.5,
      curPrice: 0.65,
      title: 'Market 1',
      outcome: 'Yes',
    }),
  ];

  const derived = [
    {
      address: '0x123400000000000000000000000000000000abcd',
      conditionId: '0xmarket-1',
      assetId: 'asset-yes',
      shares: 90,
      avgEntry: 0.39,
      totalCost: 35.1,
      totalTrades: 2,
      firstEntry: 1,
      lastEntry: 2,
      unrealizedPnl: 20,
      roiPct: 57,
      dataSource: 'derived',
    },
    {
      address: '0x123400000000000000000000000000000000abcd',
      conditionId: '0xmarket-2',
      assetId: 'asset-no',
      shares: 10,
      avgEntry: 0.2,
      totalCost: 2,
      totalTrades: 1,
      firstEntry: 1,
      lastEntry: 2,
      unrealizedPnl: -1,
      roiPct: -50,
      dataSource: 'derived',
    },
  ] as any;

  const summary = buildPositionVerificationSummary(derived, verified);

  assert.equal(summary.derivedCount, 2);
  assert.equal(summary.verifiedCount, 1);
  assert.equal(summary.sharedCount, 1);
  assert.equal(summary.onlyDerivedCount, 1);
  assert.equal(summary.onlyVerifiedCount, 0);
});

test('applyAuthoritativeWalletSummary treats verified empty positions as zero exposure', () => {
  const wallet = {
    address: '0x123400000000000000000000000000000000abcd',
    roiPct: 42,
    totalPnl: 100,
    activePositions: 3,
  };

  const hydrated = applyAuthoritativeWalletSummary(wallet, []);

  assert.equal(hydrated.positionDataSource, 'verified');
  assert.equal(hydrated.roiPct, null);
  assert.equal(hydrated.totalPnl, 0);
  assert.equal(hydrated.activePositions, 0);
});

test('buildWalletPositionsResponse trusts successful empty authoritative responses', () => {
  const response = buildWalletPositionsResponse('0x123400000000000000000000000000000000abcd', [], true);

  assert.equal(response.source, 'verified');
  assert.deepEqual(response.positions, []);
});

test('buildWalletPositionsResponse filters out redeemable verified rows', () => {
  const response = buildWalletPositionsResponse('0x123400000000000000000000000000000000abcd', [
    {
      conditionId: 'resolved-market',
      assetId: 'asset-win',
      shares: 100,
      dataSource: 'verified',
      positionStatus: 'redeemable',
    },
    {
      conditionId: 'open-market',
      assetId: 'asset-live',
      shares: 25,
      dataSource: 'verified',
      positionStatus: 'open',
    },
  ], 'verified');

  assert.equal(response.source, 'verified');
  assert.equal(response.positions.length, 1);
  assert.equal(response.positions[0]?.conditionId, 'open-market');
});

test('buildWalletPositionsResponse marks cached fallback rows distinctly from live verified data', () => {
  const response = buildWalletPositionsResponse('0x123400000000000000000000000000000000abcd', [
    {
      conditionId: 'cached-market',
      assetId: 'asset-cached',
      shares: 12,
      dataSource: 'verified',
    },
  ], 'cached');

  assert.equal(response.source, 'cached');
  assert.equal(response.positions[0]?.dataSource, 'cached');
});

test('applyDiscoveryWalletScore recalculates wallet score from current wallet performance', () => {
  const wallet = applyDiscoveryWalletScore({
    address: '0x123400000000000000000000000000000000abcd',
    whaleScore: 12,
    volume7d: 25000,
    volumePrev7d: 12000,
    tradeCount7d: 18,
    avgTradeSize: 1400,
    uniqueMarkets7d: 6,
    roiPct: 24,
    totalPnl: 2600,
    activePositions: 4,
  }, 30000);

  assert.ok(wallet.whaleScore > 12);
});

test('sortWalletsForResponse reorders hydrated wallets by the latest score', () => {
  const sorted = sortWalletsForResponse([
    { address: '0x1', whaleScore: 40, roiPct: 5, lastActive: 1 },
    { address: '0x2', whaleScore: 82, roiPct: 2, lastActive: 2 },
  ] as any, 'score');

  assert.equal(sorted[0]?.address, '0x2');
  assert.equal(sorted[1]?.address, '0x1');
});

test('buildDiscoveryWalletExplanation summarizes category focus and strongest evidence', () => {
  const explanation = buildDiscoveryWalletExplanation({
    focusCategory: 'macro',
    highInformationVolume7d: 18000,
    volume7d: 20000,
    volumePrev7d: 15000,
    tradeCount7d: 9,
    lastSignalType: 'CONVICTION_BUILD',
  });

  assert.match(explanation, /Macro/i);
  assert.match(explanation, /high-information/i);
  assert.match(explanation, /conviction build/i);
});

test('shouldIncludeDiscoveryWallet hides low-evidence wallets from the default feed', () => {
  assert.equal(shouldIncludeDiscoveryWallet({
    whaleScore: 6,
    volume7d: 120,
    tradeCount7d: 1,
    lastSignalAt: undefined,
  }), false);

  assert.equal(shouldIncludeDiscoveryWallet({
    whaleScore: 28,
    volume7d: 120,
    tradeCount7d: 1,
    lastSignalAt: undefined,
  }), true);

  assert.equal(shouldIncludeDiscoveryWallet({
    whaleScore: 6,
    volume7d: 120,
    tradeCount7d: 1,
    lastSignalAt: Date.now(),
  }), true);
});

test('matchesDiscoveryFocusFilter narrows to high-information wallets when requested', () => {
  assert.equal(matchesDiscoveryFocusFilter({
    highInformationVolume7d: 9000,
    volume7d: 10000,
    focusCategory: 'macro',
  }, 'high-information'), true);

  assert.equal(matchesDiscoveryFocusFilter({
    highInformationVolume7d: 1000,
    volume7d: 10000,
    focusCategory: 'entertainment',
  }, 'high-information'), false);

  assert.equal(matchesDiscoveryFocusFilter({
    highInformationVolume7d: 1000,
    volume7d: 10000,
    focusCategory: 'entertainment',
  }, 'all-real-world'), true);
});

test('buildDiscoveryOverview summarizes surfaced wallet quality and category mix', () => {
  const now = Date.now();
  const overview = buildDiscoveryOverview(
    [
      {
        address: '0x1',
        whaleScore: 32,
        volume7d: 12000,
        tradeCount7d: 7,
        lastActive: now,
        lastSignalAt: now,
        isTracked: true,
        focusCategory: 'macro',
      },
      {
        address: '0x2',
        whaleScore: 24,
        volume7d: 5000,
        tradeCount7d: 6,
        lastActive: now,
        focusCategory: 'entertainment',
      },
      {
        address: '0x3',
        whaleScore: 5,
        volume7d: 100,
        tradeCount7d: 1,
        lastActive: now,
        focusCategory: 'event',
      },
    ] as any,
    [
      { severity: 'high', marketTitle: 'Will the Fed cut rates in June?', detectedAt: now, signalType: 'CONVICTION_BUILD', address: '0x1' },
      { severity: 'critical', marketTitle: 'Will the Fed cut rates in June?', detectedAt: now, signalType: 'VOLUME_SPIKE', address: '0x1' },
      { severity: 'medium', marketTitle: 'Will Taylor Swift announce Reputation TV in 2026?', detectedAt: now, signalType: 'NEW_WHALE', address: '0x2' },
    ] as any,
    7,
  );

  assert.equal(overview.quality.walletsSurfacedToday, 2);
  assert.equal(overview.quality.highInformationWalletPct, 50);
  assert.equal(overview.quality.walletsWithTwoStrongSignals, 1);
  assert.equal(overview.quality.trackedWallets, 1);
  assert.equal(overview.surfacedByCategory[0]?.category, 'macro');
});

test('paginateDiscoveryWalletsForPresentation paginates after filtering hidden wallets', () => {
  const wallets = [
    { address: '0xhidden', whaleScore: 4, volume7d: 100, tradeCount7d: 1, focusCategory: 'event' },
    { address: '0xmacro', whaleScore: 28, volume7d: 5000, tradeCount7d: 6, focusCategory: 'macro' },
    { address: '0xpolitics', whaleScore: 26, volume7d: 4800, tradeCount7d: 5, focusCategory: 'politics' },
  ] as any;

  const firstPage = paginateDiscoveryWalletsForPresentation(wallets, {
    focus: 'all-real-world',
    includeAll: false,
    limit: 1,
    offset: 0,
  });
  const secondPage = paginateDiscoveryWalletsForPresentation(wallets, {
    focus: 'all-real-world',
    includeAll: false,
    limit: 1,
    offset: 1,
  });

  assert.equal(firstPage[0]?.address, '0xmacro');
  assert.equal(secondPage[0]?.address, '0xpolitics');
});

test('buildMarketTradesRequestParams disables takerOnly default for market polling', () => {
  const params = buildMarketTradesRequestParams('0xmarket');

  assert.equal(params.market, '0xmarket');
  assert.equal(params.takerOnly, false);
});

test('canStartPollCycle blocks overlapping poll runs', () => {
  assert.equal(canStartPollCycle(true, 10, false), true);
  assert.equal(canStartPollCycle(true, 10, true), false);
  assert.equal(canStartPollCycle(false, 10, false), false);
  assert.equal(canStartPollCycle(true, 0, false), false);
});

test('computeDiscoveryWalletScore rewards sustained volume, not just a one-week burst', () => {
  const sustainedSharp = computeDiscoveryWalletScore({
    volume7d: 30000,
    volumePrev7d: 20000,
    tradeCount7d: 24,
    avgTradeSize: 1250,
    uniqueMarkets7d: 8,
    roiPct: 28,
    totalPnl: 4200,
    activePositions: 6,
  }, 50000);

  const oneWeekBurst = computeDiscoveryWalletScore({
    volume7d: 30000,
    volumePrev7d: 0,
    tradeCount7d: 24,
    avgTradeSize: 1250,
    uniqueMarkets7d: 8,
    roiPct: 28,
    totalPnl: 4200,
    activePositions: 6,
  }, 50000);

  assert.ok(sustainedSharp > oneWeekBurst);
});

test('computeDiscoveryWalletScore gives no ROI credit when roi is unknown', () => {
  const unknownRoi = computeDiscoveryWalletScore({
    volume7d: 15000,
    volumePrev7d: 12000,
    tradeCount7d: 12,
    avgTradeSize: 1000,
    uniqueMarkets7d: 4,
    roiPct: null,
    totalPnl: 600,
    activePositions: 2,
  }, 50000);

  const zeroRoi = computeDiscoveryWalletScore({
    volume7d: 15000,
    volumePrev7d: 12000,
    tradeCount7d: 12,
    avgTradeSize: 1000,
    uniqueMarkets7d: 4,
    roiPct: 0,
    totalPnl: 600,
    activePositions: 2,
  }, 50000);

  assert.ok(unknownRoi < zeroRoi);
});

test('computeDiscoveryWalletScore favors higher-information real-world activity over entertainment-heavy flow', () => {
  const highInformation = computeDiscoveryWalletScore({
    volume7d: 15000,
    volumePrev7d: 12000,
    tradeCount7d: 12,
    avgTradeSize: 1000,
    uniqueMarkets7d: 4,
    roiPct: 12,
    totalPnl: 1500,
    activePositions: 2,
    highInformationVolume7d: 12000,
  }, 50000);

  const entertainmentHeavy = computeDiscoveryWalletScore({
    volume7d: 15000,
    volumePrev7d: 12000,
    tradeCount7d: 12,
    avgTradeSize: 1000,
    uniqueMarkets7d: 4,
    roiPct: 12,
    totalPnl: 1500,
    activePositions: 2,
    highInformationVolume7d: 2000,
  }, 50000);

  assert.ok(highInformation > entertainmentHeavy);
});

test('buildSignalEvaluationTrades keeps signal checks on the observed wallet side only', () => {
  const evaluations = buildSignalEvaluationTrades({
    txHash: '0xtx',
    eventKey: '0xtx:event',
    maker: '0xmaker000000000000000000000000000000000001',
    taker: '0xtaker000000000000000000000000000000000001',
    assetId: 'asset-1',
    conditionId: 'condition-1',
    marketTitle: 'Will BTC hit $150k?',
    side: 'BUY',
    size: 100,
    price: 0.6,
    source: 'api',
    detectedAt: Date.now(),
  } as any);

  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0]?.maker, '0xmaker000000000000000000000000000000000001');
});

test('buildPositionTrackingTrades only tracks positions for the observed wallet side', () => {
  const trackedTrades = buildPositionTrackingTrades({
    txHash: '0xtx',
    eventKey: '0xtx:event',
    maker: '0xmaker000000000000000000000000000000000001',
    taker: '0xtaker000000000000000000000000000000000001',
    assetId: 'asset-1',
    conditionId: 'condition-1',
    marketTitle: 'Will BTC hit $150k?',
    side: 'BUY',
    size: 100,
    price: 0.6,
    source: 'api',
    detectedAt: Date.now(),
  } as any);

  assert.equal(trackedTrades.length, 1);
  assert.equal(trackedTrades[0]?.maker, '0xmaker000000000000000000000000000000000001');
  assert.equal(trackedTrades[0]?.side, 'BUY');
});

test('buildBackfillPositionTrades matches live observed-side position tracking', () => {
  const trackedTrades = buildBackfillPositionTrades({
    maker: '0xmaker000000000000000000000000000000000001',
    taker: '0xtaker000000000000000000000000000000000001',
    condition_id: 'condition-1',
    asset_id: 'asset-1',
    side: 'BUY',
    size: 100,
    price: 0.6,
    outcome: 'Yes',
    market_title: 'Will BTC hit $150k?',
    market_slug: 'will-btc-hit-150k',
  } as any);

  assert.equal(trackedTrades.length, 1);
  assert.equal(trackedTrades[0]?.address, '0xmaker000000000000000000000000000000000001');
  assert.equal(trackedTrades[0]?.side, 'BUY');
});

test('shouldFlagDormantActivation respects the configured dormancy window', () => {
  const nowMs = Date.now();

  assert.equal(shouldFlagDormantActivation({
    volume7d: 8000,
    volumePrev7d: 0,
    lastActive: nowMs - 60 * 60 * 1000,
    firstSeen: nowMs - 30 * 86400 * 1000,
    priorActiveAt: nowMs - 20 * 86400 * 1000,
  } as any, nowMs, 14, 5000), true);

  assert.equal(shouldFlagDormantActivation({
    volume7d: 8000,
    volumePrev7d: 0,
    lastActive: nowMs - 60 * 60 * 1000,
    firstSeen: nowMs - 30 * 86400 * 1000,
    priorActiveAt: nowMs - 2 * 86400 * 1000,
  } as any, nowMs, 14, 5000), false);
});

test('shouldFlagNewWhale requires the wallet to be newly seen, not just recently active', () => {
  const nowMs = Date.now();

  assert.equal(shouldFlagNewWhale({
    firstSeen: nowMs - 30 * 86400 * 1000,
    tradeCount7d: 2,
  } as any, nowMs, 5000, 10000), false);

  assert.equal(shouldFlagNewWhale({
    firstSeen: nowMs - 2 * 86400 * 1000,
    tradeCount7d: 2,
  } as any, nowMs, 5000, 10000), true);
});

test('findCoordinatedEntryCandidates uses a rolling window across bucket boundaries', () => {
  const windowMs = 30 * 60 * 1000;
  const nowMs = Math.floor(Date.now() / windowMs) * windowMs - 5 * 60 * 1000;
  const candidates = findCoordinatedEntryCandidates([
    {
      conditionId: 'condition-1',
      assetId: 'asset-1',
      marketTitle: 'Test market',
      maker: '0x1',
      detectedAt: nowMs,
      notionalUsd: 20000,
      whaleScore: 70,
    },
    {
      conditionId: 'condition-1',
      assetId: 'asset-1',
      marketTitle: 'Test market',
      maker: '0x2',
      detectedAt: nowMs + 10 * 60 * 1000,
      notionalUsd: 20000,
      whaleScore: 72,
    },
    {
      conditionId: 'condition-1',
      assetId: 'asset-1',
      marketTitle: 'Test market',
      maker: '0x3',
      detectedAt: nowMs + 20 * 60 * 1000,
      notionalUsd: 20000,
      whaleScore: 75,
    },
  ] as any, {
    coordinatedWindowMinutes: 30,
    coordinatedMinWallets: 3,
    coordinatedMinVolume: 50000,
    coordinatedMinAvgScore: 55,
  } as any);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.wallet_count, 3);
  assert.equal(candidates[0]?.condition_id, 'condition-1');
});
