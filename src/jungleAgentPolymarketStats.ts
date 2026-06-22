import { config } from './config.js';
import { fetchPaginatedJson } from './discovery/v3/dataApiValidator.js';

export interface JungleAgentPolymarketStats {
  address: string;
  portfolioValueUsd: number | null;
  positionsValueUsd: number | null;
  usdcBalanceUsd: number | null;
  positionCount: number;
  lifetimePnlUsd: number | null;
  roiPct: number | null;
  winRatePct: number | null;
  wins: number;
  losses: number;
  breakeven: number;
  closedPositionsCount: number;
  totalDeployedUsd: number;
  source: 'polymarket_data_api';
}

export type JungleAgentCashBalanceFetcher = (address: string) => Promise<number>;

type ClosedPositionRow = {
  realizedPnl?: number;
  avgPrice?: number;
  totalBought?: number;
};

type OpenPositionRow = {
  cashPnl?: number;
  initialValue?: number;
  size?: number;
  avgPrice?: number;
  currentValue?: number;
  curPrice?: number;
};

const DATA_API = config.polymarketDataApiUrl.replace(/\/$/, '');

const parseNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const closedPositionCostUsd = (row: ClosedPositionRow): number => {
  const avgPrice = parseNumber(row.avgPrice);
  const totalBought = parseNumber(row.totalBought);
  if (avgPrice > 0 && totalBought > 0) {
    return avgPrice * totalBought;
  }
  return 0;
};

const openPositionCostUsd = (row: OpenPositionRow): number => {
  const initialValue = parseNumber(row.initialValue);
  if (initialValue > 0) return initialValue;
  const size = parseNumber(row.size);
  const avgPrice = parseNumber(row.avgPrice);
  if (size > 0 && avgPrice > 0) return size * avgPrice;
  return 0;
};

const openPositionMarketValueUsd = (row: OpenPositionRow): number => {
  const currentValue = parseNumber(row.currentValue);
  if (currentValue > 0) return currentValue;
  const size = parseNumber(row.size);
  const curPrice = parseNumber(row.curPrice);
  if (size > 0 && curPrice >= 0) return size * curPrice;
  return 0;
};

const sumOpenPositionsValueUsd = (openRows: OpenPositionRow[]): number => (
  openRows.reduce((sum, row) => {
    const size = parseNumber(row.size);
    if (size <= 0) return sum;
    return sum + openPositionMarketValueUsd(row);
  }, 0)
);

const resolvePortfolioTotals = (
  positionsValueUsd: number | null,
  usdcBalanceUsd: number | null,
): { portfolioValueUsd: number | null; positionsValueUsd: number | null; usdcBalanceUsd: number | null } => {
  const positions = positionsValueUsd ?? 0;
  const cash = usdcBalanceUsd ?? 0;
  const hasPositions = positionsValueUsd != null;
  const hasCash = usdcBalanceUsd != null;

  if (!hasPositions && !hasCash) {
    return { portfolioValueUsd: null, positionsValueUsd: null, usdcBalanceUsd: null };
  }

  return {
    portfolioValueUsd: Math.round((positions + cash) * 100) / 100,
    positionsValueUsd: hasPositions ? Math.round(positions * 100) / 100 : null,
    usdcBalanceUsd: hasCash ? Math.round(cash * 100) / 100 : null,
  };
};

export const computeJungleAgentPolymarketStats = (
  address: string,
  closedRows: ClosedPositionRow[],
  openRows: OpenPositionRow[],
  positionsValueUsd: number | null,
  usdcBalanceUsd: number | null,
): JungleAgentPolymarketStats => {
  const normalized = address.trim().toLowerCase();

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let closedRealizedPnl = 0;
  let closedDeployed = 0;

  for (const row of closedRows) {
    const pnl = parseNumber(row.realizedPnl);
    closedRealizedPnl += pnl;
    closedDeployed += closedPositionCostUsd(row);
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;
    else breakeven += 1;
  }

  let openCashPnl = 0;
  let openDeployed = 0;
  let positionCount = 0;

  for (const row of openRows) {
    const size = parseNumber(row.size);
    if (size <= 0) continue;
    positionCount += 1;
    openCashPnl += parseNumber(row.cashPnl);
    openDeployed += openPositionCostUsd(row);
  }

  const lifetimePnlUsd = closedRealizedPnl + openCashPnl;
  const totalDeployedUsd = closedDeployed + openDeployed;
  const closedPositionsCount = closedRows.length;
  const decisiveClosed = wins + losses;
  const winRatePct = decisiveClosed > 0 ? Math.round((wins / decisiveClosed) * 1000) / 10 : null;
  const roiPct = totalDeployedUsd > 0
    ? Math.round((lifetimePnlUsd / totalDeployedUsd) * 1000) / 10
    : null;

  const portfolioTotals = resolvePortfolioTotals(positionsValueUsd, usdcBalanceUsd);

  return {
    address: normalized,
    portfolioValueUsd: portfolioTotals.portfolioValueUsd,
    positionsValueUsd: portfolioTotals.positionsValueUsd,
    usdcBalanceUsd: portfolioTotals.usdcBalanceUsd,
    positionCount,
    lifetimePnlUsd,
    roiPct,
    winRatePct,
    wins,
    losses,
    breakeven,
    closedPositionsCount,
    totalDeployedUsd: Math.round(totalDeployedUsd * 100) / 100,
    source: 'polymarket_data_api',
  };
};

export const fetchJungleAgentPolymarketStats = async (
  address: string,
  fetchImpl: typeof fetch = fetch,
  options?: { getCashBalance?: JungleAgentCashBalanceFetcher },
): Promise<JungleAgentPolymarketStats | null> => {
  const normalized = address.trim().toLowerCase();
  if (!normalized) return null;

  const cashPromise = options?.getCashBalance
    ? options.getCashBalance(normalized).catch(() => null)
    : Promise.resolve(null);

  const [closed, open, cashBalance] = await Promise.all([
    fetchPaginatedJson<ClosedPositionRow>(
      (offset, limit) => `${DATA_API}/closed-positions?user=${encodeURIComponent(normalized)}&limit=${limit}&offset=${offset}`,
      50,
      400,
      fetchImpl,
    ),
    fetchPaginatedJson<OpenPositionRow>(
      (offset, limit) => `${DATA_API}/positions?user=${encodeURIComponent(normalized)}&limit=${limit}&offset=${offset}`,
      500,
      40,
      fetchImpl,
    ),
    cashPromise,
  ]);
  if (closed.httpError || open.httpError) return null;

  let positionsValueUsd: number | null = null;
  try {
    const valueRes = await fetchImpl(`${DATA_API}/value?user=${encodeURIComponent(normalized)}`);
    if (valueRes.ok) {
      const rows = await valueRes.json() as Array<{ user?: string; value?: number }>;
      const match = Array.isArray(rows)
        ? rows.find((row) => row.user?.toLowerCase() === normalized) ?? rows[0]
        : null;
      const value = Number(match?.value);
      if (Number.isFinite(value)) positionsValueUsd = value;
    }
  } catch {
    positionsValueUsd = null;
  }

  if (positionsValueUsd == null) {
    const summed = sumOpenPositionsValueUsd(open.rows);
    positionsValueUsd = summed > 0 ? summed : 0;
  }

  const usdcBalanceUsd = typeof cashBalance === 'number' && Number.isFinite(cashBalance)
    ? cashBalance
    : null;

  return computeJungleAgentPolymarketStats(
    normalized,
    closed.rows,
    open.rows,
    positionsValueUsd,
    usdcBalanceUsd,
  );
};
