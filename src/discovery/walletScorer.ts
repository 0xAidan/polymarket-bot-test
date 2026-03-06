/**
 * Wallet Scorer
 *
 * Computes a composite Whale Score (0-100) and Heat Indicator for each
 * wallet in discovery_wallets. Called after aggregateStats() on each
 * periodic cycle.
 *
 * Whale Score factors:
 *   Volume (0-25) + ROI (0-25) + Consistency (0-20) + Size (0-15) + Diversity (0-15)
 *
 * Heat Indicator:
 *   HOT / WARMING / STEADY / COOLING / COLD / NEW
 */

import { getDiscoveryDatabase } from './discoveryDatabase.js';
import { HeatIndicator } from './types.js';

export const computeScoresAndHeat = (): void => {
  const db = getDiscoveryDatabase();
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 86400;
  const fourteenDaysAgo = now - 14 * 86400;

  const maxRow = db.prepare('SELECT MAX(volume_7d) as maxVol FROM discovery_wallets').get() as { maxVol: number };
  const maxVolume = maxRow.maxVol || 1;

  const wallets = db.prepare('SELECT * FROM discovery_wallets').all() as any[];

  const updateStmt = db.prepare(
    'UPDATE discovery_wallets SET whale_score = ?, heat_indicator = ? WHERE address = ?'
  );

  const tx = db.transaction(() => {
    for (const w of wallets) {
      const score = computeDiscoveryWalletScore(w, maxVolume);
      const heat = computeHeat(w, now, sevenDaysAgo, fourteenDaysAgo);
      updateStmt.run(score, heat, w.address);
    }
  });
  tx();
};

export const computeDiscoveryWalletScore = (w: any, _maxVolume?: number): number => {
  const volume7d = Number(w.volume7d ?? w.volume_7d ?? 0);
  const volumePrev7d = Number(w.volumePrev7d ?? w.volume_prev_7d ?? 0);
  const highInformationVolume7d = Number(w.highInformationVolume7d ?? w.high_information_volume_7d ?? 0);
  const currentVolumeFactor = Math.min(15, (volume7d / 25_000) * 15);
  const sustainedVolumeFactor = Math.min(15, (Math.min(volume7d, volumePrev7d) / 20_000) * 15);
  const highInformationShare = volume7d > 0 ? Math.min(1, highInformationVolume7d / volume7d) : 0;
  const informationFactor = highInformationShare * 8;

  const rawRoi = w.roiPct ?? w.roi_pct;
  const roiPct = rawRoi === null || rawRoi === undefined ? null : Number(rawRoi);
  const roiFactor = roiPct === null ? 0 : Math.max(0, Math.min(25, ((roiPct + 10) / 40) * 25));

  const consistencyFactor = Math.min(12, ((w.tradeCount7d ?? w.trade_count_7d ?? 0) / 25) * 12);
  const sizeFactor = Math.min(6, ((w.avgTradeSize ?? w.avg_trade_size ?? 0) / 5000) * 6);
  const diversityFactor = Math.min(8, ((w.uniqueMarkets7d ?? w.unique_markets_7d ?? 0) / 8) * 8);
  const pnlFactor = Math.max(0, Math.min(12, (Number(w.totalPnl ?? w.total_pnl ?? 0) / 5000) * 12));
  const positionFactor = Math.min(7, ((w.activePositions ?? w.active_positions ?? 0) / 5) * 7);

  return Math.round((
    currentVolumeFactor +
    sustainedVolumeFactor +
    informationFactor +
    roiFactor +
    consistencyFactor +
    sizeFactor +
    diversityFactor +
    pnlFactor +
    positionFactor
  ) * 10) / 10;
};

const computeHeat = (
  w: any,
  now: number,
  sevenDaysAgo: number,
  fourteenDaysAgo: number
): HeatIndicator => {
  const firstSeenMs = w.first_seen;
  const lastActiveMs = w.last_active;

  if (firstSeenMs > sevenDaysAgo * 1000) return 'NEW';
  if (lastActiveMs < fourteenDaysAgo * 1000) return 'COLD';

  const vol = w.volume_7d || 0;
  const prevVol = w.volume_prev_7d || 0;

  if (prevVol === 0) {
    return vol > 10000 ? 'HOT' : vol > 0 ? 'WARMING' : 'COLD';
  }

  const ratio = vol / prevVol;
  if (ratio > 3 && vol > 10000) return 'HOT';
  if (ratio > 1.5) return 'WARMING';
  if (ratio >= 0.5) return 'STEADY';
  if (vol > 0) return 'COOLING';
  return 'COLD';
};
