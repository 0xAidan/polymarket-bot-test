import { getDatabase } from '../database.js';
import { DiscoveryWalletValidation } from './types.js';

type WalletValidationInput = {
  address: string;
  profile?: Record<string, unknown> | null;
  traded?: Record<string, unknown> | null;
  positions?: Array<Record<string, unknown>>;
  closedPositions?: Array<Record<string, unknown>>;
  activity?: Array<Record<string, unknown>>;
  validatedAt: number;
};

const parseOptionalNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const buildWalletValidationRecord = ({
  address,
  profile,
  traded,
  positions = [],
  closedPositions = [],
  activity = [],
  validatedAt,
}: WalletValidationInput): DiscoveryWalletValidation => {
  const normalizedAddress = String(address).trim().toLowerCase();
  const realizedPnls = closedPositions
    .map((position) => parseOptionalNumber(position.realizedPnl ?? position.cashPnl) ?? 0);
  const winningClosedPositions = realizedPnls.filter((value) => value > 0).length;
  const tradeActivity = activity.filter((entry) => String(entry.type ?? '').toUpperCase() === 'TRADE');
  const buyActivityCount = tradeActivity.filter((entry) => String(entry.side ?? '').toUpperCase() === 'BUY').length;
  const sellActivityCount = tradeActivity.filter((entry) => String(entry.side ?? '').toUpperCase() === 'SELL').length;
  const makerRebateCount = activity.filter((entry) => String(entry.type ?? '').toUpperCase() === 'MAKER_REBATE').length;
  const marketsTouched = new Set(
    activity
      .map((entry) => String(entry.marketSlug ?? entry.market ?? entry.conditionId ?? '').trim())
      .filter(Boolean)
  ).size;

  return {
    address: normalizedAddress,
    profileName: profile?.name ? String(profile.name) : undefined,
    pseudonym: profile?.pseudonym ? String(profile.pseudonym) : undefined,
    xUsername: profile?.xUsername ? String(profile.xUsername) : undefined,
    verifiedBadge: Boolean(profile?.verifiedBadge),
    tradedMarkets: parseOptionalNumber(traded?.traded),
    openPositionsCount: positions.length,
    closedPositionsCount: closedPositions.length,
    realizedPnl: realizedPnls.reduce((sum, value) => sum + value, 0),
    realizedWinRate: closedPositions.length > 0 ? (winningClosedPositions / closedPositions.length) * 100 : 0,
    makerRebateCount,
    tradeActivityCount: tradeActivity.length,
    buyActivityCount,
    sellActivityCount,
    marketsTouched,
    lastValidatedAt: validatedAt,
    rawProfile: profile ?? undefined,
    rawPositions: positions,
    rawClosedPositions: closedPositions,
    rawActivity: activity,
  };
};

export const upsertWalletValidation = (record: DiscoveryWalletValidation): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_wallet_validation (
      address, profile_name, pseudonym, x_username, verified_badge, traded_markets,
      open_positions_count, closed_positions_count, realized_pnl, realized_win_rate,
      maker_rebate_count, trade_activity_count, buy_activity_count, sell_activity_count,
      markets_touched, raw_profile, raw_positions, raw_closed_positions, raw_activity,
      last_validated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      profile_name = excluded.profile_name,
      pseudonym = excluded.pseudonym,
      x_username = excluded.x_username,
      verified_badge = excluded.verified_badge,
      traded_markets = excluded.traded_markets,
      open_positions_count = excluded.open_positions_count,
      closed_positions_count = excluded.closed_positions_count,
      realized_pnl = excluded.realized_pnl,
      realized_win_rate = excluded.realized_win_rate,
      maker_rebate_count = excluded.maker_rebate_count,
      trade_activity_count = excluded.trade_activity_count,
      buy_activity_count = excluded.buy_activity_count,
      sell_activity_count = excluded.sell_activity_count,
      markets_touched = excluded.markets_touched,
      raw_profile = excluded.raw_profile,
      raw_positions = excluded.raw_positions,
      raw_closed_positions = excluded.raw_closed_positions,
      raw_activity = excluded.raw_activity,
      last_validated_at = excluded.last_validated_at
  `).run(
    record.address,
    record.profileName ?? null,
    record.pseudonym ?? null,
    record.xUsername ?? null,
    record.verifiedBadge ? 1 : 0,
    record.tradedMarkets ?? null,
    record.openPositionsCount,
    record.closedPositionsCount,
    record.realizedPnl,
    record.realizedWinRate,
    record.makerRebateCount,
    record.tradeActivityCount,
    record.buyActivityCount,
    record.sellActivityCount,
    record.marketsTouched,
    record.rawProfile ? JSON.stringify(record.rawProfile) : null,
    record.rawPositions ? JSON.stringify(record.rawPositions) : null,
    record.rawClosedPositions ? JSON.stringify(record.rawClosedPositions) : null,
    record.rawActivity ? JSON.stringify(record.rawActivity) : null,
    record.lastValidatedAt,
  );
};

export const getWalletValidation = (address: string): DiscoveryWalletValidation | null => {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT *
    FROM discovery_wallet_validation
    WHERE address = ?
  `).get(String(address).trim().toLowerCase()) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    address: String(row.address),
    profileName: row.profile_name ? String(row.profile_name) : undefined,
    pseudonym: row.pseudonym ? String(row.pseudonym) : undefined,
    xUsername: row.x_username ? String(row.x_username) : undefined,
    verifiedBadge: Boolean(row.verified_badge),
    tradedMarkets: parseOptionalNumber(row.traded_markets),
    openPositionsCount: Number(row.open_positions_count),
    closedPositionsCount: Number(row.closed_positions_count),
    realizedPnl: Number(row.realized_pnl),
    realizedWinRate: Number(row.realized_win_rate),
    makerRebateCount: Number(row.maker_rebate_count),
    tradeActivityCount: Number(row.trade_activity_count),
    buyActivityCount: Number(row.buy_activity_count),
    sellActivityCount: Number(row.sell_activity_count),
    marketsTouched: Number(row.markets_touched),
    lastValidatedAt: Number(row.last_validated_at),
    rawProfile: row.raw_profile ? JSON.parse(String(row.raw_profile)) as Record<string, unknown> : undefined,
    rawPositions: row.raw_positions ? JSON.parse(String(row.raw_positions)) as Record<string, unknown>[] : undefined,
    rawClosedPositions: row.raw_closed_positions ? JSON.parse(String(row.raw_closed_positions)) as Record<string, unknown>[] : undefined,
    rawActivity: row.raw_activity ? JSON.parse(String(row.raw_activity)) as Record<string, unknown>[] : undefined,
  };
};
