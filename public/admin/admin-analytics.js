/**
 * Platform admin — cross-tenant analytics dashboard.
 */
(() => {
  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const state = {
    range: '7d',
    customFrom: '',
    customTo: '',
    tenantId: null,
    tradesPage: 1,
    tradesLimit: 50,
    tenantSearch: '',
    tradeFilters: { status: '', market: '', sourceWallet: '' },
    charts: {},
  };

  const rangeQuery = () => {
    const params = { range: state.range };
    if (state.customFrom && state.customTo) {
      params.from = new Date(`${state.customFrom}T00:00:00.000Z`).toISOString();
      params.to = new Date(`${state.customTo}T23:59:59.999Z`).toISOString();
    }
    return params;
  };

  const showError = (message) => {
    const el = document.getElementById('adminAnalyticsError');
    if (!el) return;
    if (!message) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
  };

  const setRangeButtons = () => {
    document.querySelectorAll('.j-admin-range-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-range') === state.range && !state.customFrom);
    });
  };

  const destroyChart = (key) => {
    if (state.charts[key]) {
      state.charts[key].destroy();
      delete state.charts[key];
    }
  };

  const renderLineChart = (containerId, labels, series, chartKey, yLabel = '') => {
    const container = document.getElementById(containerId);
    if (!container || typeof uPlot === 'undefined') return;
    destroyChart(chartKey);
    container.innerHTML = '';
    if (!labels.length) {
      container.innerHTML = '<p class="text-muted">No data in this period.</p>';
      return;
    }
    const xs = labels.map((l) => Math.floor(new Date(l).getTime() / 1000));
    const data = [xs, ...series];
    const width = container.clientWidth || 600;
    state.charts[chartKey] = new uPlot({
      width,
      height: 220,
      series: [
        {},
        ...series.map((_, i) => ({
          label: yLabel || `Series ${i + 1}`,
          stroke: i === 0 ? '#c9a227' : '#6b9bd1',
          width: 2,
        })),
      ],
      axes: [
        { stroke: '#888' },
        { stroke: '#888' },
      ],
      scales: { x: { time: true } },
    }, data, container);
  };

  const renderOverviewCharts = (series) => {
    const buckets = series?.tradesByBucket ?? [];
    const labels = buckets.map((b) => b.bucketStart);
    renderLineChart(
      'adminChartTrades',
      labels,
      [buckets.map((b) => b.total)],
      'overviewTrades',
      'Trades',
    );
    renderLineChart(
      'adminChartSuccess',
      labels,
      [(series?.successRateByBucket ?? []).map((b) => b.rate)],
      'overviewSuccess',
      'Success %',
    );
    renderLineChart(
      'adminChartVolume',
      labels,
      [(series?.volumeByBucket ?? []).map((b) => b.notionalUsd)],
      'overviewVolume',
      'USD',
    );
  };

  const renderTenantCharts = (series) => {
    const buckets = series?.tradesByBucket ?? [];
    const labels = buckets.map((b) => b.bucketStart);
    renderLineChart('adminChartTenantTrades', labels, [buckets.map((b) => b.total)], 'tenantTrades', 'Trades');
    renderLineChart(
      'adminChartTenantSuccess',
      labels,
      [(series?.successRateByBucket ?? []).map((b) => b.rate)],
      'tenantSuccess',
      'Success %',
    );
  };

  const renderSummaryCards = (summary) => {
    const el = document.getElementById('adminAnalyticsCards');
    if (!el || !summary) return;
    const cards = [
      ['Total trades', summary.totalTrades],
      ['Success rate', `${(summary.successRate || 0).toFixed(1)}%`],
      ['Avg latency', `${Math.round(summary.averageLatencyMs || 0)}ms`],
      ['Active accounts', summary.activeAccounts],
      ['Wallets tracked', summary.walletsTracked],
      ['Trades 24h', summary.tradesLast24h],
      ['Trades 7d', summary.tradesLast7d],
      ['Trades 30d', summary.tradesLast30d],
    ];
    el.innerHTML = cards.map(([label, value]) => `
      <div class="j-admin-analytics-card">
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(value)}</dd>
      </div>
    `).join('');
  };

  const renderTenantTable = (tenants) => {
    const tbody = document.getElementById('adminAnalyticsTenantsBody');
    if (!tbody) return;
    if (!tenants.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-muted">No accounts match your search.</td></tr>';
      return;
    }
    tbody.innerHTML = tenants.map((t) => `
      <tr class="j-admin-analytics-tenant-row" tabindex="0" role="button" data-tenant-id="${escapeHtml(t.tenantId)}" aria-label="Open ${escapeHtml(t.tenantName)}">
        <td>${escapeHtml(t.ownerEmail || '—')}</td>
        <td>${escapeHtml(t.tenantName)}</td>
        <td class="text-mono">${escapeHtml(t.tenantId)}</td>
        <td>${t.metrics?.tradesInRange ?? 0}</td>
        <td>${(t.metrics?.successRate ?? 0).toFixed(1)}%</td>
        <td>${Math.round(t.metrics?.averageLatencyMs ?? 0)}ms</td>
        <td>${t.metrics?.walletsTracked ?? 0}</td>
        <td>${t.metrics?.tradesLast24h ?? 0}</td>
        <td>${t.metrics?.tradesLast7d ?? 0}</td>
      </tr>
    `).join('');
  };

  const loadOverview = async () => {
    showError('');
    const data = await API.getAdminAnalyticsOverview(rangeQuery());
    if (!data.success) throw new Error(data.error || 'Failed to load overview');
    renderSummaryCards(data.summary);
    renderOverviewCharts(data.series);
    const tenants = await API.getAdminAnalyticsTenants({
      ...rangeQuery(),
      search: state.tenantSearch,
      limit: 200,
      page: 1,
    });
    if (!tenants.success) throw new Error(tenants.error || 'Failed to load tenants');
    renderTenantTable(tenants.tenants || []);
    const meta = document.getElementById('adminAnalyticsMeta');
    if (meta && data.range) {
      meta.textContent = `Showing ${data.range.preset === 'custom' ? 'custom range' : data.range.preset} · ${new Date(data.range.from).toLocaleDateString()} – ${new Date(data.range.to).toLocaleDateString()}`;
    }
  };

  const renderTenantHeader = (tenant) => {
    const el = document.getElementById('adminAnalyticsTenantHeader');
    if (!el) return;
    el.innerHTML = `
      <h2 class="j-admin-health-card-title">${escapeHtml(tenant.tenantName)}</h2>
      <dl class="j-admin-health-metrics">
        <div><dt>Email</dt><dd>${escapeHtml(tenant.ownerEmail || (tenant.ownerEmails || []).join(', ') || '—')}</dd></div>
        <div><dt>Tenant ID</dt><dd class="text-mono">${escapeHtml(tenant.tenantId)}</dd></div>
        <div><dt>Slug</dt><dd>${escapeHtml(tenant.tenantSlug)}</dd></div>
        <div><dt>Members</dt><dd>${tenant.memberCount ?? 0}</dd></div>
        <div><dt>Created</dt><dd>${tenant.createdAt ? new Date(tenant.createdAt).toLocaleString() : '—'}</dd></div>
        <div><dt>Trades in range</dt><dd>${tenant.metrics?.tradesInRange ?? 0}</dd></div>
        <div><dt>Success</dt><dd>${(tenant.metrics?.successRate ?? 0).toFixed(1)}%</dd></div>
      </dl>
    `;
  };

  const renderTrackedWallets = (wallets) => {
    const tbody = document.getElementById('adminAnalyticsTrackedBody');
    if (!tbody) return;
    tbody.innerHTML = (wallets || []).map((w) => `
      <tr>
        <td class="text-mono">${escapeHtml(w.address)}</td>
        <td>${escapeHtml(w.label || '—')}</td>
        <td>${w.active ? 'Yes' : 'No'}</td>
        <td>${escapeHtml(w.sizingSummary || '—')}</td>
        <td>${escapeHtml((w.tags || []).join(', ') || '—')}</td>
        <td>${w.tradesInRange ?? 0}</td>
        <td>${w.lastTradeAt ? new Date(w.lastTradeAt).toLocaleString() : '—'}</td>
      </tr>
    `).join('') || '<tr><td colspan="7" class="text-muted">No tracked wallets.</td></tr>';
  };

  const renderTradingWallets = (wallets) => {
    const tbody = document.getElementById('adminAnalyticsTradingBody');
    if (!tbody) return;
    tbody.innerHTML = (wallets || []).map((w) => `
      <tr>
        <td>${escapeHtml(w.label)}</td>
        <td class="text-mono">${escapeHtml(w.address)}</td>
        <td class="text-mono">${escapeHtml(w.proxyAddress || '—')}</td>
        <td>${w.isActive ? 'Yes' : 'No'}</td>
        <td>${w.hasCredentials ? 'Yes' : 'No'}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="text-muted">No trading wallets.</td></tr>';
  };

  const renderTradesTable = (trades, pagination) => {
    const tbody = document.getElementById('adminAnalyticsTradesBody');
    if (!tbody) return;
    tbody.innerHTML = (trades || []).map((t) => `
      <tr class="j-admin-trade-row" tabindex="0" role="button" data-trade-id="${escapeHtml(t.id)}" data-tenant-id="${escapeHtml(state.tenantId)}">
        <td>${new Date(t.timestamp).toLocaleString()}</td>
        <td>${escapeHtml(t.marketTitle || t.marketId)}</td>
        <td>${escapeHtml(t.side || t.outcome || '—')}</td>
        <td>${escapeHtml(t.amount)} @ ${escapeHtml(t.price)}</td>
        <td>${escapeHtml(t.status)}</td>
        <td class="text-mono">${escapeHtml(t.sourceWalletLabel || t.sourceWallet)}</td>
        <td>${t.executionTimeMs ?? 0}ms</td>
        <td>${escapeHtml(t.error || '—')}</td>
      </tr>
    `).join('') || '<tr><td colspan="8" class="text-muted">No trades in this period.</td></tr>';

    const pageLabel = document.getElementById('adminTradesPageLabel');
    const prev = document.getElementById('adminTradesPrevBtn');
    const next = document.getElementById('adminTradesNextBtn');
    const page = pagination?.page ?? 1;
    const total = pagination?.total ?? 0;
    const limit = pagination?.limit ?? state.tradesLimit;
    const maxPage = Math.max(1, Math.ceil(total / limit));
    if (pageLabel) pageLabel.textContent = `Page ${page} of ${maxPage} (${total} trades)`;
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= maxPage;
  };

  const renderBalancePanel = (data) => {
    const grid = document.getElementById('adminAnalyticsBalanceCharts');
    const note = document.getElementById('adminAnalyticsBalanceNote');
    if (note) {
      note.textContent = `History: last ${data.retentionDays ?? 30} days · deposits inferred from balance changes`;
    }
    if (!grid) return;
    grid.innerHTML = '';
    (data.wallets || []).forEach((wallet, index) => {
      const card = document.createElement('div');
      card.className = 'j-card j-admin-health-card glow-border';
      card.innerHTML = `
        <h3 class="j-admin-health-card-title">${escapeHtml(wallet.label)}</h3>
        <p class="text-muted">Balance: $${Number(wallet.currentBalanceUsd || 0).toFixed(2)} · 24h change: ${wallet.change24hPercent ?? 0}%</p>
        <div id="adminBalanceChart-${index}" class="j-admin-chart"></div>
        <ul class="j-admin-activity-list">${(wallet.inferredActivity || []).slice(-5).map((a) => `
          <li>${new Date(a.timestamp).toLocaleString()} — ${escapeHtml(a.type)} $${a.deltaUsd}</li>
        `).join('') || '<li class="text-muted">No inferred activity in range.</li>'}</ul>
      `;
      grid.appendChild(card);
      const labels = (wallet.series || []).map((s) => s.timestamp);
      renderLineChart(`adminBalanceChart-${index}`, labels, [(wallet.series || []).map((s) => s.balance)], `balance-${index}`, 'USD');
    });
    if (!(data.wallets || []).length) {
      grid.innerHTML = '<p class="text-muted">No balance history available for this account yet.</p>';
    }
  };

  const loadTenantDetail = async (tenantId) => {
    showError('');
    state.tenantId = tenantId;
    const [detail, tracked, trading, trades, balances] = await Promise.all([
      API.getAdminAnalyticsTenant(tenantId, rangeQuery()),
      API.getAdminAnalyticsTrackedWallets(tenantId, rangeQuery()),
      API.getAdminAnalyticsTradingWallets(tenantId),
      API.getAdminAnalyticsTenantTrades(tenantId, {
        ...rangeQuery(),
        page: state.tradesPage,
        limit: state.tradesLimit,
        status: state.tradeFilters.status || undefined,
        market: state.tradeFilters.market || undefined,
        sourceWallet: state.tradeFilters.sourceWallet || undefined,
      }),
      API.getAdminAnalyticsBalances(tenantId, rangeQuery()),
    ]);

    if (!detail.success) throw new Error(detail.error || 'Tenant not found');
    renderTenantHeader(detail.tenant);
    renderTenantCharts(detail.tenant.series);
    renderTrackedWallets(tracked.wallets);
    renderTradingWallets(trading.wallets);
    renderTradesTable(trades.trades, trades.pagination);
    renderBalancePanel(balances);

    document.getElementById('adminAnalyticsOverview')?.classList.add('hidden');
    document.getElementById('adminAnalyticsTenantDetail')?.classList.remove('hidden');
    document.getElementById('adminAnalyticsBackBtn')?.classList.remove('hidden');
    document.getElementById('adminAnalyticsExportBtn')?.classList.remove('hidden');
    document.getElementById('adminAnalyticsPlatformExportBtn')?.classList.add('hidden');
    const title = document.getElementById('adminAnalyticsTitle');
    if (title) title.textContent = detail.tenant.tenantName;
    window.location.hash = `analytics/tenant/${tenantId}`;
  };

  const showOverviewView = async () => {
    state.tenantId = null;
    state.tradesPage = 1;
    document.getElementById('adminAnalyticsOverview')?.classList.remove('hidden');
    document.getElementById('adminAnalyticsTenantDetail')?.classList.add('hidden');
    document.getElementById('adminAnalyticsBackBtn')?.classList.add('hidden');
    document.getElementById('adminAnalyticsExportBtn')?.classList.add('hidden');
    document.getElementById('adminAnalyticsPlatformExportBtn')?.classList.remove('hidden');
    const title = document.getElementById('adminAnalyticsTitle');
    if (title) title.textContent = 'Analytics';
    window.location.hash = 'analytics';
    await loadOverview();
  };

  const SAFE_TRADE_DETAIL_KEYS = [
    'id', 'timestamp', 'marketId', 'marketTitle', 'outcome', 'side', 'amount', 'price',
    'notionalUsd', 'status', 'success', 'sourceWallet', 'sourceWalletLabel',
    'executionTimeMs', 'error', 'orderId', 'detectedTxHash', 'tokenId',
  ];

  const openTradeModal = async (tenantId, tradeId) => {
    const data = await API.getAdminAnalyticsTrade(tenantId, tradeId);
    if (!data.success) {
      showError(data.error || 'Could not load trade');
      return;
    }
    const trade = data.trade || {};
    const body = document.getElementById('adminTradeDetailBody');
    if (!body) return;
    body.innerHTML = SAFE_TRADE_DETAIL_KEYS.map((key) => `
      <div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(trade[key] ?? '—')}</dd></div>
    `).join('');
    if (trade.position) {
      body.innerHTML += `
        <div><dt>positionKey</dt><dd>${escapeHtml(trade.position.positionKey || '—')}</dd></div>
        <div><dt>baselinePositionSize</dt><dd>${escapeHtml(trade.position.baselinePositionSize ?? '—')}</dd></div>
      `;
    }
    document.getElementById('adminTradeDetailModal')?.showModal();
  };

  const buildExportUrl = (tenantId) => {
    const params = new URLSearchParams({ range: state.range });
    if (state.customFrom && state.customTo) {
      params.set('from', new Date(`${state.customFrom}T00:00:00.000Z`).toISOString());
      params.set('to', new Date(`${state.customTo}T23:59:59.999Z`).toISOString());
    }
    if (state.tradeFilters.status) params.set('status', state.tradeFilters.status);
    const base = tenantId
      ? `/api/admin/analytics/tenants/${encodeURIComponent(tenantId)}/trades/export.csv`
      : '/api/admin/analytics/trades/export.csv';
    return `${base}?${params.toString()}`;
  };

  const wireEvents = () => {
    document.querySelectorAll('.j-admin-range-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.range = btn.getAttribute('data-range') || '7d';
        state.customFrom = '';
        state.customTo = '';
        setRangeButtons();
        void refresh();
      });
    });

    document.getElementById('adminAnalyticsApplyRangeBtn')?.addEventListener('click', () => {
      state.customFrom = document.getElementById('adminAnalyticsFrom')?.value || '';
      state.customTo = document.getElementById('adminAnalyticsTo')?.value || '';
      if (state.customFrom && state.customTo) {
        state.range = 'all';
        setRangeButtons();
      }
      void refresh();
    });

    document.getElementById('adminAnalyticsRefreshBtn')?.addEventListener('click', () => refresh().catch(handleErr));
    document.getElementById('adminAnalyticsBackBtn')?.addEventListener('click', () => showOverviewView().catch(handleErr));
    document.getElementById('adminAnalyticsTenantSearch')?.addEventListener('input', (e) => {
      state.tenantSearch = e.target.value.trim();
      void loadOverview().catch(handleErr);
    });

    document.getElementById('adminAnalyticsTenantsBody')?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-tenant-id]');
      if (!row) return;
      void loadTenantDetail(row.getAttribute('data-tenant-id')).catch(handleErr);
    });
    document.getElementById('adminAnalyticsTenantsBody')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('[data-tenant-id]');
      if (!row) return;
      e.preventDefault();
      void loadTenantDetail(row.getAttribute('data-tenant-id')).catch(handleErr);
    });

    document.getElementById('adminAnalyticsTradesBody')?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-trade-id]');
      if (!row) return;
      void openTradeModal(row.getAttribute('data-tenant-id'), row.getAttribute('data-trade-id'));
    });

    document.getElementById('adminTradeFilterApplyBtn')?.addEventListener('click', () => {
      state.tradeFilters.status = document.getElementById('adminTradeFilterStatus')?.value || '';
      state.tradeFilters.market = document.getElementById('adminTradeFilterMarket')?.value.trim() || '';
      state.tradeFilters.sourceWallet = document.getElementById('adminTradeFilterWallet')?.value.trim() || '';
      state.tradesPage = 1;
      if (state.tenantId) void loadTenantDetail(state.tenantId).catch(handleErr);
    });

    document.getElementById('adminTradesPrevBtn')?.addEventListener('click', () => {
      state.tradesPage = Math.max(1, state.tradesPage - 1);
      if (state.tenantId) void loadTenantDetail(state.tenantId).catch(handleErr);
    });
    document.getElementById('adminTradesNextBtn')?.addEventListener('click', () => {
      state.tradesPage += 1;
      if (state.tenantId) void loadTenantDetail(state.tenantId).catch(handleErr);
    });

    document.getElementById('adminAnalyticsExportBtn')?.addEventListener('click', () => {
      if (!state.tenantId) return;
      window.location.href = buildExportUrl(state.tenantId);
    });
    document.getElementById('adminAnalyticsPlatformExportBtn')?.addEventListener('click', () => {
      window.location.href = buildExportUrl(null);
    });
  };

  const handleErr = (error) => {
    showError(error?.message || 'Something went wrong');
  };

  const refresh = async () => {
    if (state.tenantId) {
      await loadTenantDetail(state.tenantId);
    } else {
      await loadOverview();
    }
  };

  const parseHash = () => {
    const hash = window.location.hash.replace(/^#/, '');
    const match = hash.match(/^analytics\/tenant\/([^/]+)/);
    return match ? match[1] : null;
  };

  const show = async () => {
    document.getElementById('adminLoading')?.classList.add('hidden');
    document.getElementById('adminUnauthorized')?.classList.add('hidden');
    document.getElementById('adminApp')?.classList.add('hidden');
    document.getElementById('adminHealth')?.classList.add('hidden');
    document.getElementById('adminComingSoon')?.classList.add('hidden');
    document.getElementById('adminAnalytics')?.classList.remove('hidden');
    setRangeButtons();
    const tenantFromHash = parseHash();
    if (tenantFromHash) {
      await loadTenantDetail(tenantFromHash);
    } else {
      await showOverviewView();
    }
  };

  window.AdminAnalytics = { show, refresh, wireEvents };

  document.addEventListener('DOMContentLoaded', () => {
    wireEvents();
  });
})();
