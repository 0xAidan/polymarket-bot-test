/**
 * Discovery API Routes
 *
 * REST endpoints for the discovery engine. Provides wallet listings,
 * runtime config management, engine restart, status, and data purge.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { initDatabase } from '../database.js';
import { Storage } from '../storage.js';
import { DiscoveryConfig, DiscoveryMarketCategory, DiscoveryStrategyClass } from '../discovery/types.js';
import {
  fetchAuthoritativePositions,
  summarizeAuthoritativePositions,
  buildPositionVerificationSummary,
  filterLiveWalletPositions,
  mapOfficialPositionToWalletPosition,
} from '../discovery/positionTracker.js';
import {
  markWalletTracked,
  dismissSignal,
  getPositionsByAddress,
} from '../discovery/statsStore.js';
import { classifyDiscoveryMarket } from '../discovery/marketClassifier.js';
import { getWalletReasons } from '../discovery/discoveryScorer.js';
import { getWalletValidation } from '../discovery/walletValidator.js';
import { getValidEvmAddress } from '../addressUtils.js';
import { dismissDiscoveryAlertV2, getDiscoveryAlertsV2 } from '../discovery/v2DataStore.js';
import {
  buildDiscoveryMethodologyPayload,
  getDiscoveryWatchlistEntry,
  listDiscoveryWatchlistEntries,
  removeDiscoveryWatchlistEntry,
  upsertDiscoveryWatchlistEntry,
} from '../discovery/productSurfaceStore.js';
import {
  evaluateAndPersistAllocationPolicies,
  getAllocationPolicyConfig,
  getAllocationPolicyState,
  getAllocationPolicyStates,
  getAllocationPolicyTransitions,
  updateAllocationPolicyConfig,
} from '../allocation/policyEngine.js';

/**
 * Mask an Alchemy WebSocket URL for safe display.
 * Shows `wss://polygon-mainnet.g.alchemy.com/v2/****abcd`
 */
const maskAlchemyUrl = (url: string): string => {
  if (!url) return '';
  const parts = url.split('/');
  const key = parts[parts.length - 1];
  if (key.length > 4) {
    parts[parts.length - 1] = '****' + key.slice(-4);
  }
  return parts.join('/');
};

const normalizeAlchemyWsUrl = (raw: string): string => {
  const value = (raw || '').trim();
  if (!value) return '';
  if (value.startsWith('ws://') || value.startsWith('wss://')) return value;
  return `wss://polygon-mainnet.g.alchemy.com/v2/${value}`;
};

const normalizeStrategyClass = (value: unknown): DiscoveryStrategyClass => {
  const normalized = String(value || 'unknown').toLowerCase();
  const allowed: DiscoveryStrategyClass[] = [
    'informational_directional',
    'structural_arbitrage',
    'market_maker',
    'reactive_momentum',
    'suspicious',
    'unknown',
  ];
  return allowed.includes(normalized as DiscoveryStrategyClass)
    ? (normalized as DiscoveryStrategyClass)
    : 'unknown';
};

export const applyAuthoritativeWalletSummary = <T extends { roiPct?: number | null; totalPnl?: number; activePositions?: number }>(
  wallet: T,
  positions: Array<unknown>
): T & { positionDataSource: 'verified' } => {
  if (positions.length === 0) {
    return {
      ...wallet,
      roiPct: null,
      totalPnl: 0,
      activePositions: 0,
      positionDataSource: 'verified',
    };
  }

  const summary = summarizeAuthoritativePositions(positions as any);
  return {
    ...wallet,
    roiPct: summary.roiPct,
    totalPnl: summary.totalPnl,
    activePositions: summary.activePositions,
    positionDataSource: 'verified',
  };
};

type WalletPositionsSource = 'verified' | 'cached' | 'derived';

const normalizeWalletPositionsSource = (source: WalletPositionsSource | boolean): WalletPositionsSource => {
  if (typeof source === 'boolean') {
    return source ? 'verified' : 'derived';
  }
  return source;
};

const normalizeWalletDetailProfile = (
  address: string,
  rawProfile?: Record<string, unknown>
): { profileAddress?: string; profileUrl?: string } => {
  const routeAddress = getValidEvmAddress(address);
  const profileFromApi = getValidEvmAddress(
    rawProfile?.address ??
    rawProfile?.walletAddress ??
    rawProfile?.publicAddress ??
    rawProfile?.proxyWallet
  );

  if (profileFromApi && profileFromApi === String(address).toLowerCase()) {
    return {
      profileAddress: profileFromApi,
      profileUrl: `https://polymarket.com/profile/${profileFromApi}`,
    };
  }

  if (routeAddress) {
    return {
      profileAddress: routeAddress,
      profileUrl: `https://polymarket.com/profile/${routeAddress}`,
    };
  }

  return {};
};

export const buildWalletPositionsResponse = (
  address: string,
  positions: any[],
  sourceInput: WalletPositionsSource | boolean,
  metadata: { profileAddress?: string; profileUrl?: string } = {},
) => {
  const source = normalizeWalletPositionsSource(sourceInput);
  const normalizedPositions = positions.map((position) => {
    if (source === 'cached') {
      return {
        ...position,
        dataSource: 'cached' as const,
      };
    }

    if (source === 'verified') {
      return {
        ...position,
        dataSource: 'verified' as const,
      };
    }

    return {
      ...position,
      dataSource: position.dataSource ?? 'derived',
    };
  });

  const visiblePositions = source === 'derived'
    ? normalizedPositions
    : filterLiveWalletPositions(normalizedPositions);

  return {
    success: true,
    address,
    positions: visiblePositions,
    source,
    ...metadata,
  };
};

export const applyDiscoveryWalletScore = <T extends {
  whaleScore?: number;
  discoveryScore?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  avgTradeSize?: number;
  uniqueMarkets7d?: number;
  roiPct?: number | null;
  totalPnl?: number;
  activePositions?: number;
}>(
  wallet: T,
  _maxVolume: number,
): T & { whaleScore: number } => ({
  ...wallet,
  whaleScore: Number(wallet.discoveryScore ?? wallet.whaleScore ?? 0),
});

export const sortWalletsForResponse = <T extends {
  whaleScore?: number;
  discoveryScore?: number;
  trustScore?: number;
  copyabilityScore?: number;
  roiPct?: number | null;
  lastActive?: number;
  tradeCount7d?: number;
  volume7d?: number;
}>(
  wallets: T[],
  sort: 'volume' | 'trades' | 'recent' | 'score' | 'roi' | 'trust',
): T[] => {
  const sorted = [...wallets];
  sorted.sort((a, b) => {
    if (sort === 'trust') {
      return (
        (Number(b.trustScore) || 0) - (Number(a.trustScore) || 0) ||
        (Number(b.copyabilityScore) || 0) - (Number(a.copyabilityScore) || 0) ||
        (Number(b.discoveryScore ?? b.whaleScore) || 0) - (Number(a.discoveryScore ?? a.whaleScore) || 0)
      );
    }
    if (sort === 'score') return (Number(b.discoveryScore ?? b.whaleScore) || 0) - (Number(a.discoveryScore ?? a.whaleScore) || 0);
    if (sort === 'roi') return (b.roiPct ?? Number.NEGATIVE_INFINITY) - (a.roiPct ?? Number.NEGATIVE_INFINITY);
    if (sort === 'recent') return (b.lastActive || 0) - (a.lastActive || 0);
    if (sort === 'trades') return (b.tradeCount7d || 0) - (a.tradeCount7d || 0);
    return (b.volume7d || 0) - (a.volume7d || 0);
  });
  return sorted;
};

const DISCOVERY_CATEGORY_LABELS: Record<string, string> = {
  politics: 'Politics',
  macro: 'Macro',
  company: 'Company',
  legal: 'Legal',
  geopolitics: 'Geopolitics',
  entertainment: 'Entertainment',
  sports: 'Sports',
  crypto: 'Crypto',
  event: 'Real-world',
  other: 'Other',
};
const DISCOVERY_CATEGORY_PRIORITY: Record<string, number> = {
  sports: 0,
  politics: 1,
  macro: 2,
  company: 3,
  legal: 4,
  geopolitics: 5,
  event: 6,
  entertainment: 7,
  other: 8,
  crypto: 9,
};

export const buildDiscoveryWalletExplanation = <T extends {
  primaryReason?: string;
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  lastSignalType?: string;
}>(
  wallet: T,
): string => {
  if (wallet.primaryReason) {
    return wallet.primaryReason;
  }
  const focusLabel = DISCOVERY_CATEGORY_LABELS[wallet.focusCategory || 'event'] || 'Real-world';
  const parts: string[] = [`${focusLabel} focus`];
  const highInformationShare = Number(wallet.volume7d || 0) > 0
    ? Number(wallet.highInformationVolume7d || 0) / Number(wallet.volume7d || 0)
    : 0;

  if (highInformationShare >= 0.6) {
    parts.push('high-information flow');
  }
  if (Math.min(Number(wallet.volume7d || 0), Number(wallet.volumePrev7d || 0)) >= 5000) {
    parts.push('sustained weekly volume');
  }
  if (Number(wallet.tradeCount7d || 0) >= 8) {
    parts.push('repeated participation');
  }
  if (wallet.lastSignalType) {
    parts.push((wallet.lastSignalType || '').replace(/_/g, ' ').toLowerCase());
  }

  return parts.join(' + ');
};

export const buildDiscoveryReasonRowsFromWallet = (wallet: {
  address?: string;
  reasonDetails?: Array<{ reasonType?: string; reasonCode?: string; message?: string; createdAt?: number }>;
  supportingReasons?: string[];
  supportingReasonChips?: string[];
  cautionFlags?: string[];
  warningReasons?: string[];
  reasonCodes?: string[];
  updatedAt?: number;
}) => {
  if (Array.isArray(wallet.reasonDetails) && wallet.reasonDetails.length > 0) {
    return wallet.reasonDetails.map((reason, index) => ({
      address: String(wallet.address || '').toLowerCase(),
      reasonType: String(reason.reasonType || 'warning') as 'supporting' | 'warning' | 'rejection',
      reasonCode: String(reason.reasonCode || `reason_${index + 1}`),
      message: String(reason.message || '').trim(),
      createdAt: Number(reason.createdAt || wallet.updatedAt || Date.now()),
    })).filter((reason) => reason.message);
  }

  const address = String(wallet.address || '').toLowerCase();
  const updatedAt = Number(wallet.updatedAt || Date.now());
  const supportingReasons = Array.isArray(wallet.supportingReasons) && wallet.supportingReasons.length > 0
    ? wallet.supportingReasons
    : Array.isArray(wallet.supportingReasonChips)
      ? wallet.supportingReasonChips
      : [];
  const cautionFlags = Array.isArray(wallet.cautionFlags) && wallet.cautionFlags.length > 0
    ? wallet.cautionFlags
    : Array.isArray(wallet.warningReasons)
      ? wallet.warningReasons
      : [];
  const reasonCodes = Array.isArray(wallet.reasonCodes) ? wallet.reasonCodes : [];

  const supportingRows = supportingReasons.map((reason, index) => ({
    address,
    reasonType: 'supporting' as const,
    reasonCode: String(reasonCodes[index] || `supporting_reason_${index + 1}`),
    message: String(reason || '').trim(),
    createdAt: updatedAt,
  })).filter((reason) => reason.message);

  const warningRows = cautionFlags.map((flag, index) => ({
    address,
    reasonType: 'warning' as const,
    reasonCode: `caution_flag_${index + 1}`,
    message: String(flag || '').trim(),
    createdAt: updatedAt,
  })).filter((reason) => reason.message);

  return [...supportingRows, ...warningRows];
};

export const buildDiscoverySignalRowsFromWallets = (wallets: Array<{
  address?: string;
  focusCategory?: string;
  reasonDetails?: Array<{ reasonType?: string; reasonCode?: string; message?: string; createdAt?: number; marketTitle?: string }>;
  supportingMarkets?: string[];
  supportingReasons?: string[];
  supportingReasonChips?: string[];
  cautionFlags?: string[];
  warningReasons?: string[];
  reasonCodes?: string[];
  updatedAt?: number;
}>) => wallets.flatMap((wallet) => {
  const walletCategory = typeof wallet.focusCategory === 'string' && wallet.focusCategory
    ? (wallet.focusCategory.toLowerCase() as DiscoveryMarketCategory)
    : undefined;
  if (Array.isArray(wallet.reasonDetails) && wallet.reasonDetails.length > 0) {
    return wallet.reasonDetails.map((reason, index) => ({
      id: `${String(wallet.address || '').toLowerCase()}:reason:${index}`,
      signalType: String(reason.reasonCode || 'DISCOVERY_REASON').toUpperCase(),
      severity: reason.reasonType === 'rejection' ? 'high' : reason.reasonType === 'warning' ? 'medium' : 'low',
      address: String(wallet.address || '').toLowerCase(),
      title: String(reason.reasonCode || 'DISCOVERY_REASON').toUpperCase(),
      description: String(reason.message || '').trim(),
      detectedAt: Number(reason.createdAt || wallet.updatedAt || Date.now()),
      canDismiss: false,
      marketTitle: reason.marketTitle || wallet.supportingMarkets?.[0],
      category: walletCategory,
    })).filter((signal) => signal.description);
  }

  const supportingReasons = Array.isArray(wallet.supportingReasons) && wallet.supportingReasons.length > 0
    ? wallet.supportingReasons
    : Array.isArray(wallet.supportingReasonChips)
      ? wallet.supportingReasonChips
      : [];
  const cautionFlags = Array.isArray(wallet.cautionFlags) && wallet.cautionFlags.length > 0
    ? wallet.cautionFlags
    : Array.isArray(wallet.warningReasons)
      ? wallet.warningReasons
      : [];
  const marketTitle = wallet.supportingMarkets?.[0];
  const updatedAt = Number(wallet.updatedAt || Date.now());

  const supportingRows = supportingReasons.map((reason, index) => ({
    id: `${String(wallet.address || '').toLowerCase()}:supporting:${index}`,
    signalType: String(wallet.reasonCodes?.[index] || 'DISCOVERY_SUPPORTING_REASON').toUpperCase(),
    severity: 'low',
    address: String(wallet.address || '').toLowerCase(),
    title: String(wallet.reasonCodes?.[index] || 'DISCOVERY_SUPPORTING_REASON').toUpperCase(),
    description: String(reason || '').trim(),
    detectedAt: updatedAt,
    canDismiss: false,
    marketTitle,
    category: walletCategory,
  })).filter((signal) => signal.description);

  const cautionRows = cautionFlags.map((flag, index) => ({
    id: `${String(wallet.address || '').toLowerCase()}:warning:${index}`,
    signalType: 'DISCOVERY_CAUTION',
    severity: 'medium',
    address: String(wallet.address || '').toLowerCase(),
    title: 'DISCOVERY_CAUTION',
    description: String(flag || '').trim(),
    detectedAt: updatedAt,
    canDismiss: false,
    marketTitle,
    category: walletCategory,
  })).filter((signal) => signal.description);

  return [...supportingRows, ...cautionRows];
}).sort((a, b) => Number(b.detectedAt || 0) - Number(a.detectedAt || 0));

export const buildAllocationPolicyInputFromWallet = (wallet: Record<string, unknown>) => {
  const separateScores = wallet.separateScores && typeof wallet.separateScores === 'object'
    ? (wallet.separateScores as Record<string, unknown>)
    : {};

  return {
    address: String(wallet.address || '').toLowerCase(),
    discoveryScore: Number(wallet.discoveryScore ?? wallet.whaleScore ?? 0),
    trustScore: Number(wallet.trustScore ?? separateScores.trust ?? 0),
    copyabilityScore: Number(wallet.copyabilityScore ?? separateScores.copyability ?? 0),
    confidenceBucket: (String(wallet.confidence || 'low').toLowerCase() as 'low' | 'medium' | 'high'),
    strategyClass: normalizeStrategyClass(wallet.strategyClass),
    cautionFlags: Array.isArray(wallet.cautionFlags)
      ? wallet.cautionFlags.map((value: unknown) => String(value))
      : [],
    updatedAt: Number(wallet.updatedAt || 0),
  };
};

export const shouldIncludeDiscoveryWallet = <T extends {
  whaleScore?: number;
  discoveryScore?: number;
  surfaceBucket?: string;
  volume7d?: number;
  tradeCount7d?: number;
  lastSignalAt?: number;
}>(
  wallet: T,
): boolean => {
  if ((wallet.surfaceBucket || '').toLowerCase() === 'suppressed') return false;
  if ((wallet.lastSignalAt || 0) > 0) return true;
  if (Number(wallet.discoveryScore ?? wallet.whaleScore) >= 20) return true;
  if (Number(wallet.volume7d || 0) >= 2500) return true;
  return Number(wallet.tradeCount7d || 0) >= 4 && Number(wallet.volume7d || 0) >= 750;
};

export const matchesDiscoveryFocusFilter = <T extends {
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
}>(
  wallet: T,
  focus: 'all-real-world' | 'high-information' | 'sports-first',
): boolean => {
  if (focus === 'sports-first') {
    return wallet.focusCategory === 'sports';
  }
  if (focus !== 'high-information') return true;
  const volume7d = Number(wallet.volume7d || 0);
  const highInformationVolume7d = Number(wallet.highInformationVolume7d || 0);
  if (volume7d <= 0) return false;
  if (['sports', 'politics', 'macro', 'company', 'legal', 'geopolitics'].includes(wallet.focusCategory || '')) return true;
  return highInformationVolume7d / volume7d >= 0.6;
};

const applyDiscoveryPresentationFilters = <T extends {
  discoveryScore?: number;
  whaleScore?: number;
  heatIndicator?: string;
  primaryReason?: string;
  reasonCodes?: string[];
  supportingReasonChips?: string[];
  cautionFlags?: string[];
}>(
  wallets: T[],
  filters?: { minScore?: number; heat?: string; hasSignals?: boolean },
): T[] => {
  return wallets.filter((wallet) => {
    const discoveryScore = Number(wallet.discoveryScore ?? wallet.whaleScore ?? 0);
    if (filters?.minScore !== undefined && discoveryScore < filters.minScore) {
      return false;
    }
    if (filters?.heat && String(wallet.heatIndicator || '').toUpperCase() !== String(filters.heat).toUpperCase()) {
      return false;
    }
    if (filters?.hasSignals) {
      const reasonCodes = Array.isArray(wallet.reasonCodes) ? wallet.reasonCodes : [];
      const supportingReasonChips = Array.isArray(wallet.supportingReasonChips) ? wallet.supportingReasonChips : [];
      const cautionFlags = Array.isArray(wallet.cautionFlags) ? wallet.cautionFlags : [];
      if (reasonCodes.length === 0 && supportingReasonChips.length === 0 && cautionFlags.length === 0) {
        return false;
      }
    }
    return true;
  });
};

const annotateDiscoveryWallet = <T extends {
  whySurfaced?: string;
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  lastSignalType?: string;
}>(
  wallet: T,
): T & { whySurfaced: string } => ({
  ...wallet,
  whySurfaced: wallet.whySurfaced || buildDiscoveryWalletExplanation(wallet),
});

const filterDiscoveryWalletsForPresentation = <T extends {
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  lastSignalType?: string;
  whaleScore?: number;
  lastSignalAt?: number;
}>(
  wallets: T[],
  focus: 'all-real-world' | 'high-information' | 'sports-first',
  includeAll: boolean,
): Array<T & { whySurfaced: string }> => {
  return wallets
    .map(annotateDiscoveryWallet)
    .filter((wallet) => matchesDiscoveryFocusFilter(wallet, focus))
    .filter((wallet) => includeAll || shouldIncludeDiscoveryWallet(wallet));
};

export const paginateDiscoveryWalletsForPresentation = <T extends {
  focusCategory?: DiscoveryMarketCategory;
  highInformationVolume7d?: number;
  volume7d?: number;
  volumePrev7d?: number;
  tradeCount7d?: number;
  lastSignalType?: string;
  whaleScore?: number;
  lastSignalAt?: number;
}>(
  wallets: T[],
  options: {
    focus: 'all-real-world' | 'high-information' | 'sports-first';
    includeAll: boolean;
    limit: number;
    offset: number;
  },
): Array<T & { whySurfaced: string }> => {
  return filterDiscoveryWalletsForPresentation(wallets, options.focus, options.includeAll)
    .slice(options.offset, options.offset + options.limit);
};

export const buildDiscoveryOverview = (
  wallets: Array<{
    address: string;
    whaleScore?: number;
    volume7d?: number;
    tradeCount7d?: number;
    lastSignalAt?: number;
    lastActive?: number;
    isTracked?: boolean;
    focusCategory?: DiscoveryMarketCategory;
  }>,
  signals: Array<{
    address: string;
    severity?: string;
    marketTitle?: string;
    detectedAt?: number;
    category?: DiscoveryMarketCategory;
  }>,
  days: number,
) => {
  const normalizeTimestamp = (value?: number): number => {
    const timestamp = Number(value || 0);
    if (!timestamp) return 0;
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  };
  const surfacedWallets = wallets.filter(shouldIncludeDiscoveryWallet);
  const surfacedCutoff = Date.now() - 24 * 3600 * 1000;
  const signalCutoff = Date.now() - days * 86400 * 1000;
  const highInformationCategories = new Set(['sports', 'politics', 'macro', 'company', 'legal', 'geopolitics']);
  const surfacedToday = surfacedWallets.filter((wallet) => normalizeTimestamp(wallet.lastActive) >= surfacedCutoff);
  const highInformationWallets = surfacedWallets.filter((wallet) => highInformationCategories.has(wallet.focusCategory || ''));
  const strongSignalCounts = new Map<string, number>();

  for (const signal of signals) {
    if (Number(signal.detectedAt || 0) < signalCutoff) continue;
    if (signal.severity !== 'high' && signal.severity !== 'critical') continue;
    strongSignalCounts.set(signal.address, (strongSignalCounts.get(signal.address) ?? 0) + 1);
  }

  const surfacedByCategory = [...surfacedWallets.reduce((acc, wallet) => {
    const category = wallet.focusCategory || 'event';
    acc.set(category, (acc.get(category) ?? 0) + 1);
    return acc;
  }, new Map<string, number>()).entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (DISCOVERY_CATEGORY_PRIORITY[a.category] ?? 99) - (DISCOVERY_CATEGORY_PRIORITY[b.category] ?? 99));

  const signalCountsByCategory = [...signals.reduce((acc, signal) => {
    if (Number(signal.detectedAt || 0) < signalCutoff) return acc;
    const category =
      signal.category
      ?? classifyDiscoveryMarket({ title: signal.marketTitle }).category
      ?? 'event';
    acc.set(category, (acc.get(category) ?? 0) + 1);
    return acc;
  }, new Map<string, number>()).entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (DISCOVERY_CATEGORY_PRIORITY[a.category] ?? 99) - (DISCOVERY_CATEGORY_PRIORITY[b.category] ?? 99));

  const topWalletsByDay = [...surfacedWallets.reduce((acc, wallet) => {
    const bucket = new Date(normalizeTimestamp(wallet.lastActive)).toISOString().slice(0, 10);
    const list = acc.get(bucket) ?? [];
    list.push({
      address: wallet.address,
      whaleScore: wallet.whaleScore || 0,
      focusCategory: wallet.focusCategory || 'event',
    });
    acc.set(bucket, list);
    return acc;
  }, new Map<string, Array<{ address: string; whaleScore: number; focusCategory: string }>>()).entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, days)
    .map(([day, dailyWallets]) => ({
      day,
      wallets: dailyWallets.sort((a, b) => b.whaleScore - a.whaleScore).slice(0, 5),
    }));

  return {
    quality: {
      walletsSurfacedToday: surfacedToday.length,
      highInformationWalletPct: surfacedWallets.length === 0
        ? 0
        : Math.round((highInformationWallets.length / surfacedWallets.length) * 100),
      walletsWithTwoStrongSignals: [...strongSignalCounts.values()].filter((count) => count >= 2).length,
      trackedWallets: surfacedWallets.filter((wallet) => wallet.isTracked).length,
    },
    surfacedByCategory,
    signalCountsByCategory,
    topWalletsByDay,
  };
};

export const buildDiscoveryHomePayload = (
  manager: Pick<DiscoveryRoutesController, 'getStatus' | 'getWallets'>,
  options: {
    sort: 'volume' | 'trades' | 'recent' | 'score' | 'roi' | 'trust';
    limit: number;
    offset: number;
    focus: 'all-real-world' | 'high-information' | 'sports-first';
    includeAll: boolean;
    days: number;
    filters?: { minScore?: number; heat?: string; hasSignals?: boolean };
  },
) => {
  const normalizeTimestamp = (value?: number): number => {
    const timestamp = Number(value || 0);
    if (!timestamp) return 0;
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  };
  const walletMarketTitleByAddress = new Map<string, string>();

  const rawBatchSize = Math.min(Math.max(options.limit * 3, 50), 200);
  let rawOffset = 0;
  let filteredWallets: Array<any> = [];
  let globalWallets: Array<any> = [];

  while (true) {
    const batch = manager.getWallets(options.sort, rawBatchSize, rawOffset) as any[];
    if (batch.length === 0) break;
    const filteredBatch = applyDiscoveryPresentationFilters(
      filterDiscoveryWalletsForPresentation(batch, options.focus, options.includeAll),
      options.filters,
    );
    filteredWallets = filteredWallets.concat(filteredBatch);
    for (const wallet of filteredBatch) {
      if (Array.isArray(wallet.supportingMarkets) && wallet.supportingMarkets[0]) {
        walletMarketTitleByAddress.set(String(wallet.address || '').toLowerCase(), String(wallet.supportingMarkets[0]));
      }
    }
    rawOffset += batch.length;
    if (batch.length < rawBatchSize) break;
  }

  rawOffset = 0;
  while (true) {
    const batch = manager.getWallets(options.sort, rawBatchSize, rawOffset) as any[];
    if (batch.length === 0) break;
    const presentationBatch = filterDiscoveryWalletsForPresentation(batch, options.focus, false);
    globalWallets = globalWallets.concat(presentationBatch);
    for (const wallet of presentationBatch) {
      if (Array.isArray(wallet.supportingMarkets) && wallet.supportingMarkets[0]) {
        walletMarketTitleByAddress.set(String(wallet.address || '').toLowerCase(), String(wallet.supportingMarkets[0]));
      }
    }
    rawOffset += batch.length;
    if (batch.length < rawBatchSize) break;
  }

  const wallets = filteredWallets.slice(options.offset, options.offset + options.limit).map((wallet) => ({
    ...wallet,
    positionDataSource: 'derived' as const,
  }));

  let reasonSignals: Array<{
    id: number;
    signalType: string;
    severity: string;
    address: string;
    title: string;
    description: string;
    detectedAt: number;
    canDismiss: boolean;
    marketTitle?: string;
  }> = [];

  reasonSignals = buildDiscoverySignalRowsFromWallets(globalWallets)
    .slice(0, 30)
    .map((signal, index) => ({
      ...signal,
      id: index + 1,
      marketTitle: signal.marketTitle || walletMarketTitleByAddress.get(String(signal.address || '').toLowerCase()),
    }));

  const overviewSignals = buildDiscoverySignalRowsFromWallets(globalWallets).map((signal) => ({
    address: signal.address,
    severity: signal.severity,
    marketTitle: signal.marketTitle,
    detectedAt: signal.detectedAt,
    signalType: signal.signalType,
    description: signal.description,
  }));
  const signals = reasonSignals.slice(0, 10);
  const marketCounts = new Map<string, {
    market_title: string;
    wallets: Set<string>;
    signal_count: number;
    signal_types: Set<string>;
    first_detected: number;
  }>();
  const cutoff = Date.now() - options.days * 86400 * 1000;
  for (const wallet of globalWallets) {
    if (normalizeTimestamp(wallet.updatedAt) < cutoff) continue;
    if (!Array.isArray(wallet.supportingMarkets)) continue;
    for (const marketTitle of wallet.supportingMarkets) {
      const entry = marketCounts.get(marketTitle) ?? {
        market_title: marketTitle,
        wallets: new Set<string>(),
        signal_count: 0,
        signal_types: new Set<string>(),
        first_detected: normalizeTimestamp(wallet.updatedAt),
      };
      entry.wallets.add(String(wallet.address || ''));
      entry.signal_count += 1;
      entry.signal_types.add('DISCOVERY_REASON');
      entry.first_detected = Math.min(entry.first_detected, normalizeTimestamp(wallet.updatedAt));
      marketCounts.set(marketTitle, entry);
    }
  }

  const markets = [...marketCounts.values()]
    .sort((a, b) => b.signal_count - a.signal_count)
    .slice(0, 10)
    .map((entry) => ({
      market_title: entry.market_title,
      signal_count: entry.signal_count,
      wallets: [...entry.wallets].join(','),
      signal_types: [...entry.signal_types].join(','),
      first_detected: entry.first_detected || 0,
    }));

  return {
    success: true,
    apiVersion: 'v2',
    fetchedAt: Date.now(),
    status: manager.getStatus(),
    wallets,
    overview: buildDiscoveryOverview(globalWallets, overviewSignals as any, options.days),
    signals,
    markets,
  };
};

/** Ensure DB is initialized before any discovery route (e.g. when user saves config before copy trader has started). */
const ensureDatabase = async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    await initDatabase();
    next();
  } catch (err: any) {
    next(err);
  }
};

type DiscoveryRoutesController = {
  getConfig(): DiscoveryConfig;
  updateConfig(updates: Partial<DiscoveryConfig>): Promise<DiscoveryConfig>;
  getStatus(): {
    enabled: boolean;
    chainListener: { connected: boolean; lastEventAt?: number; reconnectCount: number };
    apiPoller: { running: boolean; lastPollAt?: number; marketsMonitored: number };
    stats: { totalWallets: number; totalTrades: number; uptimeMs: number };
  };
  getWallets(
    sort: 'volume' | 'trades' | 'recent' | 'score' | 'roi' | 'trust',
    limit: number,
    offset: number,
    filters?: { minScore?: number; heat?: string; hasSignals?: boolean }
  ): unknown[];
  purgeData(olderThanDays: number): number;
  resetData(): {
    trades: number;
    wallets: number;
    positions: number;
    signals: number;
    marketCache: number;
    total: number;
  };
  restart(): Promise<void>;
};

export const createDiscoveryRoutes = (manager: DiscoveryRoutesController): Router => {
  const router = Router();

  router.use(ensureDatabase);

  const getWalletSnapshot = (address: string): Record<string, unknown> | null => {
    const normalized = address.toLowerCase();
    const trustWallets = manager.getWallets('trust', 2000, 0) as Array<Record<string, unknown>>;
    const scoreWallets = manager.getWallets('score', 2000, 0) as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    const mergedWallets = [...trustWallets, ...scoreWallets].filter((wallet) => {
      const key = String(wallet.address || '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return mergedWallets.find((wallet) => String(wallet.address || '').toLowerCase() === normalized) ?? null;
  };

  const serializeWalletProfile = (address: string): Record<string, unknown> | null => {
    const wallet = getWalletSnapshot(address);
    if (!wallet) return null;
    const validation = getWalletValidation(address);
    const reasons = buildDiscoveryReasonRowsFromWallet(wallet);
    const allocationState = getAllocationPolicyState(address);
    const watchlistEntry = getDiscoveryWatchlistEntry(address);
    return {
      wallet,
      validation,
      reasons,
      allocation: allocationState,
      watchlist: watchlistEntry,
    };
  };

  // -----------------------------------------------------------------------
  // GET /wallets — ranked list of discovered wallets (with filters)
  // -----------------------------------------------------------------------
  router.get('/wallets', (req: Request, res: Response) => {
    void (async () => {
      try {
        const sort = (req.query.sort as 'volume' | 'trades' | 'recent' | 'score' | 'roi' | 'trust') || 'trust';
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const hydratePositions = req.query.hydratePositions === 'true';
        const includeAll = req.query.includeAll === 'true';
        const focus = req.query.focus === 'sports-first'
          ? 'sports-first'
          : req.query.focus === 'high-information'
            ? 'high-information'
            : 'all-real-world';
        const filters: { minScore?: number; heat?: string; hasSignals?: boolean } = {};
        if (req.query.minScore !== undefined) filters.minScore = parseFloat(req.query.minScore as string);
        if (req.query.heat) filters.heat = req.query.heat as string;
        if (req.query.hasSignals === 'true') filters.hasSignals = true;

        const rawBatchSize = Math.min(Math.max(limit * 3, 50), 200);
        const requiredCount = offset + limit;
        let rawOffset = 0;
        let filteredWallets: Array<any> = [];

        while (filteredWallets.length < requiredCount) {
          const batch = manager.getWallets(sort, rawBatchSize, rawOffset);
          if (batch.length === 0) break;
          filteredWallets = filteredWallets.concat(
            applyDiscoveryPresentationFilters(
              filterDiscoveryWalletsForPresentation(batch as any[], focus, includeAll),
              filters,
            )
          );
          rawOffset += batch.length;
          if (batch.length < rawBatchSize) break;
        }

        const wallets = filteredWallets.slice(offset, offset + limit);
        if (!hydratePositions || wallets.length === 0) {
          const derivedWallets = wallets.map((wallet) => ({
            ...wallet,
            positionDataSource: 'derived' as const,
          }));
          res.json({
            success: true,
            apiVersion: 'v2',
            wallets: derivedWallets,
            positionsSource: 'derived',
          });
          return;
        }

        const hydratedWallets = await Promise.all(wallets.map(async (wallet) => {
          try {
            return applyAuthoritativeWalletSummary(wallet, await fetchAuthoritativePositions(wallet.address));
          } catch {
            return {
              ...wallet,
              positionDataSource: 'derived',
            };
          }
        }));

        res.json({
          success: true,
          apiVersion: 'v2',
          wallets: hydratedWallets.map(annotateDiscoveryWallet),
          positionsSource: 'verified',
        });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    })();
  });

  router.get('/home', (req: Request, res: Response) => {
    try {
      const sort = (req.query.sort as 'volume' | 'trades' | 'recent' | 'score' | 'roi' | 'trust') || 'trust';
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
      const includeAll = req.query.includeAll === 'true';
      const focus = req.query.focus === 'sports-first'
        ? 'sports-first'
        : req.query.focus === 'high-information'
          ? 'high-information'
          : 'all-real-world';
      const days = Math.min(parseInt(req.query.days as string, 10) || 7, 14);
      const filters: { minScore?: number; heat?: string; hasSignals?: boolean } = {};
      if (req.query.minScore !== undefined) filters.minScore = parseFloat(req.query.minScore as string);
      if (req.query.heat) filters.heat = req.query.heat as string;
      if (req.query.hasSignals === 'true') filters.hasSignals = true;

      res.json(buildDiscoveryHomePayload(manager, {
        sort,
        limit,
        offset,
        focus,
        includeAll,
        days,
        filters,
      }));
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/wallets/:address/profile', (req: Request, res: Response) => {
    try {
      const address = req.params.address.toLowerCase();
      const profile = serializeWalletProfile(address);
      if (!profile) {
        res.status(404).json({ success: false, error: 'Wallet not found in discovery set' });
        return;
      }
      res.json({ success: true, profile });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/wallets/compare', (req: Request, res: Response) => {
    try {
      const addressesInput: unknown[] = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
      const addresses = [...new Set<string>(
        addressesInput
          .map((value: unknown): string => String(value || '').trim().toLowerCase())
          .filter((value: string): value is string => Boolean(value))
      )].slice(0, 4);
      if (addresses.length < 2) {
        res.status(400).json({ success: false, error: 'Provide at least two wallet addresses to compare.' });
        return;
      }
      const profiles = addresses.map((address) => ({
        address,
        profile: serializeWalletProfile(address),
      }));
      res.json({ success: true, profiles });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/watchlist', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 250);
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
      res.json({
        success: true,
        watchlist: listDiscoveryWatchlistEntries(limit, offset),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/watchlist', (req: Request, res: Response) => {
    try {
      const address = String(req.body?.address || '').trim().toLowerCase();
      if (!address) {
        res.status(400).json({ success: false, error: 'address is required' });
        return;
      }
      const note = req.body?.note ? String(req.body.note) : undefined;
      const tags = Array.isArray(req.body?.tags)
        ? req.body.tags.map((value: unknown) => String(value || '').trim()).filter(Boolean)
        : [];
      const entry = upsertDiscoveryWatchlistEntry(address, note, tags);
      res.json({ success: true, watchlistEntry: entry });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/watchlist/:address', (req: Request, res: Response) => {
    try {
      const deleted = removeDiscoveryWatchlistEntry(req.params.address);
      if (!deleted) {
        res.status(404).json({ success: false, error: 'Watchlist entry not found' });
        return;
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/alerts', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
      const severity = req.query.severity ? String(req.query.severity) : undefined;
      const signalType = req.query.signalType ? String(req.query.signalType) : undefined;
      const walletAddress = req.query.walletAddress ? String(req.query.walletAddress) : undefined;
      const onlyUndismissed = req.query.includeDismissed === 'true' ? false : true;
      let alerts = getDiscoveryAlertsV2(limit, offset, {
        severity,
        signalType,
        walletAddress,
        onlyUndismissed,
      });
      if (alerts.length === 0) {
        const fallbackSignals = buildDiscoverySignalRowsFromWallets(
          manager.getWallets('trust', 1000, 0) as Array<Record<string, unknown>>
        );
        alerts = fallbackSignals
          .filter((signal) => !severity || signal.severity === severity)
          .filter((signal) => !signalType || signal.signalType === signalType)
          .filter((signal) => !walletAddress || signal.address === walletAddress.toLowerCase())
          .slice(offset, offset + limit);
      }
      res.json({ success: true, alerts });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/alerts/:id/dismiss', (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ success: false, error: 'Invalid alert id' });
        return;
      }
      const dismissed = dismissDiscoveryAlertV2(id);
      if (!dismissed) {
        res.status(404).json({ success: false, error: 'Alert not found' });
        return;
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/methodology', (_req: Request, res: Response) => {
    try {
      res.json({ success: true, methodology: buildDiscoveryMethodologyPayload() });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/allocation/config', (_req: Request, res: Response) => {
    try {
      res.json({ success: true, config: getAllocationPolicyConfig() });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.put('/allocation/config', (req: Request, res: Response) => {
    try {
      const nextConfig = updateAllocationPolicyConfig(req.body || {});
      res.json({ success: true, config: nextConfig });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/allocation/states', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 250);
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
      res.json({
        success: true,
        states: getAllocationPolicyStates(limit, offset),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/allocation/transitions', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 250);
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
      const address = req.query.address ? String(req.query.address) : undefined;
      res.json({
        success: true,
        transitions: getAllocationPolicyTransitions(limit, offset, address),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/allocation/evaluate', (req: Request, res: Response) => {
    try {
      const addressesInput = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
      const addresses = [...new Set(
        addressesInput.map((value: unknown) => String(value || '').trim().toLowerCase()).filter(Boolean)
      )];
      const wallets = manager.getWallets('score', 500, 0) as Array<Record<string, unknown>>;
      const scopedWallets = addresses.length > 0
        ? wallets.filter((wallet) => addresses.includes(String(wallet.address || '').toLowerCase()))
        : wallets;
      const result = evaluateAndPersistAllocationPolicies(
        scopedWallets.map((wallet) => buildAllocationPolicyInputFromWallet(wallet))
      );
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /signals — recent signals with optional filters
  // -----------------------------------------------------------------------
  router.get('/signals', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const severity = req.query.severity as string | undefined;
      const reasonSignals = buildDiscoverySignalRowsFromWallets(
        manager.getWallets('trust', 1000, 0) as Array<Record<string, unknown>>
      ).map((signal, index) => ({
        ...signal,
        id: offset + index + 1,
      }));
      const scopedSignals = severity
        ? reasonSignals.filter((signal) => signal.severity === severity)
        : reasonSignals;
      const signals = scopedSignals.slice(offset, offset + limit);
      res.json({ success: true, signals });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /signals/markets — unusual markets with insider/coordinated signals
  // -----------------------------------------------------------------------
  router.get('/signals/markets', (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const cutoff = Date.now() - days * 86400 * 1000;
      const marketCounts = new Map<string, { marketTitle: string; signal_count: number; wallets: Set<string> }>();
      const normalizeTimestamp = (value?: number): number => {
        const timestamp = Number(value || 0);
        return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
      };
      for (const wallet of manager.getWallets('score', 200, 0) as any[]) {
        if (!Array.isArray(wallet.supportingMarkets)) continue;
        if (normalizeTimestamp(wallet.updatedAt) < cutoff) continue;
        for (const marketTitle of wallet.supportingMarkets) {
          const entry = marketCounts.get(marketTitle) ?? { marketTitle, signal_count: 0, wallets: new Set<string>() };
          entry.signal_count += 1;
          entry.wallets.add(wallet.address);
          marketCounts.set(marketTitle, entry);
        }
      }
      const markets = [...marketCounts.values()]
        .sort((a, b) => b.signal_count - a.signal_count)
        .map((entry) => ({
          market_title: entry.marketTitle,
          signal_count: entry.signal_count,
          wallets: [...entry.wallets].join(','),
        }));
      res.json({ success: true, markets });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/summary', (req: Request, res: Response) => {
    try {
      const days = Math.min(parseInt(req.query.days as string) || 7, 14);
      const wallets = manager.getWallets('score', 1000, 0) as any[];
      const signals = buildDiscoverySignalRowsFromWallets(wallets);
      res.json({
        success: true,
        overview: buildDiscoveryOverview(wallets as any, signals as any, days),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /signals/:id/dismiss — dismiss a signal
  // -----------------------------------------------------------------------
  router.post('/signals/:id/dismiss', (req: Request, res: Response) => {
    try {
      dismissSignal(parseInt(req.params.id, 10));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /wallets/:address/positions — positions for a wallet
  // -----------------------------------------------------------------------
  router.get('/wallets/:address/positions', (req: Request, res: Response) => {
    void (async () => {
      try {
        const address = req.params.address.toLowerCase();
        const validation = getWalletValidation(address);
        const profileMetadata = normalizeWalletDetailProfile(address, validation?.rawProfile);
        try {
          const positions = await fetchAuthoritativePositions(address);
          res.json(buildWalletPositionsResponse(address, positions, 'verified', profileMetadata));
          return;
        } catch {
          /* fall back to derived positions below */
        }

        if (validation?.rawPositions?.length) {
          const cachedPositions = validation.rawPositions.map((position) =>
            mapOfficialPositionToWalletPosition(position as any, 'cached')
          );
          res.json(buildWalletPositionsResponse(address, cachedPositions, 'cached', profileMetadata));
          return;
        }

        const positions = getPositionsByAddress(address);
        res.json(buildWalletPositionsResponse(address, positions, 'derived', profileMetadata));
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    })();
  });

  // -----------------------------------------------------------------------
  // GET /wallets/:address/signals — signals for a wallet
  // -----------------------------------------------------------------------
  router.get('/wallets/:address/signals', (req: Request, res: Response) => {
    try {
      const wallet = getWalletSnapshot(req.params.address.toLowerCase());
      const signals = wallet
        ? buildDiscoverySignalRowsFromWallets([wallet]).map((signal, index) => ({
            ...signal,
            id: index + 1,
          }))
        : [];
      res.json({ success: true, signals });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /wallets/:address/verification — compare derived vs verified positions
  // -----------------------------------------------------------------------
  router.get('/wallets/:address/verification', (req: Request, res: Response) => {
    void (async () => {
      try {
        const address = req.params.address.toLowerCase();
        const derivedPositions = getPositionsByAddress(address);
        const verifiedPositions = await fetchAuthoritativePositions(address);
        res.json({
          success: true,
          summary: buildPositionVerificationSummary(derivedPositions, verifiedPositions),
          derivedPositions,
          verifiedPositions,
        });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    })();
  });

  // -----------------------------------------------------------------------
  // GET /config — current discovery config (Alchemy URL masked)
  // -----------------------------------------------------------------------
  router.get('/config', (req: Request, res: Response) => {
    try {
      const cfg = manager.getConfig();
      res.json({
        success: true,
        config: {
          ...cfg,
          alchemyWsUrl: maskAlchemyUrl(cfg.alchemyWsUrl),
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /config — update runtime config (persisted to SQLite)
  // -----------------------------------------------------------------------
  router.put('/config', async (req: Request, res: Response) => {
    try {
      const updates: Partial<DiscoveryConfig> = {};
      const body = req.body;

      if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled);
      if (body.alchemyWsUrl !== undefined) {
        updates.alchemyWsUrl = normalizeAlchemyWsUrl(String(body.alchemyWsUrl));
      }
      if (body.pollIntervalMs !== undefined) updates.pollIntervalMs = parseInt(body.pollIntervalMs, 10);
      if (body.marketCount !== undefined) updates.marketCount = parseInt(body.marketCount, 10);
      if (body.statsIntervalMs !== undefined) updates.statsIntervalMs = parseInt(body.statsIntervalMs, 10);
      if (body.retentionDays !== undefined) updates.retentionDays = parseInt(body.retentionDays, 10);
    if (body.readMode === 'v2-primary' || body.readMode === 'v2-with-v1-fallback') updates.readMode = body.readMode;

      const newConfig = await manager.updateConfig(updates);
      res.json({
        success: true,
        config: {
          ...newConfig,
          alchemyWsUrl: maskAlchemyUrl(newConfig.alchemyWsUrl),
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /config/restart — restart the discovery engine
  // -----------------------------------------------------------------------
  router.post('/config/restart', async (req: Request, res: Response) => {
    try {
      if (typeof (manager as any).isPassiveRuntime === 'function' && (manager as any).isPassiveRuntime()) {
        return res.json({
          success: true,
          message: 'Discovery worker runs separately. Shared config updates are already persisted; restart the worker manually after code changes.',
          restarted: false,
          runtime: 'worker-owned',
        });
      }

      try {
        await manager.restart();
        res.json({ success: true, message: 'Discovery engine restarted', restarted: true });
      } catch {
        res.status(202).json({
          success: true,
          message: 'Discovery worker settings saved. Restart the dedicated discovery worker process to apply them.',
          restarted: false,
          runtime: 'worker-owned',
        });
      }
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /status — health info
  // -----------------------------------------------------------------------
  router.get('/status', (req: Request, res: Response) => {
    try {
      const status = manager.getStatus();
      res.json({ success: true, ...status });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/migration/status', (_req: Request, res: Response) => {
    try {
      const status = manager.getStatus() as Record<string, unknown>;
      const budgets = (status.budgets && typeof status.budgets === 'object')
        ? (status.budgets as Record<string, unknown>)
        : {};
      res.json({
        success: true,
        migration: budgets.migration ?? null,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /purge — delete old discovery trades
  // -----------------------------------------------------------------------
  router.post('/purge', (req: Request, res: Response) => {
    try {
      if (req.body?.full === true) {
        const deleted = manager.resetData();
        res.json({ success: true, mode: 'full', deleted });
        return;
      }
      const days = parseInt(req.body.days) || 90;
      const deleted = manager.purgeData(days);
      res.json({ success: true, mode: 'days', deleted });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /wallets/:address/track — mark a discovered wallet as tracked
  // -----------------------------------------------------------------------
  router.post('/wallets/:address/track', (req: Request, res: Response) => {
    void (async () => {
      try {
        const address = req.params.address.toLowerCase();
        const snapshot = getWalletSnapshot(address);
        if (!snapshot) {
          res.status(409).json({ success: false, error: 'Wallet is not ready for Safari tracking yet.' });
          return;
        }
        try {
          await Storage.addWallet(address);
        } catch {
          /* already tracked */
        }
        const existingWallet = await Storage.getWallet(address);
        const nextTags = [...new Set([...(existingWallet?.tags || []), 'discovery'])];
        await Storage.updateWalletTags(address, nextTags);
        markWalletTracked(address, true);
        evaluateAndPersistAllocationPolicies([buildAllocationPolicyInputFromWallet(snapshot)]);

        let activated = true;
        let message: string | undefined;
        try {
          await Storage.toggleWalletActive(address, true);
        } catch (error: any) {
          activated = false;
          message = error.message || 'Tracked, but wallet still needs copy-trading configuration before activation.';
        }
        res.json({ success: true, activated, message });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    })();
  });

  return router;
};
