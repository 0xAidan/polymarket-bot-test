/**
 * Signal Engine
 *
 * Evaluates trades and wallet stats against configurable thresholds to
 * produce typed signals. Two entry points:
 *
 * 1. evaluateTradeSignals() — called per-batch from tradeIngestion flush.
 *    Checks: SIZE_ANOMALY, NEW_WHALE, MARKET_PIONEER.
 *
 * 2. evaluatePeriodicSignals() — called on each stats aggregation cycle.
 *    Checks: VOLUME_SPIKE, DORMANT_ACTIVATION, COORDINATED_ENTRY.
 *
 * All signals are deduped: same (signal_type, address, condition_id) cannot
 * fire more than once per 24 hours. A daily cap prevents alert spam.
 */

import { getDatabase } from '../database.js';
import {
  DiscoveredTrade,
  WalletStats,
  SignalType,
  SignalSeverity,
  DiscoverySignal,
  SignalThresholds,
  DEFAULT_SIGNAL_THRESHOLDS,
} from './types.js';
import {
  insertSignal,
  signalExistsRecently,
  getSignalCountToday,
  getSmartMoneyCountForMarket,
  getPositionValue,
} from './statsStore.js';
import { classifyDiscoveryMarket } from './marketClassifier.js';
import { insertDiscoveryAlertV2 } from './v2DataStore.js';

let thresholds: SignalThresholds = { ...DEFAULT_SIGNAL_THRESHOLDS };

export const setThresholds = (t: Partial<SignalThresholds>): void => {
  thresholds = { ...thresholds, ...t };
};

export const getThresholds = (): SignalThresholds => ({ ...thresholds });

export const evaluateTradeSignals = (trade: DiscoveredTrade, walletStats: WalletStats): void => {
  try {
    if (getSignalCountToday() >= thresholds.maxSignalsPerDay) return;
    if (!isPrimaryDiscoveryTrade(trade)) return;

    checkSizeAnomaly(trade, walletStats);
    checkNewWhale(trade, walletStats);
    checkMarketPioneer(trade, walletStats);
    checkConvictionBuild(trade, walletStats);
  } catch (err) {
    console.error('[SignalEngine] Trade signal evaluation error:', err);
  }
};

export const evaluatePeriodicSignals = (): void => {
  try {
    if (getSignalCountToday() >= thresholds.maxSignalsPerDay) return;

    checkVolumeSpikes();
    checkDormantActivations();
    checkCoordinatedEntries();
  } catch (err) {
    console.error('[SignalEngine] Periodic signal evaluation error:', err);
  }
};

const checkSizeAnomaly = (trade: DiscoveredTrade, stats: WalletStats): void => {
  if (stats.tradeCount7d < thresholds.sizeAnomalyMinTrades) return;
  if (stats.avgTradeSize <= 0) return;
  const notionalUsd = getTradeNotionalUsd(trade);
  if (notionalUsd < thresholds.sizeAnomalyMinNotionalUsd) return;

  const multiplier = notionalUsd / stats.avgTradeSize;
  if (multiplier < thresholds.sizeAnomalyMultiplier) return;
  if (signalExistsRecently('SIZE_ANOMALY', trade.maker, trade.conditionId, 24)) return;

  const severity: SignalSeverity = multiplier >= 20 ? 'critical' : multiplier >= 10 ? 'high' : 'medium';
  fireSignal({
    signalType: 'SIZE_ANOMALY',
    severity,
    address: trade.maker,
    conditionId: trade.conditionId,
    marketTitle: trade.marketTitle,
    title: `Unusual trade size: ${multiplier.toFixed(1)}x average`,
    description: `${trade.maker.slice(0, 8)}... traded $${notionalUsd.toLocaleString()} (${multiplier.toFixed(1)}x their avg of $${stats.avgTradeSize.toLocaleString()}) in ${trade.marketTitle || trade.conditionId?.slice(0, 12) || 'unknown market'}`,
    metadata: { multiplier, notionalUsd, avgSize: stats.avgTradeSize, txHash: trade.txHash },
    detectedAt: Date.now(),
  });
};

const checkNewWhale = (trade: DiscoveredTrade, stats: WalletStats): void => {
  if (!isEmergingSignalEligibleTrade(trade)) return;
  const notionalUsd = getTradeNotionalUsd(trade);
  if (!shouldFlagNewWhale(stats, Date.now(), thresholds.newWhaleMinSize, notionalUsd)) return;
  if (signalExistsRecently('NEW_WHALE', trade.maker, undefined, 168)) return;

  const severity: SignalSeverity = notionalUsd >= 100000 ? 'critical' : notionalUsd >= 50000 ? 'high' : 'medium';
  fireSignal({
    signalType: 'NEW_WHALE',
    severity,
    address: trade.maker,
    conditionId: trade.conditionId,
    marketTitle: trade.marketTitle,
    title: `New wallet with $${notionalUsd.toLocaleString()} trade`,
    description: `Previously unseen wallet ${trade.maker.slice(0, 8)}... opened a $${notionalUsd.toLocaleString()} position in ${trade.marketTitle || 'unknown market'}. Only ${stats.tradeCount7d} prior trades.`,
    metadata: { notionalUsd, priorTrades: stats.tradeCount7d, txHash: trade.txHash },
    detectedAt: Date.now(),
  });
};

const checkMarketPioneer = (trade: DiscoveredTrade, _stats: WalletStats): void => {
  if (!isEmergingSignalEligibleTrade(trade)) return;
  if (!trade.conditionId) return;

  const positionValue = getPositionValue(trade.maker, trade.conditionId);
  if (positionValue < thresholds.marketPioneerMinPosition) return;
  if (signalExistsRecently('MARKET_PIONEER', trade.maker, trade.conditionId, 24)) return;

  const smartMoneyCount = getSmartMoneyCountForMarket(trade.conditionId, thresholds.smartMoneyScoreThreshold);
  if (smartMoneyCount >= thresholds.marketPioneerMaxSmartMoney) return;

  const severity: SignalSeverity = positionValue >= 500000 ? 'critical' : 'high';
  fireSignal({
    signalType: 'MARKET_PIONEER',
    severity,
    address: trade.maker,
    conditionId: trade.conditionId,
    marketTitle: trade.marketTitle,
    title: `$${(positionValue / 1000).toFixed(0)}k position in untouched market`,
    description: `${trade.maker.slice(0, 8)}... has accumulated $${positionValue.toLocaleString()} in "${trade.marketTitle || trade.conditionId.slice(0, 12)}" — only ${smartMoneyCount} smart money wallets in this market. Possible insider signal.`,
    metadata: { positionValue, smartMoneyCount, conditionId: trade.conditionId },
    detectedAt: Date.now(),
  });
};

const checkVolumeSpikes = (): void => {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
    SELECT address, volume_7d, volume_prev_7d, pseudonym
    FROM discovery_wallets
    WHERE volume_prev_7d > 0 AND volume_7d > ? AND volume_7d > volume_prev_7d * ?
  `
    )
    .all(thresholds.volumeSpikeMinVolume, thresholds.volumeSpikeMultiplier) as any[];

  for (const row of rows) {
    if (signalExistsRecently('VOLUME_SPIKE', row.address, undefined, 24)) continue;
    if (getSignalCountToday() >= thresholds.maxSignalsPerDay) break;

    const multiplier = row.volume_7d / row.volume_prev_7d;
    const severity: SignalSeverity = multiplier >= 10 ? 'critical' : multiplier >= 5 ? 'high' : 'medium';
    fireSignal({
      signalType: 'VOLUME_SPIKE',
      severity,
      address: row.address,
      title: `Volume spike: ${multiplier.toFixed(1)}x week-over-week`,
      description: `${row.pseudonym || row.address.slice(0, 8) + '...'} volume jumped from $${row.volume_prev_7d.toLocaleString()} to $${row.volume_7d.toLocaleString()} (${multiplier.toFixed(1)}x)`,
      metadata: { multiplier, volume7d: row.volume_7d, volumePrev7d: row.volume_prev_7d },
      detectedAt: Date.now(),
    });
  }
};

const checkDormantActivations = (): void => {
  const db = getDatabase();
  const nowMs = Date.now();

  const rows = db
    .prepare(
      `
    SELECT address, volume_7d, volume_prev_7d, pseudonym, last_active, first_seen
    FROM discovery_wallets
    WHERE volume_7d > ?
  `
    )
    .all(thresholds.dormantMinVolume) as any[];

  for (const row of rows) {
    if (!shouldFlagDormantActivation(row, nowMs, thresholds.dormantDays, thresholds.dormantMinVolume)) continue;
    if (signalExistsRecently('DORMANT_ACTIVATION', row.address, undefined, 168)) continue;
    if (getSignalCountToday() >= thresholds.maxSignalsPerDay) break;

    fireSignal({
      signalType: 'DORMANT_ACTIVATION',
      severity: 'high',
      address: row.address,
      title: `Dormant wallet reactivated`,
      description: `${row.pseudonym || row.address.slice(0, 8) + '...'} had zero activity last week but traded $${row.volume_7d.toLocaleString()} in the current period. Dormant wallet suddenly active.`,
      metadata: { volume7d: row.volume_7d },
      detectedAt: Date.now(),
    });
  }
};

export const shouldFlagDormantActivation = (
  wallet: Pick<WalletStats, 'volume7d' | 'volumePrev7d' | 'lastActive' | 'firstSeen' | 'priorActiveAt'>,
  nowMs: number,
  dormantDays: number,
  dormantMinVolume: number,
): boolean => {
  if ((wallet.volume7d || 0) <= dormantMinVolume) return false;
  if ((wallet.volumePrev7d || 0) > 0) return false;
  if (!wallet.lastActive) return false;
  if (wallet.lastActive < nowMs - 24 * 3600 * 1000) return false;
  if (!wallet.priorActiveAt) return false;
  return wallet.priorActiveAt <= nowMs - dormantDays * 86400 * 1000;
};

const checkCoordinatedEntries = (): void => {
  const db = getDatabase();
  const lookback = Date.now() - 24 * 3600 * 1000;

  const rows = db
    .prepare(
      `
    SELECT dt.condition_id, dt.asset_id, dt.market_title, dt.maker, dt.detected_at,
      dw.whale_score,
      COALESCE(dt.notional_usd, CASE WHEN dt.price IS NOT NULL THEN dt.size * dt.price ELSE dt.size END) as notional_usd
    FROM discovery_trades dt
    JOIN discovery_wallets dw ON dw.address = dt.maker
    WHERE dt.detected_at > ? AND dt.condition_id IS NOT NULL AND dt.side = 'BUY'
    ORDER BY dt.condition_id, dt.asset_id, dt.detected_at ASC
  `
    )
    .all(lookback) as any[];

  for (const row of findCoordinatedEntryCandidates(rows, thresholds)) {
    const firstWallet = row.wallets[0];
    if (!firstWallet) continue;
    if (signalExistsRecently('COORDINATED_ENTRY', firstWallet, row.condition_id, 24)) continue;
    if (getSignalCountToday() >= thresholds.maxSignalsPerDay) break;

    const severity: SignalSeverity = row.wallet_count >= 5 ? 'critical' : 'high';
    fireSignal({
      signalType: 'COORDINATED_ENTRY',
      severity,
      address: firstWallet,
      conditionId: row.condition_id,
      marketTitle: row.market_title,
      title: `${row.wallet_count} wallets entered same market within ${thresholds.coordinatedWindowMinutes}min`,
      description: `${row.wallet_count} high-quality wallets bought "${row.market_title || row.condition_id?.slice(0, 12) || 'unknown'}" within a ${thresholds.coordinatedWindowMinutes}-minute window with combined volume of $${row.total_volume.toLocaleString()}.`,
      metadata: {
        walletCount: row.wallet_count,
        totalVolume: row.total_volume,
        avgScore: row.avg_score,
        side: 'BUY',
        assetId: row.asset_id,
        wallets: row.wallets,
      },
      detectedAt: Date.now(),
    });
  }
};

export const shouldFlagNewWhale = (
  stats: Pick<WalletStats, 'firstSeen' | 'tradeCount7d'>,
  nowMs: number,
  newWhaleMinSize: number,
  notionalUsd: number,
): boolean => {
  if (notionalUsd < newWhaleMinSize) return false;
  if ((stats.tradeCount7d || 0) > 3) return false;
  if (!stats.firstSeen) return false;
  return stats.firstSeen >= nowMs - 7 * 86400 * 1000;
};

export const findCoordinatedEntryCandidates = (
  trades: Array<{
    condition_id?: string;
    conditionId?: string;
    asset_id?: string;
    assetId?: string;
    market_title?: string;
    marketTitle?: string;
    maker: string;
    detected_at?: number;
    detectedAt?: number;
    notional_usd?: number;
    notionalUsd?: number;
    whale_score?: number;
    whaleScore?: number;
  }>,
  signalThresholds: Pick<SignalThresholds, 'coordinatedWindowMinutes' | 'coordinatedMinWallets' | 'coordinatedMinVolume' | 'coordinatedMinAvgScore'>,
): Array<{
  condition_id: string;
  asset_id: string;
  market_title?: string;
  wallet_count: number;
  total_volume: number;
  avg_score: number;
  wallets: string[];
}> => {
  const windowMs = signalThresholds.coordinatedWindowMinutes * 60 * 1000;
  const groups = new Map<string, Array<{
    conditionId: string;
    assetId: string;
    marketTitle?: string;
    maker: string;
    detectedAt: number;
    notionalUsd: number;
    whaleScore: number;
  }>>();

  for (const trade of trades) {
    const conditionId = String(trade.conditionId ?? trade.condition_id ?? '');
    const assetId = String(trade.assetId ?? trade.asset_id ?? '');
    const maker = String(trade.maker || '');
    const detectedAt = Number(trade.detectedAt ?? trade.detected_at ?? 0);
    if (!conditionId || !assetId || !maker || !detectedAt) continue;

    const key = `${conditionId}:${assetId}`;
    const list = groups.get(key) ?? [];
    list.push({
      conditionId,
      assetId,
      marketTitle: trade.marketTitle ?? trade.market_title,
      maker,
      detectedAt,
      notionalUsd: Number(trade.notionalUsd ?? trade.notional_usd ?? 0),
      whaleScore: Number(trade.whaleScore ?? trade.whale_score ?? 0),
    });
    groups.set(key, list);
  }

  const candidates: Array<{
    condition_id: string;
    asset_id: string;
    market_title?: string;
    wallet_count: number;
    total_volume: number;
    avg_score: number;
    wallets: string[];
  }> = [];

  for (const entries of groups.values()) {
    let bestCandidate: (typeof candidates)[number] | null = null;

    for (let start = 0; start < entries.length; start++) {
      const wallets = new Set<string>();
      let totalVolume = 0;
      let totalScore = 0;
      let scoreCount = 0;

      for (let end = start; end < entries.length; end++) {
        if (entries[end].detectedAt - entries[start].detectedAt > windowMs) break;
        if (wallets.has(entries[end].maker)) continue;

        wallets.add(entries[end].maker);
        totalVolume += entries[end].notionalUsd;
        totalScore += entries[end].whaleScore;
        scoreCount++;
      }

      const walletCount = wallets.size;
      const avgScore = scoreCount > 0 ? totalScore / scoreCount : 0;
      if (walletCount < signalThresholds.coordinatedMinWallets) continue;
      if (totalVolume < signalThresholds.coordinatedMinVolume) continue;
      if (avgScore < signalThresholds.coordinatedMinAvgScore) continue;

      const candidate = {
        condition_id: entries[start].conditionId,
        asset_id: entries[start].assetId,
        market_title: entries[start].marketTitle,
        wallet_count: walletCount,
        total_volume: totalVolume,
        avg_score: avgScore,
        wallets: [...wallets],
      };

      if (
        !bestCandidate ||
        candidate.wallet_count > bestCandidate.wallet_count ||
        (candidate.wallet_count === bestCandidate.wallet_count && candidate.total_volume > bestCandidate.total_volume)
      ) {
        bestCandidate = candidate;
      }
    }

    if (bestCandidate) candidates.push(bestCandidate);
  }

  return candidates;
};

const checkConvictionBuild = (trade: DiscoveredTrade, stats: WalletStats): void => {
  if (!trade.conditionId || !trade.assetId || trade.side !== 'BUY') return;
  const db = getDatabase();
  const lookback = Date.now() - thresholds.convictionWindowMinutes * 60 * 1000;
  const row = db.prepare(`
    SELECT
      COUNT(*) as fills,
      COALESCE(SUM(COALESCE(notional_usd, CASE WHEN price IS NOT NULL THEN size * price ELSE size END)), 0) as total_notional,
      COALESCE(SUM(CASE WHEN side = 'BUY' THEN COALESCE(notional_usd, CASE WHEN price IS NOT NULL THEN size * price ELSE size END) ELSE 0 END), 0) as buy_notional,
      COALESCE(SUM(CASE WHEN side = 'SELL' THEN COALESCE(notional_usd, CASE WHEN price IS NOT NULL THEN size * price ELSE size END) ELSE 0 END), 0) as sell_notional
    FROM discovery_trades
    WHERE maker = ? AND condition_id = ? AND asset_id = ? AND detected_at > ?
  `).get(trade.maker, trade.conditionId, trade.assetId, lookback) as any;

  if (!row || row.fills < thresholds.convictionMinFills) return;
  if (row.total_notional < thresholds.convictionMinNotionalUsd) return;
  if (row.buy_notional <= row.sell_notional * 1.5) return;
  if (stats.whaleScore < thresholds.smartMoneyScoreThreshold - 10) return;
  if (signalExistsRecently('CONVICTION_BUILD', trade.maker, trade.conditionId, 24)) return;

  const severity: SignalSeverity = row.total_notional >= 50000 ? 'critical' : row.total_notional >= 20000 ? 'high' : 'medium';
  fireSignal({
    signalType: 'CONVICTION_BUILD',
    severity,
    address: trade.maker,
    conditionId: trade.conditionId,
    marketTitle: trade.marketTitle,
    title: `Conviction build: ${row.fills} buys in ${thresholds.convictionWindowMinutes}m`,
    description: `${trade.maker.slice(0, 8)}... accumulated $${row.total_notional.toLocaleString()} across ${row.fills} fills in ${trade.marketTitle || 'this market'} with limited opposing flow.`,
    metadata: {
      fills: row.fills,
      totalNotional: row.total_notional,
      buyNotional: row.buy_notional,
      sellNotional: row.sell_notional,
      assetId: trade.assetId,
      outcome: trade.outcome,
    },
    detectedAt: Date.now(),
  });
};

const fireSignal = (signal: Omit<DiscoverySignal, 'id' | 'dismissed'>): void => {
  try {
    insertSignal(signal);
    insertDiscoveryAlertV2(signal);
    console.log(`[SignalEngine] ${signal.severity.toUpperCase()} ${signal.signalType}: ${signal.title}`);
  } catch (err) {
    console.error('[SignalEngine] Failed to insert signal:', err);
  }
};

const getTradeNotionalUsd = (trade: DiscoveredTrade): number => {
  if (Number.isFinite(trade.notionalUsd) && (trade.notionalUsd as number) > 0) {
    return trade.notionalUsd as number;
  }
  if (Number.isFinite(trade.price) && Number.isFinite(trade.size) && trade.price! > 0 && trade.size > 0) {
    return trade.size * trade.price!;
  }
  return trade.size;
};

export const isEmergingSignalEligibleTrade = (
  trade: Pick<DiscoveredTrade, 'marketTitle' | 'marketSlug'>
): boolean => {
  return isPrimaryDiscoveryTrade(trade);
};

export const isPrimaryDiscoveryTrade = (
  trade: Pick<DiscoveredTrade, 'marketTitle' | 'marketSlug'>
): boolean => {
  const classified = classifyDiscoveryMarket({
    title: trade.marketTitle,
    slug: trade.marketSlug,
  });
  return classified.primaryDiscoveryEligible !== false;
};
