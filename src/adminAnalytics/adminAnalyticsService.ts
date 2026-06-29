import {
  dbListAppTenants,
  dbLoadExecutedPositions,
  dbLoadConfig,
  dbLoadTrackedWallets,
  getDatabase,
} from '../database.js';
import { DEFAULT_TENANT_ID } from '../tenantContext.js';
import type {
  AdminTradeRow,
  OverviewSummary,
  ResolvedTimeRange,
  TenantListRow,
  TradeMetricsFileRow,
} from './adminAnalyticsTypes.js';
import {
  discoverMetricsTenantIds,
  loadTradeMetricsForTenant,
} from './tradeMetricsLoader.js';
import {
  inferBalanceActivity,
  loadBalanceHistoryForTenant,
} from './balanceHistoryLoader.js';
import {
  bucketTrades,
  filterTradesByRange,
  mergePlatformTrades,
  sortTradesDesc,
  summarizeTrades,
  toAdminTradeRow,
  toTradeTimestampMs,
} from './tradeAnalytics.js';
import { toAdminTradingWalletDto } from './toAdminTradingWalletDto.js';
import { resolveTimeRange, tradeInRange } from './timeRange.js';
import type { TradingWallet } from '../types.js';

type TenantDirectoryRow = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  ownerEmail: string | null;
  memberCount: number;
  createdAtMs: number;
};

const loadTenantDirectory = (): TenantDirectoryRow[] => {
  const database = getDatabase();
  try {
    const tenants = dbListAppTenants();
    return tenants.map((tenant) => {
      const owner = database.prepare(`
        SELECT u.email
        FROM app_tenant_memberships m
        JOIN app_users u ON u.id = m.user_id
        WHERE m.tenant_id = ? AND m.role = 'owner'
        ORDER BY m.created_at_ms ASC
        LIMIT 1
      `).get(tenant.id) as { email: string | null } | undefined;

      const memberCountRow = database.prepare(
        'SELECT COUNT(*) AS count FROM app_tenant_memberships WHERE tenant_id = ?',
      ).get(tenant.id) as { count: number };

      const createdRow = database.prepare(
        'SELECT created_at_ms FROM app_tenants WHERE id = ? LIMIT 1',
      ).get(tenant.id) as { created_at_ms: number } | undefined;

      return {
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        ownerEmail: owner?.email ?? null,
        memberCount: memberCountRow?.count ?? 0,
        createdAtMs: createdRow?.created_at_ms ?? 0,
      };
    });
  } catch {
    return [];
  }
};

export const discoverAllTenantIds = async (): Promise<string[]> => {
  const fromDb = loadTenantDirectory().map((t) => t.tenantId);
  const fromMetrics = await discoverMetricsTenantIds();
  const fromPositions = dbLoadExecutedPositions().map((p) => (p as { tenant_id?: string }).tenant_id ?? DEFAULT_TENANT_ID);
  return [...new Set([...fromDb, ...fromMetrics, ...fromPositions, DEFAULT_TENANT_ID])];
};

const countActiveTrackedWallets = (tenantId: string): number => (
  dbLoadTrackedWallets(tenantId).filter((w) => w.active).length
);

const loadAllMetricsByTenant = async (
  tenantIds: string[],
): Promise<Map<string, TradeMetricsFileRow[]>> => {
  const map = new Map<string, TradeMetricsFileRow[]>();
  for (const tenantId of tenantIds) {
    map.set(tenantId, await loadTradeMetricsForTenant(tenantId));
  }
  return map;
};

const findPositionEnrichment = (tenantId: string, trade: AdminTradeRow) => {
  const positions = dbLoadExecutedPositions(tenantId);
  const match = positions.find((p) => {
    if (trade.orderId && p.orderId && p.orderId === trade.orderId) {
      return true;
    }
    const delta = Math.abs(p.timestamp - toTradeTimestampMs(trade.timestamp));
    return p.walletAddress.toLowerCase() === trade.sourceWallet.toLowerCase()
      && p.marketId === trade.marketId
      && delta < 5 * 60 * 1000;
  });

  if (!match) {
    return undefined;
  }

  return {
    positionKey: match.positionKey ?? null,
    baselinePositionSize: match.baselinePositionSize ?? null,
    tradeSideAction: match.tradeSideAction ?? null,
  };
};

export class AdminAnalyticsService {
  resolveTimeRange = resolveTimeRange;

  async getOverview(query: { range?: unknown; from?: unknown; to?: unknown }) {
    const range = resolveTimeRange(query);
    const tenantIds = await discoverAllTenantIds();
    const metricsByTenant = await loadAllMetricsByTenant(tenantIds);

    let walletsTracked = 0;
    const allInRange: TradeMetricsFileRow[] = [];
    let activeAccounts = 0;

    for (const tenantId of tenantIds) {
      const tracked = countActiveTrackedWallets(tenantId);
      walletsTracked += tracked;
      const tenantTrades = metricsByTenant.get(tenantId) ?? [];
      const inRange = filterTradesByRange(tenantTrades, range);
      if (inRange.length > 0 || tracked > 0) {
        activeAccounts += 1;
      }
      allInRange.push(...inRange);
    }

    const summary = summarizeTrades(allInRange, walletsTracked);
    summary.activeAccounts = activeAccounts;

    const series = bucketTrades(allInRange, range);

    return {
      range,
      summary,
      series,
    };
  }

  async listTenants(query: {
    search?: string;
    page?: unknown;
    limit?: unknown;
    range?: unknown;
    from?: unknown;
    to?: unknown;
    sort?: string;
  }) {
    const range = resolveTimeRange(query);
    const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(query.limit ?? '50'), 10) || 50));
    const search = (typeof query.search === 'string' ? query.search : '').trim().toLowerCase();

    const directory = loadTenantDirectory();
    const metricsByTenant = await loadAllMetricsByTenant(directory.map((t) => t.tenantId));

    let rows: TenantListRow[] = directory.map((tenant) => {
      const allTrades = metricsByTenant.get(tenant.tenantId) ?? [];
      const inRange = filterTradesByRange(allTrades, range);
      const summary = summarizeTrades(allTrades, countActiveTrackedWallets(tenant.tenantId));

      return {
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantName,
        tenantSlug: tenant.tenantSlug,
        ownerEmail: tenant.ownerEmail,
        memberCount: tenant.memberCount,
        createdAt: new Date(tenant.createdAtMs).toISOString(),
        metrics: {
          totalTrades: summary.totalTrades,
          successRate: summary.successRate,
          averageLatencyMs: summary.averageLatencyMs,
          walletsTracked: summary.walletsTracked,
          tradesInRange: inRange.length,
          tradesLast24h: summary.tradesLast24h,
          tradesLast7d: summary.tradesLast7d,
        },
      };
    });

    if (search) {
      rows = rows.filter((row) => (
        row.tenantId.toLowerCase().includes(search)
        || row.tenantName.toLowerCase().includes(search)
        || (row.ownerEmail ?? '').toLowerCase().includes(search)
        || row.tenantSlug.toLowerCase().includes(search)
      ));
    }

    const sort = query.sort ?? 'trades';
    rows.sort((a, b) => {
      switch (sort) {
        case 'name':
          return a.tenantName.localeCompare(b.tenantName);
        case 'successRate':
          return b.metrics.successRate - a.metrics.successRate;
        case 'created':
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'trades':
        default:
          return b.metrics.tradesInRange - a.metrics.tradesInRange;
      }
    });

    const total = rows.length;
    const offset = (page - 1) * limit;
    const tenants = rows.slice(offset, offset + limit);

    return {
      range,
      pagination: { page, limit, total },
      tenants,
    };
  }

  async getTenantDetail(tenantId: string, query: { range?: unknown; from?: unknown; to?: unknown }) {
    const range = resolveTimeRange(query);
    const directory = loadTenantDirectory().find((t) => t.tenantId === tenantId);
    if (!directory) {
      return null;
    }

    const allTrades = await loadTradeMetricsForTenant(tenantId);
    const inRange = filterTradesByRange(allTrades, range);
    const summary = summarizeTrades(allTrades, countActiveTrackedWallets(tenantId));

    const ownerEmails = (() => {
      const database = getDatabase();
      const rows = database.prepare(`
        SELECT u.email
        FROM app_tenant_memberships m
        JOIN app_users u ON u.id = m.user_id
        WHERE m.tenant_id = ? AND m.role = 'owner'
        ORDER BY m.created_at_ms ASC
      `).all(tenantId) as { email: string | null }[];
      return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
    })();

    return {
      tenantId: directory.tenantId,
      tenantName: directory.tenantName,
      tenantSlug: directory.tenantSlug,
      ownerEmail: directory.ownerEmail,
      ownerEmails,
      memberCount: directory.memberCount,
      createdAt: new Date(directory.createdAtMs).toISOString(),
      metrics: {
        ...summary,
        tradesInRange: inRange.length,
      },
      series: bucketTrades(inRange, range),
    };
  }

  async getTrackedWallets(tenantId: string, query: { range?: unknown; from?: unknown; to?: unknown }) {
    const range = resolveTimeRange(query);
    const wallets = dbLoadTrackedWallets(tenantId);
    const trades = await loadTradeMetricsForTenant(tenantId);

    return wallets.map((wallet) => {
      const walletTrades = trades.filter(
        (t) => t.walletAddress.toLowerCase() === wallet.address.toLowerCase(),
      );
      const inRange = walletTrades.filter((t) => tradeInRange(toTradeTimestampMs(t.timestamp), range));
      const sorted = sortTradesDesc(walletTrades);
      const lastTrade = sorted[0];

      const sizingSummary = wallet.tradeSizingMode
        ? `${wallet.tradeSizingMode}${wallet.fixedTradeSize != null ? ` (${wallet.fixedTradeSize})` : ''}`
        : 'default';

      return {
        address: wallet.address,
        label: wallet.label ?? null,
        active: wallet.active,
        tags: wallet.tags ?? [],
        tradeSizingMode: wallet.tradeSizingMode ?? null,
        sizingSummary,
        fixedTradeSize: wallet.fixedTradeSize ?? null,
        thresholdEnabled: wallet.thresholdEnabled ?? null,
        thresholdPercent: wallet.thresholdPercent ?? null,
        tradeSideFilter: wallet.tradeSideFilter ?? null,
        lastSeen: wallet.lastSeen ? wallet.lastSeen.toISOString() : null,
        addedAt: wallet.addedAt.toISOString(),
        tradesInRange: inRange.length,
        lastTradeAt: lastTrade ? new Date(lastTrade.timestamp).toISOString() : null,
      };
    });
  }

  getTradingWallets(tenantId: string) {
    const cfg = dbLoadConfig(tenantId);
    const wallets = (cfg.tradingWallets ?? []) as TradingWallet[];
    return wallets.map(toAdminTradingWalletDto);
  }

  async getTrades(
    tenantId: string,
    query: {
      page?: unknown;
      limit?: unknown;
      from?: unknown;
      to?: unknown;
      range?: unknown;
      status?: string;
      side?: string;
      market?: string;
      sourceWallet?: string;
      search?: string;
    },
  ) {
    const range = resolveTimeRange(query);
    const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(query.limit ?? '50'), 10) || 50));

    let trades = filterTradesByRange(await loadTradeMetricsForTenant(tenantId), range);

    if (query.status) {
      const status = query.status.toLowerCase();
      trades = trades.filter((t) => (t.status ?? '').toLowerCase() === status);
    }
    if (query.side) {
      const side = query.side.toLowerCase();
      trades = trades.filter((t) => (t.outcome ?? '').toLowerCase().includes(side) || (t.tradeSideAction ?? '').toLowerCase() === side);
    }
    if (query.market) {
      const market = query.market.toLowerCase();
      trades = trades.filter((t) => (
        t.marketId.toLowerCase().includes(market)
        || (t.marketTitle ?? '').toLowerCase().includes(market)
        || (t.marketName ?? '').toLowerCase().includes(market)
      ));
    }
    if (query.sourceWallet) {
      const wallet = query.sourceWallet.toLowerCase();
      trades = trades.filter((t) => t.walletAddress.toLowerCase().includes(wallet));
    }
    if (query.search) {
      const term = query.search.toLowerCase();
      trades = trades.filter((t) => (
        t.marketId.toLowerCase().includes(term)
        || (t.marketTitle ?? '').toLowerCase().includes(term)
        || (t.walletAddress ?? '').toLowerCase().includes(term)
        || (t.error ?? '').toLowerCase().includes(term)
      ));
    }

    trades = sortTradesDesc(trades);
    const total = trades.length;
    const offset = (page - 1) * limit;
    const pageRows = trades.slice(offset, offset + limit).map(toAdminTradeRow);

    return {
      range,
      pagination: { page, limit, total },
      trades: pageRows,
    };
  }

  async getTradeDetail(tenantId: string, tradeId: string) {
    const trades = await loadTradeMetricsForTenant(tenantId);
    const trade = trades.find((t) => t.id === tradeId);
    if (!trade) {
      return null;
    }
    const row = toAdminTradeRow(trade);
    const position = findPositionEnrichment(tenantId, row);
    if (position?.tradeSideAction && !row.side) {
      row.side = position.tradeSideAction;
    }
    return {
      trade: {
        ...row,
        position,
      },
    };
  }

  async getBalances(
    tenantId: string,
    query: { range?: unknown; from?: unknown; to?: unknown; walletId?: string },
  ) {
    const range = resolveTimeRange(query);
    const history = await loadBalanceHistoryForTenant(tenantId);
    const tradingWallets = this.getTradingWallets(tenantId);
    const filteredWallets = query.walletId
      ? tradingWallets.filter((w) => w.id === query.walletId)
      : tradingWallets;

    const wallets = filteredWallets.map((wallet) => {
      const fundsAddress = (wallet.polymarketFunderAddress ?? wallet.proxyAddress ?? wallet.address).toLowerCase();
      const walletHistory = history.get(wallet.address.toLowerCase())
        ?? history.get(fundsAddress)
        ?? { address: wallet.address, snapshots: [] };

      const snapshots = walletHistory.snapshots.filter((s) => tradeInRange(s.timestamp.getTime(), range));
      const series = snapshots.map((s) => ({
        timestamp: s.timestamp.toISOString(),
        balance: s.balance,
      }));

      const currentBalanceUsd = series.length > 0 ? series[series.length - 1].balance : 0;
      const first = series[0]?.balance ?? currentBalanceUsd;
      const change24hPercent = first > 0
        ? Math.round(((currentBalanceUsd - first) / first) * 10000) / 100
        : 0;

      return {
        id: wallet.id,
        address: wallet.address,
        label: wallet.label,
        proxyAddress: wallet.proxyAddress,
        currentBalanceUsd,
        change24hPercent,
        series,
        inferredActivity: inferBalanceActivity(
          snapshots.map((s) => ({ timestamp: new Date(s.timestamp), balance: s.balance })),
        ),
        historyNote: `History: last ${range.preset === 'all' ? 'available' : range.preset} · deposits inferred from balance changes`,
      };
    });

    return {
      range,
      retentionDays: 30,
      wallets,
    };
  }

  async collectTradesForExport(query: {
    tenantId?: string;
    range?: unknown;
    from?: unknown;
    to?: unknown;
    status?: string;
    search?: string;
    maxRows?: number;
  }) {
    const range = resolveTimeRange(query);
    const maxRows = query.maxRows ?? 100_000;
    const directory = loadTenantDirectory();
    const tenantFilter = query.tenantId;

    const tenants = tenantFilter
      ? directory.filter((t) => t.tenantId === tenantFilter)
      : directory;

    const rows: Array<AdminTradeRow & {
      tenantId: string;
      tenantName: string;
      ownerEmail: string | null;
    }> = [];

    for (const tenant of tenants) {
      let trades = filterTradesByRange(await loadTradeMetricsForTenant(tenant.tenantId), range);
      if (query.status) {
        const status = query.status.toLowerCase();
        trades = trades.filter((t) => (t.status ?? '').toLowerCase() === status);
      }
      if (query.search) {
        const term = query.search.toLowerCase();
        trades = trades.filter((t) => (
          t.marketId.toLowerCase().includes(term)
          || (t.marketTitle ?? '').toLowerCase().includes(term)
        ));
      }

      for (const trade of sortTradesDesc(trades)) {
        rows.push({
          ...toAdminTradeRow(trade),
          tenantId: tenant.tenantId,
          tenantName: tenant.tenantName,
          ownerEmail: tenant.ownerEmail,
        });
        if (rows.length >= maxRows) {
          return { rows, truncated: true, range };
        }
      }
    }

    return { rows, truncated: false, range };
  }

  /** Backward-compatible platform stats for /admin/system-stats */
  async getLegacyPlatformStats() {
    const overview = await this.getOverview({ range: 'all' });
    const tenantList = await this.listTenants({ range: 'all', limit: 500, page: 1 });

    return {
      totalTrades: overview.summary.totalTrades,
      successfulTrades: overview.summary.successfulTrades,
      failedTrades: overview.summary.failedTrades,
      successRate: overview.summary.successRate,
      averageLatencyMs: overview.summary.averageLatencyMs,
      walletsTracked: overview.summary.walletsTracked,
      activeAccounts: overview.summary.activeAccounts,
      tradesLast24h: overview.summary.tradesLast24h,
      tenants: tenantList.tenants.map((t) => ({
        tenantId: t.tenantId,
        tenantName: t.tenantName,
        totalTrades: t.metrics.totalTrades,
        successfulTrades: 0,
        failedTrades: 0,
        successRate: t.metrics.successRate,
        averageLatencyMs: t.metrics.averageLatencyMs,
        walletsTracked: t.metrics.walletsTracked,
        tradesLast24h: t.metrics.tradesLast24h,
      })),
    };
  }
}

export const adminAnalyticsService = new AdminAnalyticsService();
