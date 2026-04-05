/**
 * Ditto - Main Application Logic
 * Jungle-styled Polymarket prediction agent dashboard
 */

// Global state
let currentTab = 'dashboard';
let refreshInterval = null;
let botRunning = false;
let setupGuideState = null;
let setupGuideAction = 'dashboard';

const SETUP_GUIDE_COMPLETED_KEY = 'ditto_setup_completed_v1';
const SETUP_GUIDE_SESSION_DISMISS_KEY = 'ditto_setup_dismissed_session_v1';

// ============================================================
// WIN95 DIALOG SYSTEM (replaces native alert/confirm/prompt)
// ============================================================

const win95Dialog = (() => {
  let container = null;

  const ensureContainer = () => {
    if (container) return container;
    container = document.createElement('div');
    container.id = 'win95DialogContainer';
    document.body.appendChild(container);
    return container;
  };

  const createOverlay = () => {
    const overlay = document.createElement('div');
    overlay.className = 'win-modal-overlay';
    overlay.style.zIndex = '9999';
    return overlay;
  };

  const createDialog = (title, bodyHtml, buttons) => {
    return new Promise((resolve) => {
      const overlay = createOverlay();
      const modal = document.createElement('div');
      modal.className = 'win-modal';
      modal.style.maxWidth = '440px';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-label', title);

      const titleBar = document.createElement('div');
      titleBar.className = 'win-title-bar';
      titleBar.innerHTML = `
        <span class="win-title-bar-text">${title}</span>
        <div class="win-title-bar-controls">
          <button class="win-title-bar-btn" aria-label="Close" data-action="close">&times;</button>
        </div>`;

      const body = document.createElement('div');
      body.className = 'win-modal-body';
      body.style.padding = '16px';
      body.innerHTML = bodyHtml;

      const footer = document.createElement('div');
      footer.className = 'win-modal-footer';

      let resolved = false;
      const close = (value) => {
        if (resolved) return;
        resolved = true;
        overlay.remove();
        resolve(value);
      };

      titleBar.querySelector('[data-action="close"]').addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

      buttons.forEach((btn, i) => {
        const button = document.createElement('button');
        button.className = 'win-btn';
        button.textContent = btn.label;
        button.style.minWidth = '80px';
        if (btn.primary) button.style.fontWeight = 'bold';
        button.addEventListener('click', () => close(btn.value));
        if (i === 0) setTimeout(() => button.focus(), 50);
        footer.appendChild(button);
      });

      document.addEventListener('keydown', function handler(e) {
        if (resolved) { document.removeEventListener('keydown', handler); return; }
        if (e.key === 'Escape') { close(null); document.removeEventListener('keydown', handler); }
        if (e.key === 'Enter') {
          const primaryBtn = buttons.find(b => b.primary);
          if (primaryBtn) close(primaryBtn.value);
          document.removeEventListener('keydown', handler);
        }
      });

      modal.appendChild(titleBar);
      modal.appendChild(body);
      modal.appendChild(footer);
      overlay.appendChild(modal);
      ensureContainer().appendChild(overlay);
    });
  };

  return {
    alert: (message, title = 'Ditto') => {
      const escaped = String(message).replace(/</g, '&lt;').replace(/\n/g, '<br>');
      return createDialog(title, `<p style="margin:0;line-height:1.5">${escaped}</p>`, [
        { label: 'OK', value: true, primary: true },
      ]);
    },

    success: (message, title = 'Success') => {
      const escaped = String(message).replace(/</g, '&lt;').replace(/\n/g, '<br>');
      return createDialog(title, `<p style="margin:0;line-height:1.5;color:var(--jungle-win)">${escaped}</p>`, [
        { label: 'OK', value: true, primary: true },
      ]);
    },

    error: (message, title = 'Error') => {
      const escaped = String(message).replace(/</g, '&lt;').replace(/\n/g, '<br>');
      return createDialog(title, `<p style="margin:0;line-height:1.5;color:var(--jungle-loss)">${escaped}</p>`, [
        { label: 'OK', value: true, primary: true },
      ]);
    },

    confirm: (message, title = 'Confirm') => {
      const escaped = String(message).replace(/</g, '&lt;').replace(/\n/g, '<br>');
      return createDialog(title, `<p style="margin:0;line-height:1.5">${escaped}</p>`, [
        { label: 'OK', value: true, primary: true },
        { label: 'Cancel', value: false },
      ]);
    },

    prompt: (message, defaultValue = '', title = 'Input') => {
      const escaped = String(message).replace(/</g, '&lt;').replace(/\n/g, '<br>');
      const inputId = 'win95PromptInput_' + Date.now();
      return createDialog(title, `
        <p style="margin:0 0 8px;line-height:1.5">${escaped}</p>
        <input id="${inputId}" class="win-input" style="width:100%;box-sizing:border-box" value="${String(defaultValue).replace(/"/g, '&quot;')}" />
      `, [
        { label: 'OK', value: '__OK__', primary: true },
        { label: 'Cancel', value: null },
      ]).then(val => {
        if (val === '__OK__') {
          const input = document.getElementById(inputId);
          return input ? input.value : defaultValue;
        }
        return null;
      });
    },
  };
})();

// ============================================================
// OIDC LOGOUT (menu button; only visible when __oidcSession is set in index.html)
// ============================================================

window.handleLogout = async function handleLogout() {
  if (!window.__oidcSession) {
    return;
  }

  const ok = await win95Dialog.confirm('Log out and end your session?', 'Sign out');
  if (!ok) {
    return;
  }

  sessionStorage.removeItem('active_tenant_id');
  API.clearToken();
  window.location.href = '/auth/logout';
};

// ============================================================
// INITIALIZATION
// ============================================================

// Expose initApp globally so the auth bootstrap can call it after login
function initApp() {
  if (window.__appInitialized) return;
  window.__appInitialized = true;
  console.log('Ditto initialized');
  if (typeof window.markAppShellReady === 'function') {
    window.markAppShellReady();
  }
  const hint = document.getElementById('envMigrationHint');
  if (hint && window.__hostedMultiTenant === true) {
    hint.classList.add('hidden');
  }
  updateClock();
  setInterval(updateClock, 1000);
  void loadAllData();
  startAutoRefresh();
}

document.addEventListener('DOMContentLoaded', () => {
  // If auth is required and we don't have a valid token yet, don't init.
  // The auth bootstrap script will call initApp() after successful login.
  if (window.__authRequired) return;
  initApp();
});

if (window.__startAppOnReady && !window.__authRequired) {
  initApp();
}

function updateClock() {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = now.getMinutes().toString().padStart(2, '0');
  document.getElementById('taskbarClock').textContent = `${h}:${m}`;
}

function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    refreshCurrentTab();
  }, 5000);
}

function refreshCurrentTab() {
  switch (currentTab) {
    case 'dashboard':
      loadDashboardData();
      break;
    case 'wallets':
      loadWallets();
      break;
    case 'trading-wallets':
      loadTradingWallets();
      break;
    case 'platforms':
      loadPlatformStatus();
      break;
    case 'cross-platform':
      refreshExecutorStatus();
      break;
    case 'discovery':
      if (!discoveryRefreshTimer) {
        startDiscoveryRefresh();
      } else {
        loadDiscoveryStatus();
        if (discoveryWalletOffset === 0) {
          fetchDiscoveryWallets(false);
        }
        loadDiscoveryOverview();
        loadDiscoverySignals();
        loadUnusualMarkets();
      }
      break;
    case 'performance':
      loadPerformanceTab();
      break;
  }
}

const updateHeaderStatusChip = () => {
  const chip = document.getElementById('appHeaderStatus');
  if (!chip) return;
  chip.textContent = botRunning ? 'Bot running' : 'Bot offline';
  chip.classList.toggle('running', botRunning);
  chip.classList.toggle('stopped', !botRunning);
};

const buildSetupGuideState = ({ status, walletsData, tradingData, lockData }) => {
  const trackedCount = walletsData?.wallets?.length || 0;
  const tradingCount = tradingData?.wallets?.length || 0;
  const vaultUnlocked = usesHostedWalletAccess() ? true : !!lockData?.unlocked;
  const hasTradingWallet = tradingCount > 0;
  const isReadyToStart = hasTradingWallet && trackedCount > 0;
  const isComplete = isReadyToStart && !!status?.running;

  const steps = [
    {
      key: 'session',
      title: 'Connected to your workspace',
      detail: usesHostedWalletAccess()
        ? 'Your hosted account session is active.'
        : 'Your dashboard session is active.',
      complete: true,
      action: 'dashboard'
    },
    {
      key: 'trading-wallet',
      title: usesHostedWalletAccess() ? 'Add a trading wallet' : 'Unlock or create your vault',
      detail: hasTradingWallet
        ? `${tradingCount} trading wallet${tradingCount === 1 ? '' : 's'} ready`
        : (vaultUnlocked
          ? 'Add the wallet Ditto should use to place copied trades.'
          : 'Open your vault first, then add the wallet Ditto should trade with.'),
      complete: hasTradingWallet,
      action: 'trading-wallets'
    },
    {
      key: 'tracked-wallet',
      title: 'Add a tracked wallet',
      detail: trackedCount > 0
        ? `${trackedCount} tracked wallet${trackedCount === 1 ? '' : 's'} added`
        : 'Choose the wallet addresses Ditto should follow and copy.',
      complete: trackedCount > 0,
      action: 'wallets'
    },
    {
      key: 'start-bot',
      title: 'Review and start the bot',
      detail: status?.running
        ? 'Ditto is currently live.'
        : (isReadyToStart
          ? 'Your basics are ready. Start the bot when you are comfortable.'
          : 'This unlocks once your trading wallet and tracked wallet are both ready.'),
      complete: !!status?.running,
      action: 'dashboard'
    }
  ];

  const nextStep = steps.find((step) => !step.complete) || steps[steps.length - 1];

  return {
    trackedCount,
    tradingCount,
    vaultUnlocked,
    isReadyToStart,
    isComplete,
    nextStep,
    steps
  };
};

const renderSetupProgress = (state) => {
  const summaryEl = document.getElementById('setupProgressSummary');
  const listEl = document.getElementById('setupProgressChecklist');
  const stepsEl = document.getElementById('setupWizardSteps');

  if (summaryEl) {
    summaryEl.textContent = state.isComplete
      ? 'Ditto is configured and live.'
      : state.nextStep.title;
  }

  const progressHtml = state.steps.map((step) => {
    const className = step.complete
      ? 'is-complete'
      : step.key === state.nextStep.key ? 'is-active' : '';

    return `
      <div class="setup-progress-item ${className}">
        <span class="setup-progress-dot"></span>
        <div>
          <div class="setup-progress-title">${step.title}</div>
          <div class="setup-progress-meta">${step.detail}</div>
        </div>
      </div>
    `;
  }).join('');

  if (listEl) listEl.innerHTML = progressHtml;

  if (stepsEl) {
    stepsEl.innerHTML = state.steps.map((step, index) => {
      const className = step.complete
        ? 'is-complete'
        : step.key === state.nextStep.key ? 'is-active' : '';

      return `
        <div class="setup-wizard-step-item ${className}">
          <span class="setup-wizard-step-dot"></span>
          <div>
            <div class="setup-wizard-step-titletext">${index + 1}. ${step.title}</div>
            <div class="setup-wizard-step-meta">${step.detail}</div>
          </div>
        </div>
      `;
    }).join('');
  }
};

const renderSetupWizard = (state) => {
  setupGuideAction = state.nextStep.action || 'dashboard';

  const summaryEl = document.getElementById('setupWizardSummary');
  const titleEl = document.getElementById('setupWizardTitle');
  const bodyEl = document.getElementById('setupWizardBody');
  const factsEl = document.getElementById('setupWizardFacts');
  const primaryBtn = document.getElementById('setupWizardPrimaryBtn');

  if (summaryEl) {
    summaryEl.textContent = state.isComplete
      ? 'Everything essential is configured. You can close this guide and use Ditto normally.'
      : 'Ditto checks the real app state and sends you to the next thing that matters.';
  }

  if (titleEl) {
    titleEl.textContent = state.isComplete ? 'You are ready to review the dashboard.' : state.nextStep.title;
  }

  if (bodyEl) {
    bodyEl.textContent = state.isComplete
      ? 'Your workspace has a trading wallet, at least one tracked wallet, and the bot is running.'
      : state.nextStep.detail;
  }

  if (factsEl) {
    factsEl.innerHTML = `
      <div class="setup-wizard-fact">Trading wallets configured: <strong>${state.tradingCount}</strong></div>
      <div class="setup-wizard-fact">Tracked wallets configured: <strong>${state.trackedCount}</strong></div>
      <div class="setup-wizard-fact">Bot status: <strong>${botRunning ? 'Running' : 'Stopped'}</strong></div>
    `;
  }

  if (primaryBtn) {
    primaryBtn.textContent = state.isComplete
      ? 'Go to Home'
      : (setupGuideAction === 'trading-wallets'
        ? 'Open Trading Wallets'
        : setupGuideAction === 'wallets'
          ? 'Open Tracked Wallets'
          : 'Go to Home');
  }

  renderSetupProgress(state);
};

async function refreshSetupExperience(autoOpen = false) {
  try {
    const lockPromise = usesHostedWalletAccess()
      ? Promise.resolve({ unlocked: true })
      : API.getLockStatus().catch(() => ({ unlocked: false }));

    const [status, walletsData, tradingData, lockData] = await Promise.all([
      API.getStatus().catch(() => ({ running: false })),
      API.getWallets().catch(() => ({ wallets: [] })),
      API.getTradingWallets().catch(() => ({ wallets: [] })),
      lockPromise
    ]);

    setupGuideState = buildSetupGuideState({ status, walletsData, tradingData, lockData });
    renderSetupWizard(setupGuideState);

    if (setupGuideState.isComplete) {
      localStorage.setItem(SETUP_GUIDE_COMPLETED_KEY, 'true');
    }

    if (autoOpen) {
      maybeAutoOpenSetupWizard();
    }
  } catch (error) {
    console.error('Error refreshing setup experience:', error);
  }
}

function dismissSetupWizard() {
  document.getElementById('setupWizardOverlay')?.classList.add('hidden');
  sessionStorage.setItem(SETUP_GUIDE_SESSION_DISMISS_KEY, 'true');
}

function startSetupWizard(force = false) {
  if (force) {
    sessionStorage.removeItem(SETUP_GUIDE_SESSION_DISMISS_KEY);
  }

  document.getElementById('setupWizardOverlay')?.classList.remove('hidden');

  if (!setupGuideState) {
    void refreshSetupExperience(false);
  }
}

function maybeAutoOpenSetupWizard() {
  if (!setupGuideState || setupGuideState.isComplete) return;
  if (localStorage.getItem(SETUP_GUIDE_COMPLETED_KEY) === 'true') return;
  if (sessionStorage.getItem(SETUP_GUIDE_SESSION_DISMISS_KEY) === 'true') return;
  startSetupWizard(false);
}

function handleSetupWizardPrimaryAction() {
  dismissSetupWizard();
  switchTab(setupGuideAction);

  if (setupGuideAction === 'dashboard') {
    document.getElementById('startStopBtn')?.focus();
    return;
  }

  if (setupGuideAction === 'wallets') {
    document.getElementById('newWalletAddress')?.focus();
    return;
  }

  if (setupGuideAction === 'trading-wallets') {
    if (document.getElementById('unlockSection')?.classList.contains('hidden')) {
      document.getElementById('newTradingWalletId')?.focus();
    } else {
      const firstTimeVisible = !document.getElementById('unlockFirstTime')?.classList.contains('hidden');
      if (firstTimeVisible) {
        document.getElementById('masterPasswordNew')?.focus();
      } else {
        document.getElementById('masterPasswordInput')?.focus();
      }
    }
  }
}

async function loadAllData() {
  try {
    await Promise.all([
      loadStatus(),
      loadWalletBalance(),
      loadPerformance(),
      loadTrades(),
      loadWallets(),
      loadSettings(),
      loadPlatformStatus().catch(() => { }),
      checkLockStatus(),
      loadLadderStatus().catch(() => { })
    ]);
    await refreshSetupExperience(true);
  } catch (error) {
    console.error('Error loading data:', error);
  }
}

// ============================================================
// TAB NAVIGATION
// ============================================================

function switchTab(tabName) {
  if (currentTab === 'discovery' && tabName !== 'discovery') {
    stopDiscoveryRefresh();
  }
  document.querySelectorAll('.win-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  document.querySelectorAll('.win-tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });

  currentTab = tabName;
  refreshCurrentTab();
}

// ============================================================
// DASHBOARD
// ============================================================

async function loadDashboardData() {
  await Promise.all([
    loadStatus(),
    loadWalletBalance(),
    loadPerformance(),
    loadTrades(),
    loadLadderStatus()
  ]);
}

async function loadStatus() {
  try {
    const data = await API.getStatus();
    updateStatusUI(data);
  } catch (error) {
    console.error('Error loading status:', error);
  }
}

function updateStatusUI(data) {
  botRunning = data.running;
  updateHeaderStatusChip();

  // Taskbar
  const indicator = document.getElementById('taskbarIndicator');
  const statusText = document.getElementById('taskbarStatus');
  const startStopLabel = document.getElementById('startStopLabel');

  if (data.running) {
    indicator.className = 'status-indicator running';
    statusText.textContent = 'Running';
    startStopLabel.textContent = 'Stop';
  } else {
    indicator.className = 'status-indicator stopped';
    statusText.textContent = 'Stopped';
    startStopLabel.textContent = 'Start';
  }

  // Status bar
  document.getElementById('statusBarBot').textContent = data.running ? 'Running' : 'Stopped';
  document.getElementById('statusBarMode').textContent = data.monitoringMode || 'Polling';

  if (data.wallets) {
    document.getElementById('walletsTracked').textContent = data.wallets.active;
    const intervalSec = data.polling && data.polling.interval ? Math.round(data.polling.interval / 1000) : null;
    const modeText = intervalSec ? `Data source: Polymarket API, polling every ${intervalSec}s` : `${data.monitoringMode || 'polling'} mode`;
    document.getElementById('statusBarMain').textContent = `${data.wallets.active} wallet(s) tracked | ${modeText}`;
  }
}

async function loadWalletBalance() {
  try {
    const wallet = await API.getWallet();
    const balance = await API.getWalletBalance();

    document.getElementById('walletAddress').textContent =
      wallet.walletAddress ? `${wallet.walletAddress.slice(0, 6)}...${wallet.walletAddress.slice(-4)}` : 'Not configured';

    document.getElementById('walletBalance').textContent =
      `$${(balance.currentBalance || 0).toFixed(2)}`;

    const changeEl = document.getElementById('balanceChange');
    const change = balance.change24h || 0;
    changeEl.textContent = `${change >= 0 ? '+' : ''}$${change.toFixed(2)} (24h)`;
    changeEl.className = `balance-change ${change >= 0 ? 'positive' : 'negative'}`;
  } catch (error) {
    console.error('Error loading wallet balance:', error);
  }
}

async function loadPerformance() {
  try {
    const data = await API.getPerformance();
    document.getElementById('successRate').textContent = `${(data.successRate || 0).toFixed(1)}%`;
    document.getElementById('totalTrades').textContent = data.totalTrades || 0;
    document.getElementById('avgLatency').textContent = `${Math.round(data.averageLatencyMs || 0)}ms`;
    document.getElementById('successfulTrades').textContent = data.successfulTrades || 0;
    document.getElementById('failedTrades').textContent = data.failedTrades || 0;
  } catch (error) {
    console.error('Error loading performance:', error);
  }
}

// Trade pagination state
let allLoadedTrades = [];
let tradesPageSize = 50;
let tradesCurrentLimit = 50;

const getShortRejectReason = (trade) => {
  if (trade.status !== 'rejected' || !trade.error) return '';
  const e = trade.error.toLowerCase();
  if (e.includes('no-repeat')) return 'no-repeat';
  if (e.includes('threshold') || e.includes('below') && e.includes('%')) return 'threshold';
  if (e.includes('rate limit')) return 'rate limit';
  if (e.includes('stop-loss') || e.includes('committed')) return 'stop-loss';
  if (e.includes('order size') || e.includes('too small') || e.includes('market min')) return 'min size';
  if (e.includes('side filter')) return 'side filter';
  if (e.includes('price filter')) return 'price filter';
  if (e.includes('value filter')) return 'value filter';
  return 'rejected';
};

async function loadTrades() {
  try {
    const data = await API.getTrades(tradesCurrentLimit);
    const tbody = document.getElementById('tradesTableBody');
    const countLabel = document.getElementById('tradesCountLabel');
    const loadMoreBtn = document.getElementById('loadMoreTradesBtn');

    if (!data.trades || data.trades.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No trades yet</td></tr>';
      if (countLabel) countLabel.textContent = '0 trades';
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
      return;
    }

    allLoadedTrades = [...data.trades].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    tbody.innerHTML = allLoadedTrades.map((trade, idx) => {
      const detectedShares = parseFloat(trade.amount || 0);
      const detectedPrice = parseFloat(trade.price || 0);
      const detectedUsd = detectedShares * detectedPrice;
      const amountDisplay = `$${detectedUsd.toFixed(2)}`;

      const rejectReason = getShortRejectReason(trade);
      const statusLabel = rejectReason
        ? `<span class="status-pill failed">${rejectReason}</span>`
        : `<span class="status-pill ${trade.success ? 'success' : (trade.status === 'pending' ? 'pending' : 'failed')}">${trade.status || (trade.success ? 'OK' : 'FAIL')}</span>`;

      return `<tr class="clickable-row" onclick="openTradeDetailModal(${idx})" tabindex="0" role="button" aria-label="View trade details">
        <td>${new Date(trade.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
        <td>${trade.walletLabel || trade.walletAddress.slice(0, 8)}...${(trade.walletTags && trade.walletTags.length > 0) ? ' ' + trade.walletTags.map(t => `<span class="tag-badge ${TAG_COLOR_MAP[t] || ''}">${t}</span>`).join('') : ''}</td>
        <td title="${trade.marketId || ''}">${trade.marketName || trade.marketId?.slice(0, 12) + '...'}</td>
        <td>${trade.outcome} ${trade.side || 'BUY'}</td>
        <td>${amountDisplay}</td>
        <td>${statusLabel}</td>
      </tr>`;
    }).join('');

    if (countLabel) countLabel.textContent = `${allLoadedTrades.length} trade${allLoadedTrades.length !== 1 ? 's' : ''} shown`;
    if (loadMoreBtn) {
      loadMoreBtn.style.display = (data.trades.length >= tradesCurrentLimit) ? '' : 'none';
    }
  } catch (error) {
    console.error('Error loading trades:', error);
  }
}

const loadMoreTrades = async () => {
  tradesCurrentLimit += tradesPageSize;
  await loadTrades();
};

const openTradeDetailModal = (idx) => {
  const trade = allLoadedTrades[idx];
  if (!trade) return;

  const detectedShares = parseFloat(trade.amount || 0);
  const detectedPrice = parseFloat(trade.price || 0);
  const detectedUsd = detectedShares * detectedPrice;
  const statusText = trade.status || (trade.success ? 'Success' : 'Failed');
  const statusClass = trade.success ? 'text-success' : (trade.status === 'pending' ? 'text-warning' : 'text-danger');

  const content = document.getElementById('tradeDetailContent');
  content.innerHTML = `
    <div class="detail-label">Time:</div>
    <div class="detail-value">${new Date(trade.timestamp).toLocaleString()}</div>

    <div class="detail-label">Status:</div>
    <div class="detail-value"><span class="${statusClass}" style="font-weight:bold;">${statusText.toUpperCase()}</span></div>

    <div class="detail-divider"></div>

    <div class="detail-label">Wallet:</div>
    <div class="detail-value">${trade.walletLabel || 'Unknown'} <span class="text-mono text-sm">(${trade.walletAddress || '?'})</span></div>

    ${(trade.walletTags && trade.walletTags.length > 0) ? `
    <div class="detail-label">Tags:</div>
    <div class="detail-value">${trade.walletTags.map(t => `<span class="tag-badge ${TAG_COLOR_MAP[t] || ''}">${t}</span>`).join(' ')}</div>
    ` : ''}

    <div class="detail-divider"></div>

    <div class="detail-label">Market:</div>
    <div class="detail-value">${trade.marketName || trade.marketTitle || trade.marketId || 'Unknown'}</div>

    <div class="detail-label">Market ID:</div>
    <div class="detail-value"><span class="text-mono text-sm">${trade.marketId || '?'}</span></div>

    <div class="detail-label">Outcome:</div>
    <div class="detail-value">${trade.outcome || '?'}</div>

    <div class="detail-label">Side:</div>
    <div class="detail-value">${trade.side || 'BUY'}</div>

    <div class="detail-divider"></div>

    <div class="detail-label">Their Trade:</div>
    <div class="detail-value">${detectedShares.toFixed(2)} shares @ $${detectedPrice.toFixed(4)} = <b>$${detectedUsd.toFixed(2)}</b></div>

    ${trade.executedAmount ? `
    <div class="detail-label">Your Copy:</div>
    <div class="detail-value">${parseFloat(trade.executedAmount).toFixed(2)} shares @ $${parseFloat(trade.executedPrice || 0).toFixed(4)} = <b>$${(parseFloat(trade.executedAmount) * parseFloat(trade.executedPrice || 0)).toFixed(2)}</b></div>
    ` : ''}

    ${trade.latencyMs ? `
    <div class="detail-label">Latency:</div>
    <div class="detail-value">${trade.latencyMs}ms</div>
    ` : ''}

    ${trade.error ? `
    <div class="detail-divider"></div>
    <div class="detail-label">Reason:</div>
    <div class="detail-value text-danger">${trade.error}</div>
    ` : ''}

    ${trade.orderId ? `
    <div class="detail-label">Order ID:</div>
    <div class="detail-value"><span class="text-mono text-sm">${trade.orderId}</span></div>
    ` : ''}
  `;

  document.getElementById('tradeDetailModalTitle').textContent = `Trade: ${trade.outcome || '?'} ${trade.side || 'BUY'} - ${statusText}`;
  document.getElementById('tradeDetailModal').classList.remove('hidden');
};

const closeTradeDetailModal = () => {
  document.getElementById('tradeDetailModal').classList.add('hidden');
};

// ============================================================
// BOT CONTROL
// ============================================================

async function toggleBot() {
  try {
    if (botRunning) {
      await API.stopBot();
    } else {
      await API.startBot();
    }
    await loadStatus();
    await refreshSetupExperience();
  } catch (error) {
    await win95Dialog.error(`Failed: ${error.message}`);
  }
}

async function startBot() {
  try { await API.startBot(); await loadStatus(); }
  catch (error) { await win95Dialog.error(`Failed to start bot: ${error.message}`); }
}

async function stopBot() {
  try { await API.stopBot(); await loadStatus(); }
  catch (error) { await win95Dialog.error(`Failed to stop bot: ${error.message}`); }
}

// ============================================================
// TRACKED WALLETS
// ============================================================

let currentWalletAddress = null;

// Wallet list cache to prevent full DOM rebuilds (fixes balance blinking)
let lastWalletHash = '';
let cachedWalletAddresses = [];

// Active tag filter (empty string = show all)
let activeTagFilter = '';

const TAG_COLOR_MAP = {
  sports: 'tag-sports',
  politics: 'tag-politics',
  insider: 'tag-insider',
  crypto: 'tag-crypto',
  markets: 'tag-markets'
};

const renderTagBadges = (tags) => {
  if (!tags || tags.length === 0) return '';
  return tags.map(tag => {
    const cls = TAG_COLOR_MAP[tag] || '';
    return `<span class="tag-badge ${cls}">${tag}</span>`;
  }).join('');
};

function handleTagFilter(tag) {
  activeTagFilter = activeTagFilter === tag ? '' : tag;
  // Re-render without re-fetching
  const filterBtns = document.querySelectorAll('.tag-filter-btn');
  filterBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tag === activeTagFilter);
  });
  applyWalletTagFilter();
}

function applyWalletTagFilter() {
  const entries = document.querySelectorAll('.wallet-entry[data-tags]');
  entries.forEach(el => {
    if (!activeTagFilter) {
      el.style.display = '';
      return;
    }
    const tags = (el.dataset.tags || '').split(',');
    el.style.display = tags.includes(activeTagFilter) ? '' : 'none';
  });
}

async function loadWallets(forceRebuild = false) {
  try {
    const data = await API.getWallets();
    const list = document.getElementById('walletsList');

    if (!data.wallets || data.wallets.length === 0) {
      lastWalletHash = '';
      cachedWalletAddresses = [];
      list.innerHTML = '<div class="text-center text-muted" style="padding:20px;">No wallets tracked yet. Add a wallet address above to start copy trading.</div>';
      return;
    }

    // Build a hash of the wallet list state to detect actual changes
    const newHash = data.wallets.map(w =>
      `${w.address}:${w.active}:${w.label || ''}:${(w.tags || []).join(',')}:${w.tradeSizingMode || ''}:${w.fixedTradeSize || ''}`
    ).join('|');

    // If nothing changed, just refresh balances in-place (no DOM rebuild = no blink)
    if (!forceRebuild && newHash === lastWalletHash) {
      for (const wallet of data.wallets) {
        loadTrackedWalletBalance(wallet.address);
      }
      return;
    }

    lastWalletHash = newHash;
    cachedWalletAddresses = data.wallets.map(w => w.address);

    // Collect all unique tags across wallets for the filter bar
    const allTags = new Set();
    data.wallets.forEach(w => (w.tags || []).forEach(t => allTags.add(t)));

    let filterBarHtml = '';
    if (allTags.size > 0) {
      filterBarHtml = `<div class="tag-filter-bar">
        <span class="text-sm text-muted" style="line-height:22px;">Filter:</span>
        <button class="tag-filter-btn ${!activeTagFilter ? 'active' : ''}" data-tag="" onclick="handleTagFilter('')" aria-label="Show all wallets" tabindex="0">All</button>
        ${[...allTags].sort().map(tag => `
          <button class="tag-filter-btn ${activeTagFilter === tag ? 'active' : ''}" data-tag="${tag}" onclick="handleTagFilter('${tag}')" aria-label="Filter by ${tag}" tabindex="0">${tag}</button>
        `).join('')}
      </div>`;
    }

    const walletsHtml = data.wallets.map(wallet => {
      const isActive = wallet.active;
      const configBadges = getWalletConfigBadges(wallet);
      const tagBadges = renderTagBadges(wallet.tags);
      const tagsDataAttr = (wallet.tags || []).join(',');
      const pausedBadge = isActive ? '' : '<span class="paused-badge">Paused</span>';

      return `
        <div class="wallet-entry ${isActive ? 'active-wallet' : 'inactive-wallet'}" id="wallet-${wallet.address}" data-tags="${tagsDataAttr}">
          <div class="wallet-entry-info">
            <div class="wallet-entry-address">
              ${wallet.label ? `<span class="wallet-entry-label">${wallet.label}</span>` : ''}
              <span class="text-mono">${wallet.address.slice(0, 10)}...${wallet.address.slice(-8)}</span>
              ${pausedBadge}
              ${tagBadges}
            </div>
            <div class="wallet-entry-config">${configBadges}</div>
          </div>
          <div class="wallet-entry-balance" id="balance-${wallet.address}">
            <span class="text-muted text-sm">Loading...</span>
          </div>
          <div class="wallet-entry-actions">
            <label class="win-toggle">
              <input type="checkbox" ${isActive ? 'checked' : ''} onchange="toggleWallet('${wallet.address}', this.checked)">
            </label>
            <button class="win-btn win-btn-sm" onclick="openMirrorModal('${wallet.address}')">Mirror</button>
            <button class="win-btn win-btn-sm" onclick="openWalletModal('${wallet.address}')">Config</button>
            <button class="win-btn win-btn-sm win-btn-danger" onclick="removeWallet('${wallet.address}')">X</button>
          </div>
        </div>
      `;
    }).join('');

    list.innerHTML = filterBarHtml + walletsHtml;

    // Apply active filter if set
    if (activeTagFilter) {
      applyWalletTagFilter();
    }

    // Fetch balances async
    for (const wallet of data.wallets) {
      loadTrackedWalletBalance(wallet.address);
    }

    // Also update assignment dropdowns
    updateAssignmentDropdowns(data.wallets);
  } catch (error) {
    console.error('Error loading wallets:', error);
  }
}

async function loadTrackedWalletBalance(address) {
  const balanceEl = document.getElementById(`balance-${address}`);
  if (!balanceEl) return;

  try {
    const data = await API.get(`/wallets/${address}/balance`);

    if (data.success && data.currentBalance !== undefined) {
      const totalValue = data.currentBalance;
      if (totalValue > 0) {
        balanceEl.innerHTML = `<span class="balance-val">$${formatNumber(totalValue)}</span>`;
      } else {
        balanceEl.innerHTML = `<span class="text-muted">$0</span>`;
      }
    } else {
      balanceEl.innerHTML = `<span class="text-danger">Error</span>`;
    }
  } catch (error) {
    balanceEl.innerHTML = `<span class="text-muted">-</span>`;
  }
}

function formatNumber(num) {
  if (num >= 1000) return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (num >= 1) return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num.toFixed(2);
}

function getWalletConfigBadges(wallet) {
  const badges = [];

  if (wallet.tradeSizingMode === 'fixed') {
    badges.push(`<span class="win-badge badge-success">Fixed $${wallet.fixedTradeSize || '?'}</span>`);
    if (wallet.thresholdEnabled) badges.push(`<span class="win-badge badge-success">${wallet.thresholdPercent}% threshold</span>`);
  } else if (wallet.tradeSizingMode === 'proportional') {
    badges.push(`<span class="win-badge badge-success">Proportional</span>`);
  } else {
    badges.push(`<span class="win-badge">Global size</span>`);
  }

  if (wallet.tradeSideFilter && wallet.tradeSideFilter !== 'all') {
    const label = wallet.tradeSideFilter === 'buy_only' ? 'BUY only' : 'SELL only';
    badges.push(`<span class="win-badge badge-warning">${label}</span>`);
  }

  if (wallet.noRepeatEnabled) badges.push(`<span class="win-badge badge-success">No repeat</span>`);
  if (wallet.rateLimitEnabled) badges.push(`<span class="win-badge badge-success">Rate limited</span>`);
  if (wallet.valueFilterEnabled) badges.push(`<span class="win-badge badge-success">Value filter</span>`);

  return badges.join(' ') || '<span class="win-badge">Using defaults</span>';
}

async function addWallet() {
  const input = document.getElementById('newWalletAddress');
  const address = input.value.trim();
  if (!address) { await win95Dialog.alert('Please enter a wallet address'); return; }

  try {
    await API.addWallet(address);
    input.value = '';
    lastWalletHash = '';
    await loadWallets(true);
    await refreshSetupExperience();
    if (await win95Dialog.confirm('Wallet added (inactive by default). Configure it now?')) {
      openWalletModal(address.toLowerCase());
    }
  } catch (error) {
    await win95Dialog.error(`Failed to add wallet: ${error.message}`);
  }
}

async function removeWallet(address) {
  if (!await win95Dialog.confirm('Remove this tracked wallet?')) return;
  try { lastWalletHash = ''; await API.removeWallet(address); await loadWallets(true); }
  catch (error) { await win95Dialog.error(`Failed to remove wallet: ${error.message}`); }
}

async function toggleWallet(address, active) {
  try { lastWalletHash = ''; await API.toggleWallet(address, active); await loadWallets(true); }
  catch (error) { await win95Dialog.error(`Failed to toggle wallet: ${error.message}`); await loadWallets(true); }
}

// ============================================================
// WALLET CONFIGURATION MODAL
// ============================================================

async function openWalletModal(address) {
  currentWalletAddress = address;

  try {
    const data = await API.getWallets();
    const wallet = data.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) { await win95Dialog.error('Wallet not found'); return; }

    document.getElementById('walletModalTitle').textContent = `Configure: ${wallet.label || address.slice(0, 10) + '...'}`;
    document.getElementById('modalWalletAddress').textContent = address;

    const statusEl = document.getElementById('modalWalletStatus');
    statusEl.textContent = wallet.active ? 'Active' : 'Inactive';
    statusEl.className = `win-badge ${wallet.active ? 'badge-success' : 'badge-danger'}`;

    document.getElementById('modalWalletLabel').value = wallet.label || '';
    document.getElementById('modalTradeSize').value = wallet.fixedTradeSize || 2;

    const modeValue = wallet.tradeSizingMode || 'fixed';
    document.querySelector(`input[name="modalTradeSizingMode"][value="${modeValue}"]`).checked = true;

    document.getElementById('modalThresholdEnabled').checked = wallet.thresholdEnabled || false;
    document.getElementById('modalThresholdInputs').className = wallet.thresholdEnabled ? '' : 'hidden';
    document.getElementById('modalThresholdPercent').value = wallet.thresholdPercent || 10;

    const sideValue = wallet.tradeSideFilter || 'all';
    document.querySelector(`input[name="modalTradeSideFilter"][value="${sideValue}"]`).checked = true;

    document.getElementById('modalNoRepeatEnabled').checked = wallet.noRepeatEnabled || false;
    document.getElementById('modalNoRepeatInputs').className = wallet.noRepeatEnabled ? '' : 'hidden';
    document.getElementById('modalNoRepeatPeriod').value = wallet.noRepeatPeriodHours ?? 24;

    document.getElementById('modalPriceLimitsMin').value = wallet.priceLimitsMin ?? 0.01;
    document.getElementById('modalPriceLimitsMax').value = wallet.priceLimitsMax ?? 0.99;
    updatePriceBadge();

    document.getElementById('modalValueFilterEnabled').checked = wallet.valueFilterEnabled || false;
    document.getElementById('modalValueFilterInputs').className = wallet.valueFilterEnabled ? '' : 'hidden';
    document.getElementById('modalValueFilterMin').value = wallet.valueFilterMin || '';
    document.getElementById('modalValueFilterMax').value = wallet.valueFilterMax || '';

    document.getElementById('modalRateLimitEnabled').checked = wallet.rateLimitEnabled || false;
    document.getElementById('modalRateLimitInputs').className = wallet.rateLimitEnabled ? '' : 'hidden';
    document.getElementById('modalRateLimitPerHour').value = wallet.rateLimitPerHour ?? 10;
    document.getElementById('modalRateLimitPerDay').value = wallet.rateLimitPerDay ?? 50;

    document.getElementById('modalSlippagePercent').value = wallet.slippagePercent || '';
    updateSlippageBadge();

    // Initialize tags
    const currentTags = wallet.tags || [];
    document.getElementById('modalWalletTags').value = JSON.stringify(currentTags);
    refreshModalTagButtons(currentTags);

    updateModalPipeline();
    document.getElementById('walletModal').classList.remove('hidden');
    setupModalEventListeners();
  } catch (error) {
    await win95Dialog.error(`Failed to load wallet: ${error.message}`);
  }
}

function setupModalEventListeners() {
  document.getElementById('modalTradeSize').onchange = updateModalPipeline;
  document.querySelectorAll('input[name="modalTradeSizingMode"]').forEach(r => r.onchange = updateModalPipeline);

  document.getElementById('modalThresholdEnabled').onchange = function () {
    document.getElementById('modalThresholdInputs').className = this.checked ? '' : 'hidden';
    updateModalPipeline();
  };

  document.querySelectorAll('input[name="modalTradeSideFilter"]').forEach(r => r.onchange = updateModalPipeline);

  document.getElementById('modalNoRepeatEnabled').onchange = function () {
    document.getElementById('modalNoRepeatInputs').className = this.checked ? '' : 'hidden';
    updateModalPipeline();
  };
  document.getElementById('modalNoRepeatPeriod').onchange = updateModalPipeline;

  document.getElementById('modalValueFilterEnabled').onchange = function () {
    document.getElementById('modalValueFilterInputs').className = this.checked ? '' : 'hidden';
    updateModalPipeline();
  };

  document.getElementById('modalRateLimitEnabled').onchange = function () {
    document.getElementById('modalRateLimitInputs').className = this.checked ? '' : 'hidden';
    updateModalPipeline();
  };

  document.getElementById('modalPriceLimitsMin').onchange = function () { updatePriceBadge(); updateModalPipeline(); };
  document.getElementById('modalPriceLimitsMax').onchange = function () { updatePriceBadge(); updateModalPipeline(); };
  document.getElementById('modalSlippagePercent').onchange = function () { updateSlippageBadge(); updateModalPipeline(); };
}

function updateModalPipeline() {
  const tradeSize = document.getElementById('modalTradeSize').value || 2;
  document.getElementById('modal-pipeline-size-desc').textContent = `$${tradeSize} USDC`;

  const side = document.querySelector('input[name="modalTradeSideFilter"]:checked').value;
  const sideDesc = document.getElementById('modal-pipeline-side-desc');
  const sideStatus = document.getElementById('modal-pipeline-side-status');
  if (side !== 'all') {
    sideDesc.textContent = side === 'buy_only' ? 'BUY only' : 'SELL only';
    sideStatus.textContent = 'ON'; sideStatus.className = 'step-status on';
  } else {
    sideDesc.textContent = 'All trades';
    sideStatus.textContent = 'OFF'; sideStatus.className = 'step-status off';
  }

  const minPrice = document.getElementById('modalPriceLimitsMin').value || 0.01;
  const maxPrice = document.getElementById('modalPriceLimitsMax').value || 0.99;
  const isDefaultPrice = parseFloat(minPrice) === 0.01 && parseFloat(maxPrice) === 0.99;
  document.getElementById('modal-pipeline-price-desc').textContent = `$${minPrice} - $${maxPrice}`;
  document.getElementById('modal-pipeline-price-status').textContent = isDefaultPrice ? 'DEFAULT' : 'CUSTOM';
  document.getElementById('modal-pipeline-price-status').className = `step-status ${isDefaultPrice ? 'off' : 'on'}`;

  const noRepeatEnabled = document.getElementById('modalNoRepeatEnabled').checked;
  const noRepeatPeriod = document.getElementById('modalNoRepeatPeriod').value;
  if (noRepeatEnabled) {
    document.getElementById('modal-pipeline-norepeat-desc').textContent = noRepeatPeriod === '0' ? 'Block forever' : `Block ${noRepeatPeriod}h`;
    document.getElementById('modal-pipeline-norepeat-status').textContent = 'ON'; document.getElementById('modal-pipeline-norepeat-status').className = 'step-status on';
  } else {
    document.getElementById('modal-pipeline-norepeat-desc').textContent = 'Disabled';
    document.getElementById('modal-pipeline-norepeat-status').textContent = 'OFF'; document.getElementById('modal-pipeline-norepeat-status').className = 'step-status off';
  }

  const valueEnabled = document.getElementById('modalValueFilterEnabled').checked;
  if (valueEnabled) {
    const parts = [];
    const vMin = document.getElementById('modalValueFilterMin').value;
    const vMax = document.getElementById('modalValueFilterMax').value;
    if (vMin) parts.push(`>$${vMin}`);
    if (vMax) parts.push(`<$${vMax}`);
    document.getElementById('modal-pipeline-value-desc').textContent = parts.length > 0 ? parts.join(', ') : 'No limits set';
    document.getElementById('modal-pipeline-value-status').textContent = 'ON'; document.getElementById('modal-pipeline-value-status').className = 'step-status on';
  } else {
    document.getElementById('modal-pipeline-value-desc').textContent = 'No limits';
    document.getElementById('modal-pipeline-value-status').textContent = 'OFF'; document.getElementById('modal-pipeline-value-status').className = 'step-status off';
  }

  const rateEnabled = document.getElementById('modalRateLimitEnabled').checked;
  if (rateEnabled) {
    const rH = document.getElementById('modalRateLimitPerHour').value || 10;
    const rD = document.getElementById('modalRateLimitPerDay').value || 50;
    document.getElementById('modal-pipeline-rate-desc').textContent = `${rH}/hr, ${rD}/day`;
    document.getElementById('modal-pipeline-rate-status').textContent = 'ON'; document.getElementById('modal-pipeline-rate-status').className = 'step-status on';
  } else {
    document.getElementById('modal-pipeline-rate-desc').textContent = 'Unlimited';
    document.getElementById('modal-pipeline-rate-status').textContent = 'OFF'; document.getElementById('modal-pipeline-rate-status').className = 'step-status off';
  }
}

function updatePriceBadge() {
  const min = parseFloat(document.getElementById('modalPriceLimitsMin').value);
  const max = parseFloat(document.getElementById('modalPriceLimitsMax').value);
  const isDefault = min === 0.01 && max === 0.99;
  const badge = document.getElementById('modalPriceBadge');
  badge.textContent = isDefault ? 'DEFAULT' : 'CUSTOM';
  badge.className = `win-badge ${isDefault ? '' : 'badge-success'}`;
}

function updateSlippageBadge() {
  const value = document.getElementById('modalSlippagePercent').value;
  const badge = document.getElementById('modalSlippageBadge');
  if (!value || parseFloat(value) === 2) {
    badge.textContent = 'DEFAULT (2%)';
    badge.className = 'win-badge';
  } else {
    badge.textContent = `${value}%`;
    badge.className = 'win-badge badge-success';
  }
}

function closeWalletModal() {
  document.getElementById('walletModal').classList.add('hidden');
  currentWalletAddress = null;
}

// ---- Tag management for wallet config modal ----

function getModalTags() {
  try {
    return JSON.parse(document.getElementById('modalWalletTags').value || '[]');
  } catch { return []; }
}

function setModalTags(tags) {
  document.getElementById('modalWalletTags').value = JSON.stringify(tags);
  refreshModalTagButtons(tags);
}

function refreshModalTagButtons(tags) {
  const btns = document.querySelectorAll('#modalTagButtons .tag-filter-btn');
  btns.forEach(btn => {
    btn.classList.toggle('active', tags.includes(btn.dataset.tag));
  });
}

function toggleModalTag(tag) {
  const tags = getModalTags();
  const idx = tags.indexOf(tag);
  if (idx >= 0) {
    tags.splice(idx, 1);
  } else {
    tags.push(tag);
  }
  setModalTags(tags);
}

function addCustomModalTag() {
  const input = document.getElementById('modalCustomTag');
  const tag = input.value.trim().toLowerCase();
  if (!tag) return;
  const tags = getModalTags();
  if (!tags.includes(tag)) {
    tags.push(tag);
    setModalTags(tags);
  }
  input.value = '';
}

// ---- End tag management ----

async function saveWalletConfig() {
  if (!currentWalletAddress) return;
  try {
    const config = collectModalConfig();
    const tags = getModalTags();
    await API.updateWalletLabel(currentWalletAddress, document.getElementById('modalWalletLabel').value.trim());
    await API.updateWalletTags(currentWalletAddress, tags);
    await API.updateWalletTradeConfig(currentWalletAddress, config);
    await win95Dialog.success('Configuration saved (wallet remains inactive until enabled)');
    closeWalletModal();
    lastWalletHash = '';
    await loadWallets(true);
  } catch (error) { await win95Dialog.error(`Failed to save: ${error.message}`); }
}

async function saveWalletConfigAndEnable() {
  if (!currentWalletAddress) return;
  try {
    const config = collectModalConfig();
    const tags = getModalTags();
    await API.updateWalletLabel(currentWalletAddress, document.getElementById('modalWalletLabel').value.trim());
    await API.updateWalletTags(currentWalletAddress, tags);
    await API.updateWalletTradeConfig(currentWalletAddress, config);
    await API.toggleWallet(currentWalletAddress, true);
    await win95Dialog.success('Configuration saved and wallet enabled!');
    closeWalletModal();
    lastWalletHash = '';
    await loadWallets(true);
  } catch (error) { await win95Dialog.error(`Failed to save: ${error.message}`); }
}

function collectModalConfig() {
  const mode = document.querySelector('input[name="modalTradeSizingMode"]:checked').value;
  const side = document.querySelector('input[name="modalTradeSideFilter"]:checked').value;
  const tradeSize = parseFloat(document.getElementById('modalTradeSize').value);

  return {
    tradeSizingMode: mode || 'fixed',
    fixedTradeSize: tradeSize || 2,
    thresholdEnabled: document.getElementById('modalThresholdEnabled').checked,
    thresholdPercent: document.getElementById('modalThresholdEnabled').checked ? parseFloat(document.getElementById('modalThresholdPercent').value) : null,
    tradeSideFilter: side || 'all',
    noRepeatEnabled: document.getElementById('modalNoRepeatEnabled').checked,
    noRepeatPeriodHours: document.getElementById('modalNoRepeatEnabled').checked ? parseInt(document.getElementById('modalNoRepeatPeriod').value) : null,
    priceLimitsMin: parseFloat(document.getElementById('modalPriceLimitsMin').value) || 0.01,
    priceLimitsMax: parseFloat(document.getElementById('modalPriceLimitsMax').value) || 0.99,
    valueFilterEnabled: document.getElementById('modalValueFilterEnabled').checked,
    valueFilterMin: document.getElementById('modalValueFilterEnabled').checked ? (parseFloat(document.getElementById('modalValueFilterMin').value) || null) : null,
    valueFilterMax: document.getElementById('modalValueFilterEnabled').checked ? (parseFloat(document.getElementById('modalValueFilterMax').value) || null) : null,
    rateLimitEnabled: document.getElementById('modalRateLimitEnabled').checked,
    rateLimitPerHour: document.getElementById('modalRateLimitEnabled').checked ? parseInt(document.getElementById('modalRateLimitPerHour').value) : null,
    rateLimitPerDay: document.getElementById('modalRateLimitEnabled').checked ? parseInt(document.getElementById('modalRateLimitPerDay').value) : null,
    slippagePercent: parseFloat(document.getElementById('modalSlippagePercent').value) || null
  };
}

// ============================================================
// SETTINGS
// ============================================================

async function loadSettings() {
  try {
    const [stopLoss, interval, proxyWallet] = await Promise.all([
      API.getStopLoss(),
      API.getMonitoringInterval(),
      fetch('/api/config/proxy-wallet').then(r => r.json()).catch(() => ({ proxyWalletAddress: '' }))
    ]);

    document.getElementById('stopLossEnabled').checked = stopLoss.enabled || false;
    document.getElementById('stopLossPercent').value = stopLoss.maxCommitmentPercent || 80;
    document.getElementById('stopLossInputs').className = stopLoss.enabled ? '' : 'hidden';
    document.getElementById('monitoringInterval').value = interval.intervalSeconds || 15;

    if (proxyWallet.proxyWalletAddress) {
      document.getElementById('proxyWalletAddress').value = proxyWallet.proxyWalletAddress;
    }
  } catch (error) { console.error('Error loading settings:', error); }
}

async function updateStopLoss() {
  const enabled = document.getElementById('stopLossEnabled').checked;
  const percent = parseInt(document.getElementById('stopLossPercent').value);
  document.getElementById('stopLossInputs').className = enabled ? '' : 'hidden';
  try { await API.setStopLoss(enabled, percent); } catch (error) { await win95Dialog.error(`Failed: ${error.message}`); }
}

async function updateMonitoringInterval() {
  try { await API.setMonitoringInterval(parseInt(document.getElementById('monitoringInterval').value)); }
  catch (error) { await win95Dialog.error(`Failed: ${error.message}`); }
}

async function updateProxyWallet() {
  const addr = document.getElementById('proxyWalletAddress').value.trim();
  if (!addr) { await win95Dialog.alert('Please enter your proxy wallet address'); return; }
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) { await win95Dialog.error('Invalid address format.'); return; }
  try {
    const response = await fetch('/api/config/proxy-wallet', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyWalletAddress: addr })
    });
    const data = await response.json();
    if (data.success) { await win95Dialog.success('Proxy wallet saved!'); loadWalletBalance(); }
    else await win95Dialog.error(`Failed: ${data.error}`);
  } catch (error) { await win95Dialog.error(`Failed: ${error.message}`); }
}

// ============================================================
// PERFORMANCE TAB
// ============================================================

let perfWalletsLoaded = false;

async function loadPerformanceTab() {
  if (!perfWalletsLoaded) {
    await loadPerfWalletSelector();
    perfWalletsLoaded = true;
  }

  const select = document.getElementById('perfWalletSelect');
  const walletId = select.value;
  if (!walletId) return;

  loadPerfPortfolioSummary(walletId);
  loadPerfPositions(walletId);
  loadPerfWalletLeaderboard();
}

async function loadPerfWalletSelector() {
  const select = document.getElementById('perfWalletSelect');
  try {
    const data = await API.getTradingWallets();
    const wallets = data.wallets || data || [];
    if (wallets.length === 0) {
      select.innerHTML = '<option value="">No trading wallets configured</option>';
      return;
    }
    select.innerHTML = wallets.map(w => {
      const label = w.label || w.id || 'Wallet';
      const addr = w.address ? ' (' + w.address.slice(0, 6) + '...' + w.address.slice(-4) + ')' : '';
      return `<option value="${w.id}">${label}${addr}</option>`;
    }).join('');
  } catch (error) {
    select.innerHTML = '<option value="">Failed to load wallets</option>';
  }
}

async function loadPerfPortfolioSummary(walletId) {
  const container = document.getElementById('perfPortfolioSummary');
  container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">Loading portfolio...</div>';
  try {
    const data = await API.getTradingWalletPortfolio(walletId);

    const pnl = data.positionsValue - (data.totalValue - data.usdcBalance - data.positionsValue || 0);
    container.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;">
        <div class="win-group" style="padding:8px;margin:0;text-align:center;">
          <div class="text-sm text-muted">Total Portfolio</div>
          <div style="font-size:20px;font-weight:bold;">$${(data.totalValue || 0).toFixed(2)}</div>
        </div>
        <div class="win-group" style="padding:8px;margin:0;text-align:center;">
          <div class="text-sm text-muted">USDC Balance</div>
          <div style="font-size:20px;font-weight:bold;">$${(data.usdcBalance || 0).toFixed(2)}</div>
        </div>
        <div class="win-group" style="padding:8px;margin:0;text-align:center;">
          <div class="text-sm text-muted">Positions Value</div>
          <div style="font-size:20px;font-weight:bold;">$${(data.positionsValue || 0).toFixed(2)}</div>
        </div>
        <div class="win-group" style="padding:8px;margin:0;text-align:center;">
          <div class="text-sm text-muted">Open Positions</div>
          <div style="font-size:20px;font-weight:bold;">${data.positionCount || 0}</div>
        </div>
      </div>`;
  } catch (error) {
    container.innerHTML = `<div class="text-danger">Failed to load portfolio: ${error.message}</div>`;
  }
}

async function loadPerfPositions(walletId) {
  const container = document.getElementById('perfPositions');
  container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">Loading positions...</div>';
  try {
    const data = await API.getTradingWalletPositions(walletId);
    const positions = (data.positions || []).filter(p => parseFloat(p.size) > 0);

    if (positions.length === 0) {
      container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">No open positions</div>';
      return;
    }

    // Sort by absolute P&L descending
    const sorted = positions.map(pos => {
      const size = parseFloat(pos.size || 0);
      const avgPrice = parseFloat(pos.avgPrice || 0);
      const curPrice = parseFloat(pos.curPrice || 0);
      const pnl = (curPrice - avgPrice) * size;
      const pnlPct = avgPrice > 0 ? ((curPrice - avgPrice) / avgPrice * 100) : 0;
      const cost = avgPrice * size;
      return { ...pos, size, avgPrice, curPrice, pnl, pnlPct, cost };
    }).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<tr style="border-bottom:2px solid var(--win-dark);text-align:left;">' +
      '<th style="padding:4px 6px;">Market</th>' +
      '<th style="padding:4px 6px;">Side</th>' +
      '<th style="padding:4px 6px;">Shares</th>' +
      '<th style="padding:4px 6px;">Entry</th>' +
      '<th style="padding:4px 6px;">Current</th>' +
      '<th style="padding:4px 6px;">Cost</th>' +
      '<th style="padding:4px 6px;">P&L</th>' +
      '<th style="padding:4px 6px;">ROI</th></tr>';

    sorted.forEach(p => {
      const title = p.title || p.conditionId?.slice(0, 16) || 'Unknown';
      const shortTitle = title.length > 35 ? title.slice(0, 33) + '...' : title;
      const outcome = p.outcome || 'Yes';
      const pnlColor = p.pnl >= 0 ? '#00aa00' : '#cc0000';
      const badgeClass = outcome.toUpperCase() === 'YES' ? 'badge-success' : 'badge-danger';

      html += `<tr style="border-bottom:1px solid var(--win-dark);">
        <td style="padding:4px 6px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${title}">${shortTitle}</td>
        <td style="padding:4px 6px;"><span class="win-badge ${badgeClass}">${outcome}</span></td>
        <td style="padding:4px 6px;">${p.size.toFixed(1)}</td>
        <td style="padding:4px 6px;">$${p.avgPrice.toFixed(3)}</td>
        <td style="padding:4px 6px;">$${p.curPrice.toFixed(3)}</td>
        <td style="padding:4px 6px;">$${p.cost.toFixed(2)}</td>
        <td style="padding:4px 6px;color:${pnlColor};font-weight:bold;">${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)}</td>
        <td style="padding:4px 6px;color:${pnlColor};font-weight:bold;">${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%</td>
      </tr>`;
    });
    html += '</table>';
    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `<div class="text-danger">Failed to load positions: ${error.message}</div>`;
  }
}

async function loadPerfWalletLeaderboard() {
  const container = document.getElementById('perfWalletLeaderboard');
  container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">Loading wallet stats...</div>';
  try {
    const walletsResp = await API.getWallets();
    const wallets = walletsResp.wallets || walletsResp || [];
    if (!wallets.length) {
      container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">No tracked wallets</div>';
      return;
    }

    // Fetch copy stats for each tracked wallet
    const statsPromises = wallets.map(w => {
      const addr = w.address || w;
      const label = w.label || null;
      return API.getWalletStats(addr).then(s => ({ ...s, address: addr, label })).catch(() => ({
        address: addr, label, tradesCopied: 0, successfulCopies: 0, failedCopies: 0,
        successRate: 0, averageLatencyMs: 0, lastActivity: null
      }));
    });

    // Fetch discovery scores in one call
    let discoveryMap = {};
    try {
      const disc = await API.getDiscoveryWallets(200);
      const discWallets = disc.wallets || disc || [];
      discWallets.forEach(dw => {
        const addr = (dw.address || '').toLowerCase();
        if (addr) discoveryMap[addr] = dw;
      });
    } catch (e) { /* discovery may not be running */ }

    const stats = await Promise.all(statsPromises);

    // Sort by trades copied descending
    stats.sort((a, b) => (b.tradesCopied || 0) - (a.tradesCopied || 0));

    const heatColors = { HOT: '#00aa00', WARMING: '#88aa00', STEADY: '#888', COOLING: '#cc8800', COLD: '#cc0000', NEW: '#0066cc' };

    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<tr style="border-bottom:2px solid var(--win-dark);text-align:left;">' +
      '<th style="padding:4px 6px;">Wallet</th>' +
      '<th style="padding:4px 6px;">Copied</th>' +
      '<th style="padding:4px 6px;">Success Rate</th>' +
      '<th style="padding:4px 6px;">Avg Latency</th>' +
      '<th style="padding:4px 6px;">Whale Score</th>' +
      '<th style="padding:4px 6px;">Heat</th>' +
      '<th style="padding:4px 6px;">Last Active</th></tr>';

    stats.forEach(s => {
      const shortAddr = s.address.slice(0, 6) + '...' + s.address.slice(-4);
      const displayName = s.label || shortAddr;
      const rateClass = s.successRate >= 80 ? 'text-success' : s.successRate >= 50 ? '' : 'text-danger';
      const lastActive = s.lastActivity ? new Date(s.lastActivity).toLocaleString() : 'Never';

      const disc = discoveryMap[s.address.toLowerCase()];
      const score = disc ? Math.round(disc.whaleScore || 0) : '-';
      const heat = disc?.heatIndicator || '-';
      const heatColor = heatColors[heat] || '#888';

      html += `<tr style="border-bottom:1px solid var(--win-dark);">
        <td style="padding:4px 6px;font-family:monospace;" title="${s.address}">${displayName}</td>
        <td style="padding:4px 6px;">${s.tradesCopied || 0}</td>
        <td style="padding:4px 6px;" class="${rateClass}">${(s.successRate || 0).toFixed(1)}%</td>
        <td style="padding:4px 6px;">${Math.round(s.averageLatencyMs || 0)}ms</td>
        <td style="padding:4px 6px;font-weight:bold;">${score}</td>
        <td style="padding:4px 6px;font-weight:bold;color:${heatColor};">${heat}</td>
        <td style="padding:4px 6px;" class="text-muted">${lastActive}</td>
      </tr>`;
    });
    html += '</table>';
    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `<div class="text-danger">Failed to load leaderboard: ${error.message}</div>`;
  }
}

// ============================================================
// DIAGNOSTICS
// ============================================================

async function testClobConnectivity() {
  const resultsDiv = document.getElementById('clobTestResults');
  resultsDiv.innerHTML = '<div class="text-center text-muted">Running tests...</div>';
  resultsDiv.classList.remove('hidden');

  try {
    const data = await API.testClobConnectivity();
    let html = '<strong>Test Results:</strong><br>';
    data.tests.forEach(test => {
      html += `<div style="margin:4px 0;"><span class="${test.success ? 'text-success' : 'text-danger'}">${test.success ? '[OK]' : '[FAIL]'}</span> ${test.name}: ${test.success ? 'Passed' : (test.error || `HTTP ${test.status}`)}</div>`;
    });
    html += `<br><strong>Diagnosis:</strong> ${data.summary.diagnosis}`;
    resultsDiv.innerHTML = html;
  } catch (error) { resultsDiv.innerHTML = `<div class="text-danger">Test failed: ${error.message}</div>`; }
}

async function loadFailedTrades() {
  const container = document.getElementById('failedTradesAnalysis');
  try {
    const data = await API.getFailedTrades();
    if (!data.trades || data.trades.length === 0) {
      container.innerHTML = '<div class="text-center text-muted">No failed trades found</div>';
      return;
    }
    let html = '<strong>Error Type Breakdown:</strong>';
    for (const [type, count] of Object.entries(data.analysis.errorTypes)) {
      html += `<div class="flex-between" style="padding:4px 0;border-bottom:1px solid var(--win-dark)"><span>${type}</span><span>${count}</span></div>`;
    }
    html += '<br><strong>Recent Failures:</strong>';
    html += data.trades.slice(0, 5).map(t => `
      <div class="issue-item error">
        <div>${t.errorType}: ${t.error?.slice(0, 100) || 'Unknown'}</div>
        <div class="text-sm text-muted">${new Date(t.timestamp).toLocaleString()}</div>
      </div>
    `).join('');
    container.innerHTML = html;
  } catch (error) { container.innerHTML = `<div class="text-danger">Failed to load: ${error.message}</div>`; }
}

// ============================================================
// MULTI-WALLET: TRADING WALLETS
// ============================================================

let masterPassword = '';
const usesHostedWalletAccess = () => window.__hostedMultiTenant === true;

// Enter key handlers for password fields
document.addEventListener('DOMContentLoaded', () => {
  if (usesHostedWalletAccess()) {
    return;
  }

  // Returning user: Enter on password field triggers unlock
  const existingPwInput = document.getElementById('masterPasswordInput');
  if (existingPwInput) {
    existingPwInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') unlockVault();
    });
  }

  // First-time user: Enter on confirm field triggers create
  const confirmPwInput = document.getElementById('masterPasswordConfirm');
  if (confirmPwInput) {
    confirmPwInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createMasterPassword();
    });
  }

  // First-time user: Enter on new password field moves focus to confirm
  const newPwInput = document.getElementById('masterPasswordNew');
  if (newPwInput) {
    newPwInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('masterPasswordConfirm').focus();
      }
    });
  }
});

async function checkLockStatus() {
  try {
    if (usesHostedWalletAccess()) {
      document.getElementById('unlockSection').classList.add('hidden');
      document.getElementById('tradingWalletsSection').classList.remove('hidden');
      await loadTradingWallets();
      return;
    }

    const data = await API.getLockStatus();
    if (data.unlocked) {
      document.getElementById('unlockSection').classList.add('hidden');
      document.getElementById('tradingWalletsSection').classList.remove('hidden');
      await loadTradingWallets();
    } else {
      // Show the right messaging based on whether wallets exist
      document.getElementById('unlockSection').classList.remove('hidden');
      document.getElementById('tradingWalletsSection').classList.add('hidden');
      const isFirstTime = (data.storedWalletCount || 0) === 0;
      document.getElementById('unlockFirstTime').classList.toggle('hidden', !isFirstTime);
      document.getElementById('unlockReturning').classList.toggle('hidden', isFirstTime);
    }
  } catch (error) { console.error('Error checking lock status:', error); }
}

// First-time setup: create a new master password with confirmation
async function createMasterPassword() {
  const pw = document.getElementById('masterPasswordNew').value;
  const confirm = document.getElementById('masterPasswordConfirm').value;
  const errorEl = document.getElementById('passwordMatchError');

  if (!pw) {
    errorEl.textContent = 'Please enter a password.';
    errorEl.classList.remove('hidden');
    return;
  }

  if (pw.length < 4) {
    errorEl.textContent = 'Password is too short (minimum 4 characters).';
    errorEl.classList.remove('hidden');
    return;
  }

  if (pw !== confirm) {
    errorEl.textContent = 'Passwords do not match. Please re-enter.';
    errorEl.classList.remove('hidden');
    document.getElementById('masterPasswordConfirm').value = '';
    document.getElementById('masterPasswordConfirm').focus();
    return;
  }

  errorEl.classList.add('hidden');

  try {
    const result = await API.unlockWallets(pw);
    masterPassword = pw;

    // Clear the fields
    document.getElementById('masterPasswordNew').value = '';
    document.getElementById('masterPasswordConfirm').value = '';

    if (result.migrated && window.__hostedMultiTenant !== true) {
      await win95Dialog.alert('Existing .env private key was migrated to encrypted storage as your "main" wallet.');
    }

    document.getElementById('unlockSection').classList.add('hidden');
    document.getElementById('tradingWalletsSection').classList.remove('hidden');
    await loadTradingWallets();
    await refreshSetupExperience();
  } catch (error) {
    errorEl.textContent = `Failed: ${error.message}`;
    errorEl.classList.remove('hidden');
  }
}

// Returning user: unlock with existing master password
async function unlockVault() {
  const pw = document.getElementById('masterPasswordInput').value;
  if (!pw) { await win95Dialog.alert('Enter your master password'); return; }

  try {
    const result = await API.unlockWallets(pw);
    masterPassword = pw;

    // Clear the field
    document.getElementById('masterPasswordInput').value = '';

    if (result.migrated && window.__hostedMultiTenant !== true) {
      await win95Dialog.alert('Existing .env private key was migrated to encrypted storage as "main" wallet.');
    }
    document.getElementById('unlockSection').classList.add('hidden');
    document.getElementById('tradingWalletsSection').classList.remove('hidden');
    await loadTradingWallets();
    await refreshSetupExperience();
  } catch (error) {
    await win95Dialog.error(`Unlock failed: ${error.message}`);
  }
}

async function loadTradingWallets() {
  try {
    const data = await API.getTradingWallets();
    const list = document.getElementById('tradingWalletsList');

    if (!data.wallets || data.wallets.length === 0) {
      list.innerHTML = '<div class="text-center text-muted" style="padding:20px;">No trading wallets configured. Add one above.</div>';
      updateTradingWalletDropdown([]);
      return;
    }

    list.innerHTML = data.wallets.map(w => {
      const escapedLabel = w.label.replace(/'/g, "\\'");
      return `
      <div class="trading-wallet-card ${w.isActive ? 'active-card' : 'inactive-card'}">
        <div class="flex-between flex-wrap gap-8">
          <div>
            <div class="text-bold">${w.label} <span class="win-badge ${w.isActive ? 'badge-success' : ''}">${w.id}</span></div>
            <div class="text-mono text-sm">${w.address}</div>
            <div class="text-sm text-muted">Created: ${new Date(w.createdAt).toLocaleDateString()}</div>
            <div class="text-sm" style="margin-top:2px;">
              ${w.hasCredentials
          ? '<span style="color:var(--win-green,green);">Builder API: Configured</span>'
          : '<span style="color:var(--win-red,#c00);font-weight:bold;">Builder API: Missing — cannot trade</span>'
        }
            </div>
          </div>
          <div class="flex-row gap-4">
            <button class="win-btn win-btn-sm" onclick="openTradingWalletSettingsModal('${w.id}', '${escapedLabel}')" title="Wallet settings (auto-redemption, etc.)">Settings</button>
            ${!w.hasCredentials ? `<button class="win-btn win-btn-sm" onclick="openBuilderCredsModal('${w.id}', '${escapedLabel}')" title="Add Builder API credentials">Add Creds</button>` : `<button class="win-btn win-btn-sm" onclick="openBuilderCredsModal('${w.id}', '${escapedLabel}')" title="Update Builder API credentials">Update Creds</button>`}
            <label class="win-toggle">
              <input type="checkbox" ${w.isActive ? 'checked' : ''} onchange="toggleTradingWalletActive('${w.id}', this.checked)">
            </label>
            <button class="win-btn win-btn-sm win-btn-danger" onclick="removeTradingWalletUI('${w.id}')">Remove</button>
          </div>
        </div>
      </div>
    `;
    }).join('');

    updateTradingWalletDropdown(data.wallets);
    loadCopyAssignments();
  } catch (error) {
    console.error('Error loading trading wallets:', error);
  }
}

function updateAssignmentDropdowns(trackedWallets) {
  const select = document.getElementById('assignTrackedWallet');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Select tracked wallet...</option>';
  if (trackedWallets) {
    trackedWallets.forEach(w => {
      select.innerHTML += `<option value="${w.address}">${w.label || w.address.slice(0, 12) + '...'}</option>`;
    });
  }
  if (current) select.value = current;
}

function updateTradingWalletDropdown(tradingWallets) {
  const select = document.getElementById('assignTradingWallet');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Select trading wallet...</option>';
  if (tradingWallets) {
    tradingWallets.forEach(w => {
      select.innerHTML += `<option value="${w.id}">${w.label} (${w.id})</option>`;
    });
  }
  if (current) select.value = current;
}

async function addNewTradingWallet() {
  const id = document.getElementById('newTradingWalletId').value.trim();
  const label = document.getElementById('newTradingWalletLabel').value.trim();
  const pk = document.getElementById('newTradingWalletKey').value.trim();
  const apiKey = document.getElementById('newTradingWalletApiKey').value.trim();
  const apiSecret = document.getElementById('newTradingWalletApiSecret').value.trim();
  const apiPassphrase = document.getElementById('newTradingWalletApiPassphrase').value.trim();
  const passwordForRequest = usesHostedWalletAccess() ? undefined : masterPassword;

  if (!id || !label || !pk) { await win95Dialog.alert('Wallet ID, Label, and Private Key are required'); return; }
  if (!usesHostedWalletAccess() && !masterPassword) { await win95Dialog.alert('Wallets must be unlocked first'); return; }

  if (!apiKey || !apiSecret || !apiPassphrase) {
    const proceed = await win95Dialog.confirm(
      'WARNING: You have not entered Builder API credentials.\n\n' +
      'Without these, this wallet CANNOT place orders on Polymarket.\n' +
      'Get them from: polymarket.com/settings → Builder tab\n\n' +
      'Add wallet anyway (credentials can be added later)?'
    );
    if (!proceed) return;
  }

  try {
    await API.addTradingWallet(id, label, pk, passwordForRequest, apiKey, apiSecret, apiPassphrase);
    document.getElementById('newTradingWalletId').value = '';
    document.getElementById('newTradingWalletLabel').value = '';
    document.getElementById('newTradingWalletKey').value = '';
    document.getElementById('newTradingWalletApiKey').value = '';
    document.getElementById('newTradingWalletApiSecret').value = '';
    document.getElementById('newTradingWalletApiPassphrase').value = '';
    await win95Dialog.success('Trading wallet added!');
    await loadTradingWallets();
    await refreshSetupExperience();
  } catch (error) {
    await win95Dialog.error(`Failed: ${error.message}`);
  }
}

async function removeTradingWalletUI(id) {
  if (!await win95Dialog.confirm(`Remove trading wallet "${id}"? This will delete the encrypted keystore.`)) return;
  try { await API.removeTradingWallet(id); await loadTradingWallets(); }
  catch (error) { await win95Dialog.error(`Failed: ${error.message}`); }
}

async function toggleTradingWalletActive(id, active) {
  try { await API.toggleTradingWallet(id, active); await loadTradingWallets(); }
  catch (error) { await win95Dialog.error(`Failed: ${error.message}`); await loadTradingWallets(); }
}

// ============================================================
// BUILDER CREDENTIALS MODAL
// ============================================================

async function openBuilderCredsModal(walletId, walletLabel) {
  if (!usesHostedWalletAccess() && !masterPassword) { await win95Dialog.alert('Wallets must be unlocked first'); return; }

  document.getElementById('builderCredsWalletId').value = walletId;
  document.getElementById('builderCredsWalletLabel').textContent = `${walletLabel} (${walletId})`;

  // Clear previous values
  document.getElementById('builderCredsApiKey').value = '';
  document.getElementById('builderCredsApiSecret').value = '';
  document.getElementById('builderCredsPassphrase').value = '';

  // Reset all fields to password type
  ['builderCredsApiKey', 'builderCredsApiSecret', 'builderCredsPassphrase'].forEach(id => {
    const input = document.getElementById(id);
    input.type = 'password';
    const btn = input.parentElement.querySelector('button');
    if (btn) btn.textContent = 'Show';
  });

  // Hide any previous error
  document.getElementById('builderCredsError').classList.add('hidden');

  // Show modal
  document.getElementById('builderCredsModal').classList.remove('hidden');

  // Focus the first field
  setTimeout(() => document.getElementById('builderCredsApiKey').focus(), 50);
}

function closeBuilderCredsModal() {
  document.getElementById('builderCredsModal').classList.add('hidden');

  // Clear sensitive data from inputs on close
  document.getElementById('builderCredsApiKey').value = '';
  document.getElementById('builderCredsApiSecret').value = '';
  document.getElementById('builderCredsPassphrase').value = '';
}

function toggleCredFieldVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
}

async function submitBuilderCredentials() {
  const walletId = document.getElementById('builderCredsWalletId').value;
  const apiKey = document.getElementById('builderCredsApiKey').value.trim();
  const apiSecret = document.getElementById('builderCredsApiSecret').value.trim();
  const apiPassphrase = document.getElementById('builderCredsPassphrase').value.trim();
  const passwordForRequest = usesHostedWalletAccess() ? undefined : masterPassword;

  const errorEl = document.getElementById('builderCredsError');
  const errorText = document.getElementById('builderCredsErrorText');

  // Validate all fields are filled
  if (!apiKey || !apiSecret || !apiPassphrase) {
    errorEl.classList.remove('hidden');
    errorText.textContent = 'All three fields are required.';
    return;
  }

  if (!usesHostedWalletAccess() && !masterPassword) {
    errorEl.classList.remove('hidden');
    errorText.textContent = 'Wallets must be unlocked first.';
    return;
  }

  // Hide error
  errorEl.classList.add('hidden');

  try {
    await API.updateTradingWalletCredentials(walletId, apiKey, apiSecret, apiPassphrase, passwordForRequest);
    closeBuilderCredsModal();
    await loadTradingWallets();
  } catch (error) {
    errorEl.classList.remove('hidden');
    errorText.textContent = `Failed: ${error.message}`;
  }
}

// Close modal when clicking the overlay background
document.addEventListener('click', (e) => {
  if (e.target.id === 'builderCredsModal') {
    closeBuilderCredsModal();
  }
  if (e.target.classList.contains('win-modal-overlay')) {
    const id = e.target.id;
    if (id === 'tradeDetailModal') closeTradeDetailModal();
    if (id === 'paperModeModal') closePaperModeModal();
    if (id === 'aboutModal') closeAboutModal();
    if (id === 'tradingWalletSettingsModal') closeTradingWalletSettingsModal();
  }
});

// Legacy alias for backward compat
function promptBuilderCredentials(walletId) {
  // Find the wallet label from the DOM
  const cards = document.querySelectorAll('.trading-wallet-card');
  let label = walletId;
  cards.forEach(card => {
    if (card.innerHTML.includes(`'${walletId}'`)) {
      const boldEl = card.querySelector('.text-bold');
      if (boldEl) label = boldEl.childNodes[0]?.textContent?.trim() || walletId;
    }
  });
  openBuilderCredsModal(walletId, label);
}

async function loadCopyAssignments() {
  try {
    const data = await API.getCopyAssignments();
    const list = document.getElementById('copyAssignmentsList');

    if (!data.assignments || data.assignments.length === 0) {
      list.innerHTML = '<div class="text-center text-muted" style="padding:12px;">No copy assignments yet</div>';
      return;
    }

    list.innerHTML = data.assignments.map(a => `
      <div class="flex-between" style="padding:4px 0;border-bottom:1px solid var(--win-dark)">
        <span class="text-mono text-sm">${a.trackedWalletAddress.slice(0, 10)}...</span>
        <span>-></span>
        <span class="text-bold">${a.tradingWalletId}</span>
        <span class="win-badge">${a.useOwnConfig ? 'Own config' : 'Inherited'}</span>
        <button class="win-btn win-btn-sm win-btn-danger" onclick="removeAssignment('${a.trackedWalletAddress}', '${a.tradingWalletId}')">X</button>
      </div>
    `).join('');
  } catch (error) { console.error('Error loading assignments:', error); }
}

async function addAssignment() {
  const tracked = document.getElementById('assignTrackedWallet').value;
  const trading = document.getElementById('assignTradingWallet').value;
  if (!tracked || !trading) { await win95Dialog.alert('Select both wallets'); return; }

  try {
    await API.addCopyAssignment(tracked, trading, false);
    await loadCopyAssignments();
  } catch (error) { await win95Dialog.error(`Failed: ${error.message}`); }
}

async function removeAssignment(tracked, trading) {
  try { await API.removeCopyAssignment(tracked, trading); await loadCopyAssignments(); }
  catch (error) { await win95Dialog.error(`Failed: ${error.message}`); }
}

// ============================================================
// MIRROR POSITIONS
// ============================================================

let currentMirrorWallet = null;
let currentMirrorTrades = [];
let currentMirrorPreview = null;

async function openMirrorModal(address) {
  currentMirrorWallet = address;
  document.getElementById('mirrorModalTitle').textContent = 'Loading Mirror Preview...';
  document.getElementById('mirrorTradesBody').innerHTML = '<tr class="empty-row"><td colspan="8">Loading positions...</td></tr>';
  document.getElementById('mirrorExecuteBtn').disabled = true;
  document.getElementById('mirrorBalanceWarning').classList.add('hidden');
  document.getElementById('mirrorModal').classList.remove('hidden');

  try {
    const walletsData = await API.getWallets();
    const wallet = walletsData.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    document.getElementById('mirrorModalTitle').textContent = `Mirror: ${wallet?.label || address.slice(0, 10) + '...'}`;

    const preview = await API.getMirrorPreview(address, 10);
    currentMirrorPreview = preview;

    document.getElementById('mirrorYourPortfolio').textContent = `$${formatNumber(preview.yourPortfolioValue)}`;
    document.getElementById('mirrorYourUsdc').textContent = `$${formatNumber(preview.yourUsdcBalance || 0)}`;
    document.getElementById('mirrorTheirPortfolio').textContent = `$${formatNumber(preview.theirPortfolioValue)}`;

    currentMirrorTrades = preview.trades;
    renderMirrorTrades(preview.trades);
    updateMirrorSummary();
  } catch (error) {
    document.getElementById('mirrorTradesBody').innerHTML = `<tr class="empty-row"><td colspan="8">Mirror preview failed: ${error.message}</td></tr>`;
  }
}

function renderMirrorTrades(trades) {
  const tbody = document.getElementById('mirrorTradesBody');
  if (!trades || trades.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No positions to mirror</td></tr>';
    return;
  }

  const actionable = [], skipped = [];
  trades.forEach((trade, i) => {
    trade._originalIndex = i;
    if (trade.status === 'skipped' || trade.action === 'SKIP') skipped.push(trade);
    else actionable.push(trade);
  });

  let html = actionable.map(t => renderMirrorRow(t, false)).join('');

  if (skipped.length > 0) {
    html += `<tr><td colspan="8" style="background:var(--win-surface);cursor:pointer;padding:4px 8px;font-size:12px;" onclick="toggleSkippedAccordion()">
      <span id="skippedAccordionIcon">+</span> Skipped positions (${skipped.length})</td></tr>`;
    html += skipped.map(t => renderMirrorRow(t, true)).join('');
  }

  tbody.innerHTML = html;

  const hasVisibleTargetTrade = actionable.some((trade) => (trade.theirShares || 0) > 0);
  const shouldExpandSkipped = skipped.length > 0 && !hasVisibleTargetTrade;
  document.querySelectorAll('.skipped-row').forEach(r => r.style.display = shouldExpandSkipped ? '' : 'none');
  const icon = document.getElementById('skippedAccordionIcon');
  if (icon) {
    icon.textContent = shouldExpandSkipped ? '-' : '+';
  }
}

function renderMirrorRow(trade, isSkipped) {
  const actionClass = trade.action === 'BUY' ? 'text-success' : (trade.action === 'SELL' ? 'text-danger' : 'text-muted');
  const checkbox = !isSkipped
    ? `<input type="checkbox" ${trade.selected ? 'checked' : ''} onchange="toggleMirrorTrade(${trade._originalIndex}, this.checked)">`
    : '-';

  const tradeDetails = trade.action === 'SKIP' ? '-'
    : `${trade.action === 'BUY' ? '+' : '-'}${trade.sharesToTrade.toFixed(1)} ($${Math.abs(trade.estimatedCost).toFixed(2)})`;

  return `
    <tr class="${isSkipped ? 'skipped-row' : ''}" style="${isSkipped ? 'opacity:0.5' : ''}">
      <td>${checkbox}</td>
      <td>${trade.marketTitle.slice(0, 25)}${trade.marketTitle.length > 25 ? '...' : ''}<br><span class="text-sm text-muted">${trade.outcome}</span></td>
      <td>${trade.theirShares.toFixed(1)}<br><span class="text-sm text-muted">${trade.theirAllocationPercent.toFixed(1)}%</span></td>
      <td>${trade.yourShares.toFixed(1)}<br><span class="text-sm text-muted">${trade.yourAllocationPercent.toFixed(1)}%</span></td>
      <td><span class="${actionClass} text-bold">${trade.action}</span></td>
      <td>${tradeDetails}</td>
      <td>$${trade.currentPrice.toFixed(2)}</td>
      <td><span class="status-pill ${trade.status === 'ready' ? 'success' : (trade.status === 'warning' ? 'pending' : '')}">${isSkipped ? (trade.warning || 'Skipped') : trade.status}</span></td>
    </tr>`;
}

function toggleSkippedAccordion() {
  const icon = document.getElementById('skippedAccordionIcon');
  const rows = document.querySelectorAll('.skipped-row');
  const showing = rows[0]?.style.display !== 'none';
  rows.forEach(r => r.style.display = showing ? 'none' : '');
  icon.textContent = showing ? '+' : '-';
}

function toggleMirrorTrade(index, selected) {
  if (currentMirrorTrades[index]) {
    currentMirrorTrades[index].selected = selected;
    updateMirrorSummary();
  }
}

function updateMirrorSummary() {
  const selected = currentMirrorTrades.filter(t => t.selected && t.action !== 'SKIP');
  const buys = selected.filter(t => t.action === 'BUY');
  const sells = selected.filter(t => t.action === 'SELL');
  const buyCost = buys.reduce((s, t) => s + t.estimatedCost, 0);
  const sellProceeds = Math.abs(sells.reduce((s, t) => s + t.estimatedCost, 0));

  const parts = [];
  if (buys.length) parts.push(`<span class="buy-summary">${buys.length} BUY ($${buyCost.toFixed(2)})</span>`);
  if (sells.length) parts.push(`<span class="sell-summary">${sells.length} SELL (+$${sellProceeds.toFixed(2)})</span>`);

  document.getElementById('mirrorSummaryText').innerHTML = parts.length === 0 ? 'No trades selected' : `Selected: ${parts.join(' | ')}`;
  document.getElementById('mirrorExecuteBtn').disabled = selected.length === 0;

  // Balance warning
  const warningEl = document.getElementById('mirrorBalanceWarning');
  if (currentMirrorPreview && buyCost > 0) {
    const available = (currentMirrorPreview.yourUsdcBalance || 0) + sellProceeds;
    if (buyCost > available) {
      warningEl.classList.remove('hidden');
      document.getElementById('mirrorWarningDetails').innerHTML =
        `Need $${buyCost.toFixed(2)} but only $${available.toFixed(2)} available. Some buys may fail.`;
    } else {
      warningEl.classList.add('hidden');
    }
  } else {
    warningEl.classList.add('hidden');
  }
}

async function executeMirrorTrades() {
  const selected = currentMirrorTrades.filter(t => t.selected && t.action !== 'SKIP');
  if (selected.length === 0) { await win95Dialog.alert('No trades selected'); return; }
  if (!await win95Dialog.confirm(`Execute ${selected.length} trade(s)? This will place real orders.`)) return;

  const btn = document.getElementById('mirrorExecuteBtn');
  btn.disabled = true;
  btn.textContent = 'Executing...';

  try {
    const tradesToSend = selected.map(t => ({
      tokenId: t.tokenId, marketTitle: t.marketTitle.slice(0, 50),
      action: t.action, sharesToTrade: t.sharesToTrade,
      currentPrice: t.currentPrice, negRisk: t.negRisk, selected: true
    }));

    const result = await API.executeMirrorTrades(currentMirrorWallet, tradesToSend, 2);
    let msg = '';
    if (result.summary) {
      msg += `SELL: ${result.summary.sellsSucceeded}/${result.summary.sellsAttempted} | BUY: ${result.summary.buysSucceeded}/${result.summary.buysAttempted}\n\n`;
    }
    if (result.success) msg = `All ${result.executedTrades} trade(s) executed!\n\n` + msg;
    else msg = `Partial: ${result.executedTrades} succeeded, ${result.failedTrades} failed\n\n` + msg;

    result.success ? await win95Dialog.success(msg) : await win95Dialog.error(msg);
    closeMirrorModal();
  } catch (error) {
    await win95Dialog.error(`Execution failed: ${error.message}`);
    btn.disabled = false;
    btn.textContent = 'Execute Selected';
  }
}

function closeMirrorModal() {
  document.getElementById('mirrorModal').classList.add('hidden');
  document.getElementById('mirrorBalanceWarning').classList.add('hidden');
  currentMirrorWallet = null;
  currentMirrorTrades = [];
  currentMirrorPreview = null;
}

// ============================================================
// LADDER EXITS
// ============================================================

// Holds the position data the user selected for ladder creation
let selectedLadderPosition = null;

async function loadLadderStatus() {
  try {
    const [statusData, laddersData, monitorData] = await Promise.all([
      API.getLadderStatus(),
      API.getLadders(),
      API.getPriceMonitorStatus()
    ]);

    // Update status badges
    const monitorEl = document.getElementById('ladderPriceMonitorStatus');
    if (monitorData.isRunning) {
      monitorEl.textContent = 'RUNNING';
      monitorEl.className = 'win-badge badge-success';
    } else {
      monitorEl.textContent = 'OFF';
      monitorEl.className = 'win-badge';
    }

    const modeEl = document.getElementById('ladderModeStatus');
    if (statusData.config && statusData.config.liveMode) {
      modeEl.textContent = 'LIVE';
      modeEl.className = 'win-badge badge-danger';
    } else {
      modeEl.textContent = 'PAPER';
      modeEl.className = 'win-badge badge-warning';
    }

    // Pre-fill ladder config defaults from server config
    if (statusData.config) {
      const cfg = statusData.config;
      if (cfg.defaultStepCount) document.getElementById('ladderStepCount').value = cfg.defaultStepCount;
      if (cfg.defaultStartPercent) document.getElementById('ladderStartPercent').value = cfg.defaultStartPercent;
      if (cfg.defaultStepSpread) document.getElementById('ladderStepSpread').value = cfg.defaultStepSpread;
      if (cfg.defaultSellPercent) document.getElementById('ladderSellPercent').value = cfg.defaultSellPercent;
    }

    // Render active ladders
    const container = document.getElementById('activeLaddersList');
    const ladders = laddersData.ladders || [];
    const activeLadders = ladders.filter(l => l.isActive);
    const completedLadders = ladders.filter(l => !l.isActive);

    if (activeLadders.length === 0 && completedLadders.length === 0) {
      container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">No ladders configured. Click "+ New Ladder" to set up automatic take-profit levels from your positions.</div>';
      return;
    }

    let html = '';

    for (const ladder of activeLadders) {
      const executedSteps = ladder.steps.filter(s => s.executed).length;
      const totalSteps = ladder.steps.length;
      const progressPct = totalSteps > 0 ? Math.round((executedSteps / totalSteps) * 100) : 0;

      html += `
        <div style="background:var(--win-surface);border:1px solid var(--win-dark);padding:8px;margin-bottom:4px;">
          <div class="flex-between">
            <div>
              <span class="text-bold">${ladder.marketTitle || ladder.tokenId.slice(0, 12) + '...'}</span>
              <span class="win-badge badge-success">${ladder.outcome}</span>
              <span class="text-sm text-muted">Entry: $${ladder.entryPrice.toFixed(2)}</span>
            </div>
            <button class="win-btn win-btn-sm win-btn-danger" onclick="cancelLadder('${ladder.id}')" aria-label="Cancel this ladder exit" tabindex="0">Cancel</button>
          </div>
          <div class="flex-row gap-8 mt-4" style="margin-top:4px;">
            <span class="text-sm">Remaining: ${ladder.remainingShares.toFixed(1)} / ${ladder.totalShares.toFixed(1)} shares</span>
            <span class="text-sm">Steps: ${executedSteps}/${totalSteps}</span>
          </div>
          <div style="background:var(--win-dark);height:6px;margin-top:4px;border:1px inset;">
            <div style="background:#00aa00;height:100%;width:${progressPct}%;"></div>
          </div>
          <div class="flex-row gap-4 mt-4" style="margin-top:4px;flex-wrap:wrap;">
            ${ladder.steps.map((step, i) => `
              <span class="text-sm" style="padding:2px 4px;border:1px solid var(--win-dark);background:${step.executed ? '#d4edda' : 'var(--win-surface)'};">
                $${step.triggerPrice.toFixed(2)} (${step.sellPercent}%)
                ${step.executed ? ' &#10003;' : ''}
              </span>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (completedLadders.length > 0) {
      html += `<div class="text-sm text-muted" style="padding:4px 0;margin-top:4px;">${completedLadders.length} completed ladder(s)</div>`;
    }

    container.innerHTML = html;
  } catch (error) {
    console.error('Error loading ladder status:', error);
  }
}

async function openCreateLadderForm() {
  const form = document.getElementById('createLadderForm');
  form.classList.remove('hidden');
  document.getElementById('ladderConfigPanel').classList.add('hidden');
  selectedLadderPosition = null;

  // Populate trading wallet dropdown
  const select = document.getElementById('ladderWalletSelect');
  try {
    const data = await API.getTradingWallets();
    const wallets = data.wallets || [];
    select.innerHTML = '<option value="">-- Select a wallet --</option>';
    for (const w of wallets) {
      const label = w.label || w.id;
      const addr = w.address ? ` (${w.address.slice(0, 6)}...${w.address.slice(-4)})` : '';
      const activeTag = w.isActive ? '' : ' [inactive]';
      select.innerHTML += `<option value="${w.id}">${label}${addr}${activeTag}</option>`;
    }
    if (wallets.length === 0) {
      select.innerHTML = '<option value="">No trading wallets configured</option>';
    }
  } catch (error) {
    select.innerHTML = '<option value="">Failed to load wallets</option>';
    console.error('Error loading trading wallets for ladder:', error);
  }

  document.getElementById('ladderPositionsList').innerHTML =
    '<div class="text-center text-muted" style="padding:12px;">Select a trading wallet to see your positions</div>';
}

function closeCreateLadderForm() {
  document.getElementById('createLadderForm').classList.add('hidden');
  document.getElementById('ladderConfigPanel').classList.add('hidden');
  selectedLadderPosition = null;
}

async function loadWalletPositionsForLadder() {
  const walletId = document.getElementById('ladderWalletSelect').value;
  const container = document.getElementById('ladderPositionsList');

  if (!walletId) {
    container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">Select a trading wallet to see your positions</div>';
    return;
  }

  container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">Loading positions...</div>';

  try {
    const data = await API.getTradingWalletPositions(walletId);
    const positions = (data.positions || []).filter(p => parseFloat(p.size) > 0);

    if (positions.length === 0) {
      container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">No open positions found for this wallet</div>';
      return;
    }

    let html = '';
    for (const pos of positions) {
      const size = parseFloat(pos.size || 0);
      const avgPrice = parseFloat(pos.avgPrice || 0);
      const curPrice = parseFloat(pos.curPrice || 0);
      const pnl = (curPrice - avgPrice) * size;
      const pnlPct = avgPrice > 0 ? ((curPrice - avgPrice) / avgPrice * 100) : 0;
      const pnlColor = pnl >= 0 ? '#00aa00' : '#cc0000';
      const title = pos.title || pos.conditionId?.slice(0, 16) || 'Unknown Market';
      const outcome = pos.outcome || 'Yes';

      // Escape data for onclick
      const posJson = JSON.stringify({
        tokenId: pos.asset,
        conditionId: pos.conditionId,
        marketTitle: title,
        outcome: outcome.toUpperCase(),
        entryPrice: avgPrice,
        curPrice: curPrice,
        totalShares: size
      }).replace(/'/g, "\\'").replace(/"/g, '&quot;');

      html += `
        <div style="background:var(--win-surface);border:1px solid var(--win-dark);padding:8px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;">
          <div style="flex:1;min-width:0;">
            <div class="text-bold" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title}</div>
            <div class="flex-row gap-8" style="margin-top:2px;">
              <span class="win-badge ${outcome.toUpperCase() === 'YES' ? 'badge-success' : 'badge-danger'}">${outcome}</span>
              <span class="text-sm">${size.toFixed(1)} shares</span>
              <span class="text-sm">Avg: $${avgPrice.toFixed(3)}</span>
              <span class="text-sm">Now: $${curPrice.toFixed(3)}</span>
              <span class="text-sm" style="color:${pnlColor};font-weight:bold;">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)</span>
            </div>
          </div>
          <button class="win-btn win-btn-sm win-btn-primary" style="margin-left:8px;white-space:nowrap;"
            onclick="selectPositionForLadder(this, '${posJson}')"
            aria-label="Add ladder exit for ${title}" tabindex="0">
            Add Ladder
          </button>
        </div>
      `;
    }

    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `<div class="text-center text-muted" style="padding:12px;">Failed to load positions: ${error.message}</div>`;
    console.error('Error loading positions for ladder:', error);
  }
}

function selectPositionForLadder(btn, posJsonEncoded) {
  const pos = JSON.parse(posJsonEncoded.replace(/&quot;/g, '"'));
  selectedLadderPosition = pos;

  // Show config panel
  const panel = document.getElementById('ladderConfigPanel');
  panel.classList.remove('hidden');

  // Update summary
  const summary = document.getElementById('ladderConfigPositionSummary');
  summary.innerHTML = `<strong>${pos.marketTitle}</strong> | ${pos.outcome} | ${pos.totalShares.toFixed(1)} shares @ $${pos.entryPrice.toFixed(3)} (now $${pos.curPrice.toFixed(3)})`;

  // Scroll config panel into view
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelLadderConfig() {
  document.getElementById('ladderConfigPanel').classList.add('hidden');
  selectedLadderPosition = null;
}

async function confirmCreateLadder() {
  if (!selectedLadderPosition) {
    await win95Dialog.alert('No position selected. Please select a position first.');
    return;
  }

  const stepCount = parseInt(document.getElementById('ladderStepCount').value) || 4;
  const startPercent = parseFloat(document.getElementById('ladderStartPercent').value) || 10;
  const stepSpread = parseFloat(document.getElementById('ladderStepSpread').value) || 10;
  const sellPercent = parseFloat(document.getElementById('ladderSellPercent').value) || 25;

  // Build steps array from the config
  const steps = [];
  for (let i = 0; i < stepCount; i++) {
    const triggerPct = startPercent + (i * stepSpread);
    const triggerPrice = selectedLadderPosition.entryPrice * (1 + triggerPct / 100);
    steps.push({
      triggerPrice: Math.min(triggerPrice, 0.99),
      sellPercent: sellPercent
    });
  }

  try {
    await API.createLadder({
      tokenId: selectedLadderPosition.tokenId,
      conditionId: selectedLadderPosition.conditionId || selectedLadderPosition.tokenId,
      marketTitle: selectedLadderPosition.marketTitle,
      outcome: selectedLadderPosition.outcome,
      entryPrice: selectedLadderPosition.entryPrice,
      totalShares: selectedLadderPosition.totalShares,
      steps: steps
    });
    cancelLadderConfig();
    closeCreateLadderForm();
    await loadLadderStatus();
  } catch (error) {
    await win95Dialog.error(`Failed to create ladder: ${error.message}`);
  }
}

async function cancelLadder(id) {
  if (!await win95Dialog.confirm('Cancel this ladder exit? No further steps will execute.')) return;
  try {
    await API.cancelLadder(id);
    await loadLadderStatus();
  } catch (error) {
    await win95Dialog.error(`Failed to cancel ladder: ${error.message}`);
  }
}

async function toggleLadderLiveMode() {
  try {
    const status = await API.getLadderStatus();
    const currentLive = status.config?.liveMode || false;
    const newMode = !currentLive;

    if (newMode && !await win95Dialog.confirm('Enable LIVE mode? Ladder steps will execute REAL sell orders on Polymarket. Make sure you understand the risks.')) {
      return;
    }

    await API.updateLadderConfig({ liveMode: newMode });
    await loadLadderStatus();
  } catch (error) {
    await win95Dialog.error(`Failed to toggle mode: ${error.message}`);
  }
}

// ============================================================
// PLATFORMS TAB
// ============================================================

async function loadPlatformStatus() {
  loadEntityPlatformMap();
  try {
    const data = await API.getPlatforms();
    const grid = document.getElementById('platformStatusGrid');
    if (!data.platforms || data.platforms.length === 0) {
      grid.innerHTML = '<div class="text-center text-muted">No platforms configured</div>';
      return;
    }

    grid.innerHTML = data.platforms.map(p => `
      <div class="platform-card ${p.configured ? 'configured' : 'not-configured'}">
        <div class="platform-card-header">
          <span class="platform-icon">${p.platform === 'polymarket' ? '&#9670;' : '&#9679;'}</span>
          <strong>${p.label}</strong>
          <span class="platform-badge ${p.configured ? 'badge-success' : 'badge-warning'}">
            ${p.configured ? 'Connected' : 'Not Configured'}
          </span>
        </div>
        <div class="platform-card-body">
          <div>Data: ${p.configured ? 'Available' : 'Unavailable'}</div>
          <div>Execution: ${p.canExecute ? 'Ready' : 'No credentials'}</div>
        </div>
      </div>
    `).join('');

    // Update status bar
    data.platforms.forEach(p => {
      if (p.platform === 'polymarket') {
        const el = document.getElementById('statusBarPoly');
        el.textContent = `POLY: ${p.configured ? 'OK' : '--'}`;
        el.style.color = p.configured ? '#00aa00' : '#666';
      }
      if (p.platform === 'kalshi') {
        const el = document.getElementById('statusBarKalshi');
        el.textContent = `KALSHI: ${p.configured ? 'OK' : '--'}`;
        el.style.color = p.configured ? '#00aa00' : '#666';
      }
    });

    // Load balances
    loadPlatformBalances();
  } catch (err) {
    console.error('Failed to load platform status:', err);
  }
}

async function loadPlatformBalances() {
  try {
    const [polyBal, kalshiBal] = await Promise.allSettled([
      API.getPlatformBalance('polymarket'),
      API.getPlatformBalance('kalshi')
    ]);

    const polyVal = polyBal.status === 'fulfilled' && polyBal.value.balance != null ? polyBal.value.balance : null;
    const kalshiVal = kalshiBal.status === 'fulfilled' && kalshiBal.value.balance != null ? kalshiBal.value.balance : null;

    document.getElementById('polymarketBalance').textContent = polyVal != null ? `$${polyVal.toFixed(2)}` : '--';
    document.getElementById('kalshiBalance').textContent = kalshiVal != null ? `$${kalshiVal.toFixed(2)}` : '--';

    const total = (polyVal || 0) + (kalshiVal || 0);
    document.getElementById('totalCrossBalance').textContent = total > 0 ? `$${total.toFixed(2)}` : '--';
  } catch (err) {
    console.error('Failed to load platform balances:', err);
  }
}

async function saveKalshiConfig() {
  const apiKeyId = document.getElementById('kalshiApiKeyId').value.trim();
  const privateKeyPem = document.getElementById('kalshiPrivateKeyPem').value.trim();
  if (!apiKeyId || !privateKeyPem) {
    await win95Dialog.alert('Both API Key ID and Private Key PEM are required');
    return;
  }
  try {
    await API.post('/config/kalshi', { apiKeyId, privateKeyPem });
    await win95Dialog.success('Kalshi configuration saved');
    loadPlatformStatus();
  } catch (err) {
    await win95Dialog.error(`Failed to save: ${err.message}`);
  }
}

async function testKalshiConnection() {
  const resultEl = document.getElementById('kalshiTestResult');
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = '<div class="text-muted">Testing connection...</div>';
  try {
    const result = await API.getPlatformBalance('kalshi');
    resultEl.innerHTML = `<div class="text-center" style="color:green;">Connected! Balance: $${(result.balance || 0).toFixed(2)}</div>`;
  } catch (err) {
    resultEl.innerHTML = `<div class="text-center" style="color:red;">Connection failed: ${err.message}</div>`;
  }
}

async function loadEntityPlatformMap() {
  try {
    const data = await API.getEntities();
    const container = document.getElementById('entityPlatformMap');
    if (!data.entities || data.entities.length === 0) {
      container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">No entities configured. Create entities in the Dashboard first.</div>';
      return;
    }

    container.innerHTML = data.entities.map(entity => {
      const wallets = entity.platformWallets || entity.walletAddresses.map(a => ({ platform: 'polymarket', identifier: a }));
      return `
        <div class="entity-map-card">
          <div class="entity-map-header">
            <strong>${entity.label || entity.id}</strong>
            <span class="text-muted">(${wallets.length} wallet${wallets.length !== 1 ? 's' : ''})</span>
          </div>
          <div class="entity-map-wallets">
            ${wallets.map(w => `
              <div class="entity-wallet-row">
                <span class="platform-badge ${w.platform === 'polymarket' ? 'badge-poly' : 'badge-kalshi'}">${w.platform}</span>
                <span class="address">${w.identifier.length > 20 ? w.identifier.slice(0, 8) + '...' + w.identifier.slice(-6) : w.identifier}</span>
                <button class="win-btn win-btn-sm" onclick="removePlatformWalletUI('${entity.id}', '${w.platform}', '${w.identifier}')" title="Remove">X</button>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load entity map:', err);
  }
}

async function addPlatformWalletDialog() {
  const entityId = await win95Dialog.prompt('Entity ID:');
  if (!entityId) return;
  const platform = await win95Dialog.prompt('Platform (polymarket or kalshi):');
  if (!platform || !['polymarket', 'kalshi'].includes(platform)) {
    await win95Dialog.error('Platform must be "polymarket" or "kalshi"');
    return;
  }
  const identifier = await win95Dialog.prompt(`${platform === 'polymarket' ? 'Wallet address (0x...)' : 'Kalshi account ID'}:`);
  if (!identifier) return;

  try {
    await API.addPlatformWallet(entityId, platform, identifier);
    await win95Dialog.success('Platform wallet linked!');
    loadEntityPlatformMap();
  } catch (err) {
    await win95Dialog.error(`Failed: ${err.message}`);
  }
}

async function removePlatformWalletUI(entityId, platform, identifier) {
  if (!await win95Dialog.confirm(`Remove ${platform} wallet ${identifier.slice(0, 12)}... from entity?`)) return;
  try {
    await API.removePlatformWallet(entityId, platform, identifier);
    loadEntityPlatformMap();
  } catch (err) {
    await win95Dialog.error(`Failed: ${err.message}`);
  }
}

// ============================================================
// CROSS-PLATFORM TAB
// ============================================================

async function refreshExecutorStatus() {
  try {
    const data = await API.getExecutorStatus();
    document.getElementById('execPaperMode').textContent = data.paperMode ? 'ON' : 'OFF';
    document.getElementById('execPaperMode').style.color = data.paperMode ? '#aa8800' : '#00aa00';
    document.getElementById('execSuccessful').textContent = data.successfulArbs || 0;
    document.getElementById('execPartialFills').textContent = data.partialFills || 0;
    document.getElementById('execTotal').textContent = data.totalExecutions || 0;
    loadExecutionHistory();
  } catch (err) {
    console.error('Failed to load executor status:', err);
  }
}

async function toggleExecutorPaperMode() {
  try {
    const current = await API.getExecutorConfig();
    await API.updateExecutorConfig({ paperMode: !current.config.paperMode });
    refreshExecutorStatus();
  } catch (err) {
    await win95Dialog.error(`Failed: ${err.message}`);
  }
}

async function scanArbitrageOpportunities() {
  try {
    const tbody = document.getElementById('arbTableBody');
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Scanning...</td></tr>';

    const data = await API.scanArbitrage();
    const opps = data.opportunities || [];

    if (opps.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No arbitrage opportunities found</td></tr>';
      return;
    }

    tbody.innerHTML = opps.map(opp => `
      <tr>
        <td title="${opp.eventTitle}">${(opp.eventTitle || '').slice(0, 35)}...</td>
        <td>${(opp.polymarketPrice * 100).toFixed(1)}c</td>
        <td>${(opp.kalshiPrice * 100).toFixed(1)}c</td>
        <td class="${opp.spreadPercent > 3 ? 'text-success' : ''}">${opp.spreadPercent.toFixed(1)}%</td>
        <td>$${(opp.expectedProfit || 0).toFixed(2)}</td>
        <td>
          <button class="win-btn win-btn-sm win-btn-primary" onclick='executeArbFromTable(${JSON.stringify(opp)})'>
            Execute
          </button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    await win95Dialog.error(`Scan failed: ${err.message}`);
  }
}

async function executeArbFromTable(opp) {
  if (!await win95Dialog.confirm(`Execute arb on "${opp.eventTitle}"?\nSpread: ${opp.spreadPercent.toFixed(1)}%`)) return;

  try {
    const trade = {
      id: `arb-${Date.now()}`,
      eventTitle: opp.eventTitle,
      buyPlatform: opp.cheaperPlatform,
      buyMarketId: opp.cheaperPlatform === 'polymarket' ? opp.polymarketTokenId : opp.kalshiTicker,
      buySide: 'YES',
      buyPrice: opp.cheaperPlatform === 'polymarket' ? opp.polymarketPrice : opp.kalshiPrice,
      buySize: 10,
      sellPlatform: opp.cheaperPlatform === 'polymarket' ? 'kalshi' : 'polymarket',
      sellMarketId: opp.cheaperPlatform === 'polymarket' ? opp.kalshiTicker : opp.polymarketTokenId,
      sellSide: 'NO',
      sellPrice: opp.cheaperPlatform === 'polymarket' ? opp.kalshiPrice : opp.polymarketPrice,
      sellSize: 10,
      expectedProfit: opp.expectedProfit || 0,
      spreadPercent: opp.spreadPercent,
    };

    const result = await API.executeArb(trade);
    if (result.result.bothSucceeded) {
      await win95Dialog.success('Arb executed successfully!');
    } else if (result.result.partialFill) {
      await win95Dialog.error('WARNING: Partial fill — one leg failed. Check execution history.');
    } else {
      await win95Dialog.error('Execution failed. Check execution history for details.');
    }
    refreshExecutorStatus();
  } catch (err) {
    await win95Dialog.error(`Execution failed: ${err.message}`);
  }
}

async function detectCrossPlatformHedges() {
  try {
    const tbody = document.getElementById('crossHedgeTableBody');
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Scanning...</td></tr>';

    const data = await API.detectCrossPlatformHedges();
    const hedges = data.hedges || [];

    if (hedges.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No cross-platform hedges detected</td></tr>';
      return;
    }

    tbody.innerHTML = hedges.map(h => `
      <tr>
        <td>${h.entityLabel}</td>
        <td title="${h.eventTitle}">${h.eventTitle.slice(0, 30)}...</td>
        <td>${h.polymarketPosition.side} / ${h.polymarketPosition.size.toFixed(1)}</td>
        <td>${h.kalshiPosition.side} / ${h.kalshiPosition.size.toFixed(1)}</td>
        <td class="${h.isHedged ? 'text-success' : 'text-warning'}">${h.isHedged ? 'Yes' : 'No'}</td>
        <td>${h.netExposure}</td>
      </tr>
    `).join('');
  } catch (err) {
    await win95Dialog.error(`Hedge detection failed: ${err.message}`);
  }
}

async function generateHedgeRecommendations() {
  try {
    const container = document.getElementById('hedgeRecommendations');
    container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">Generating recommendations...</div>';

    const data = await API.generateHedgeRecommendations();
    const recs = data.recommendations || [];

    if (recs.length === 0) {
      container.innerHTML = '<div class="text-center text-muted" style="padding:12px;">No recommendations at this time</div>';
      return;
    }

    container.innerHTML = recs.map(rec => `
      <div class="hedge-rec-card">
        <div class="hedge-rec-header">
          <span class="platform-badge ${rec.platform === 'polymarket' ? 'badge-poly' : 'badge-kalshi'}">${rec.platform}</span>
          <strong>${rec.action} ${rec.outcome}</strong>
          <span class="text-muted">— ${(rec.marketTitle || '').slice(0, 40)}</span>
        </div>
        <div class="hedge-rec-details">
          <span>Size: ${rec.size.toFixed(2)}</span>
          <span>Est. Price: $${rec.estimatedPrice.toFixed(2)}</span>
          <span>Confidence: ${(rec.confidence * 100).toFixed(0)}%</span>
        </div>
        <div class="hedge-rec-actions">
          ${rec.executable
        ? `<button class="win-btn win-btn-sm win-btn-primary" onclick='executeHedgeRec(${JSON.stringify(rec)})'>Execute</button>`
        : '<span class="text-muted">Not executable</span>'
      }
        </div>
      </div>
    `).join('');
  } catch (err) {
    await win95Dialog.error(`Failed: ${err.message}`);
  }
}

async function executeHedgeRec(rec) {
  if (!await win95Dialog.confirm(`Execute ${rec.action} ${rec.outcome} on ${rec.platform}?`)) return;
  try {
    const result = await API.executeHedge({
      platform: rec.platform,
      marketId: rec.tokenId || rec.kalshiTicker,
      side: rec.outcome,
      action: rec.action,
      size: rec.size,
      price: rec.estimatedPrice,
    });
    if (result.result.success) {
      await win95Dialog.success('Hedge executed!');
    } else {
      await win95Dialog.error(`Failed: ${result.result.error}`);
    }
    refreshExecutorStatus();
  } catch (err) {
    await win95Dialog.error(`Failed: ${err.message}`);
  }
}

async function loadExecutionHistory() {
  try {
    const data = await API.getExecutorHistory();
    const history = (data.history || []).slice(-20).reverse();
    const tbody = document.getElementById('execHistoryTableBody');

    if (history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No executions yet</td></tr>';
      return;
    }

    tbody.innerHTML = history.map(exec => `
      <tr>
        <td>${new Date(exec.timestamp).toLocaleString()}</td>
        <td>Arb</td>
        <td class="${exec.bothSucceeded ? 'text-success' : exec.partialFill ? 'text-warning' : 'text-danger'}">
          ${exec.bothSucceeded ? 'Success' : exec.partialFill ? 'Partial' : 'Failed'}
        </td>
        <td>${exec.buyResult.platform}: ${exec.buyResult.success ? 'OK' : exec.buyResult.error?.slice(0, 20)}</td>
        <td>${exec.sellResult.platform}: ${exec.sellResult.success ? 'OK' : exec.sellResult.error?.slice(0, 20)}</td>
        <td>${exec.paperMode ? 'Yes' : 'No'}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load execution history:', err);
  }
}

async function saveExecutorConfig() {
  try {
    await API.updateExecutorConfig({
      maxTradeSize: parseFloat(document.getElementById('execMaxTradeSize').value),
      minSpread: parseFloat(document.getElementById('execMinSpread').value),
      simultaneousExecution: document.getElementById('execSimultaneous').checked,
    });
    await win95Dialog.success('Executor config saved');
  } catch (err) {
    await win95Dialog.error(`Failed: ${err.message}`);
  }
}

// ============================================================
// PAPER MODE INFO MODAL
// ============================================================

const openPaperModeModal = () => {
  document.getElementById('paperModeModal').classList.remove('hidden');
};

const closePaperModeModal = () => {
  document.getElementById('paperModeModal').classList.add('hidden');
};

// ============================================================
// ABOUT MODAL
// ============================================================

const openAboutModal = () => {
  document.getElementById('aboutModal').classList.remove('hidden');
};

const closeAboutModal = () => {
  document.getElementById('aboutModal').classList.add('hidden');
};

// ============================================================
// TRADING WALLET SETTINGS MODAL (Auto-Redemption)
// ============================================================

const openTradingWalletSettingsModal = async (walletId, walletLabel) => {
  document.getElementById('twSettingsWalletId').value = walletId || '';
  document.getElementById('twSettingsModalTitle').textContent = `Settings: ${walletLabel || walletId || 'Global'}`;
  document.getElementById('twRedeemableList').innerHTML = '<div class="text-center text-muted" style="padding:8px;">Click "Check Now" to scan</div>';

  try {
    const status = await API.getLifecycleStatus();
    const cfg = status.config || {};
    document.getElementById('twAutoRedeemEnabled').checked = cfg.autoRedeemEnabled || false;
    document.getElementById('twMinRedeemValue').value = cfg.minRedeemValue ?? 0.10;
    document.getElementById('twAutoMergeEnabled').checked = cfg.autoMergeEnabled || false;
    document.getElementById('twAutoRedeemInputs').className = cfg.autoRedeemEnabled ? '' : 'hidden';
  } catch {
    document.getElementById('twAutoRedeemEnabled').checked = false;
    document.getElementById('twAutoMergeEnabled').checked = false;
    document.getElementById('twAutoRedeemInputs').className = 'hidden';
  }

  document.getElementById('tradingWalletSettingsModal').classList.remove('hidden');
};

const closeTradingWalletSettingsModal = () => {
  document.getElementById('tradingWalletSettingsModal').classList.add('hidden');
};

const handleAutoRedeemToggle = () => {
  const enabled = document.getElementById('twAutoRedeemEnabled').checked;
  document.getElementById('twAutoRedeemInputs').className = enabled ? '' : 'hidden';
};

const saveTradingWalletSettings = async () => {
  try {
    const config = {
      autoRedeemEnabled: document.getElementById('twAutoRedeemEnabled').checked,
      autoMergeEnabled: document.getElementById('twAutoMergeEnabled').checked,
      minRedeemValue: parseFloat(document.getElementById('twMinRedeemValue').value) || 0.10,
    };
    await API.updateLifecycleConfig(config);
    await win95Dialog.success('Settings saved!');
    closeTradingWalletSettingsModal();
  } catch (err) {
    await win95Dialog.error(`Failed to save: ${err.message}`);
  }
};

const checkRedeemablePositions = async () => {
  const container = document.getElementById('twRedeemableList');
  container.innerHTML = '<div class="text-center text-muted" style="padding:8px;">Scanning...</div>';

  try {
    const data = await API.getRedeemablePositions();
    const positions = data.positions || [];

    if (positions.length === 0) {
      container.innerHTML = '<div class="text-center text-muted" style="padding:8px;">No redeemable positions found</div>';
      return;
    }

    container.innerHTML = positions.map(pos => `
      <div style="border:1px solid var(--win-dark);padding:4px 8px;margin-bottom:2px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <span class="text-bold">${pos.marketTitle || pos.tokenId?.slice(0, 12) || 'Unknown'}</span>
          <span class="win-badge badge-success">${pos.outcome || 'YES'}</span>
          <span class="text-sm">${pos.size ? pos.size.toFixed(1) + ' shares' : ''}</span>
        </div>
        <div class="text-success text-bold">$${(pos.estimatedPayout || pos.estimatedValue || 0).toFixed(2)}</div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div class="text-center text-danger" style="padding:8px;">Error: ${err.message}</div>`;
  }
};

const redeemAllPositions = async () => {
  if (!await win95Dialog.confirm('Redeem all eligible winning positions now?')) return;
  try {
    const result = await API.redeemAll();
    const results = result.results || [];
    const count = results.length;
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success);

    if (succeeded === count && count > 0) {
      await win95Dialog.success(`Successfully redeemed ${succeeded} position(s)!`);
    } else if (failed.length > 0) {
      const errorMsg = failed[0].error || 'Unknown error';
      await win95Dialog.error(`Redeemed ${succeeded}/${count} position(s).\n\nError: ${errorMsg}`);
    } else {
      await win95Dialog.alert(`Redeemed ${succeeded}/${count} position(s).`);
    }
    checkRedeemablePositions();
  } catch (err) {
    await win95Dialog.error(`Redemption failed: ${err.message}`);
  }
};

// ============================================================
// DROPDOWN MENUS (Bot, View, Help)
// ============================================================

let activeMenu = null;

const closeAllMenus = () => {
  document.querySelectorAll('.win-menu-dropdown').forEach(m => m.remove());
  document.querySelectorAll('.win-menu-item').forEach(b => b.classList.remove('active'));
  activeMenu = null;
};

const showMenu = (menuId, items) => {
  if (activeMenu === menuId) {
    closeAllMenus();
    return;
  }
  closeAllMenus();

  const btn = document.getElementById(menuId);
  btn.classList.add('active');
  activeMenu = menuId;

  const dropdown = document.createElement('div');
  dropdown.className = 'win-menu-dropdown';

  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'win-menu-separator';
      dropdown.appendChild(sep);
      return;
    }
    const el = document.createElement('button');
    el.className = 'win-menu-dropdown-item';
    el.textContent = item.label;
    el.disabled = !!item.disabled;
    if (item.action) {
      el.onclick = () => {
        closeAllMenus();
        item.action();
      };
    }
    dropdown.appendChild(el);
  });

  const wrapper = btn.closest('.win-menu-wrapper') || btn.parentElement;
  const rect = btn.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.top = rect.bottom + 'px';
  dropdown.style.left = rect.left + 'px';
  document.body.appendChild(dropdown);
};

const toggleBotMenu = () => {
  const items = [
    { label: botRunning ? 'Stop Bot' : 'Start Bot', action: toggleBot },
    { label: 'Paper Mode Info...', action: openPaperModeModal },
  ];

  if (!usesHostedWalletAccess()) {
    items.push(
      { separator: true },
      {
        label: 'Lock Vault', action: async () => {
          if (await win95Dialog.confirm('Lock the wallet vault? You will need to re-enter your master password to trade.')) {
            masterPassword = '';
            document.getElementById('unlockSection').classList.remove('hidden');
            document.getElementById('tradingWalletsSection').classList.add('hidden');
          }
        }
      },
    );
  }

  showMenu('menuBot', items);
};

const toggleViewMenu = () => {
  showMenu('menuView', [
    { label: 'Home', action: () => switchTab('dashboard') },
    { label: 'Discovery', action: () => switchTab('discovery') },
    { label: 'Tracked Wallets', action: () => switchTab('wallets') },
    { label: 'Trading Wallets', action: () => switchTab('trading-wallets') },
    { label: 'Settings', action: () => switchTab('settings') },
    { label: 'Diagnostics', action: () => switchTab('diagnostics') },
    { separator: true },
    { label: 'Refresh Now', action: () => refreshCurrentTab() },
  ]);
};

const toggleHelpMenu = () => {
  showMenu('menuHelp', [
    { label: 'About Ditto...', action: openAboutModal },
    { label: 'What is Paper Mode?', action: openPaperModeModal },
    { separator: true },
    { label: 'Open setup guide...', action: () => startSetupWizard(true) },
    { label: 'Start interface walkthrough...', action: () => { if (typeof startTour === 'function') startTour(); } },
    { separator: true },
    { label: 'GitHub Repository', action: () => window.open('https://github.com/0xAidan/polymarket-bot-test', '_blank') },
  ]);
};

// ============================================================
// DISCOVERY ENGINE UI
// ============================================================

let discoveryWalletOffset = 0;
const DISCOVERY_PAGE_SIZE = 50;

const heatBadge = (heat) => {
  const map = { HOT: 'HOT', WARMING: 'WARM', STEADY: 'STEADY', COOLING: 'COOL', COLD: 'COLD', NEW: 'NEW' };
  return '<span class="heat-badge heat-' + (heat || 'new').toLowerCase() + '">' + (map[heat] || heat || 'NEW') + '</span>';
};
const scoreBar = (score) => {
  const s = Math.round(score || 0);
  const color = s >= 70 ? 'var(--success)' : s >= 40 ? 'var(--warning)' : 'var(--danger)';
  return '<span class="whale-score-bar"><span class="whale-score-fill" style="width:' + s + '%;background:' + color + '"></span></span> ' + s;
};
const pnlText = (val) => {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) {
    return '<span class="text-muted">—</span>';
  }
  const v = Number(val);
  const cls = v >= 0 ? 'pnl-positive' : 'pnl-negative';
  const sign = v >= 0 ? '+' : '';
  return '<span class="' + cls + '">' + sign + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + '</span>';
};
const roiText = (val) => {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) {
    return '<span class="text-muted">—</span>';
  }
  const v = Number(val);
  const cls = v >= 0 ? 'pnl-positive' : 'pnl-negative';
  const sign = v >= 0 ? '+' : '';
  return '<span class="' + cls + '">' + sign + v.toFixed(1) + '%</span>';
};
let discoveryRefreshTimer = null;
let discoveryConfigLoaded = false;

const loadDiscoveryConfig = async () => {
  // Only load from server once — don't overwrite fields the user is editing
  if (discoveryConfigLoaded) return;

  try {
    const resp = await fetch('/api/discovery/config');
    const data = await resp.json();
    if (!data.success) return;
    const cfg = data.config;

    const enabledEl = document.getElementById('discoveryEnabled');
    const urlEl = document.getElementById('discoveryAlchemyUrl');
    const pollEl = document.getElementById('discoveryPollInterval');
    const marketEl = document.getElementById('discoveryMarketCount');
    const statsEl = document.getElementById('discoveryStatsInterval');
    const urlHasKeyEl = document.getElementById('discoveryAlchemyUrlHasKey');

    if (enabledEl) enabledEl.checked = cfg.enabled;
    if (pollEl) pollEl.value = Math.round((cfg.pollIntervalMs || 30000) / 1000);
    const fastModeEl = document.getElementById('discoveryFastMode');
    if (fastModeEl) fastModeEl.checked = Number(cfg.pollIntervalMs || 30000) <= 15000;
    if (marketEl) marketEl.value = cfg.marketCount || 50;
    if (statsEl) statsEl.value = Math.round((cfg.statsIntervalMs || 300000) / 60000);

    // Show whether a key is saved without putting the masked value in the field
    if (urlEl && urlHasKeyEl) {
      if (cfg.alchemyWsUrl && cfg.alchemyWsUrl !== '') {
        urlEl.value = '';
        urlEl.placeholder = 'Key saved — paste new URL to replace';
        urlHasKeyEl.textContent = '(key saved: ' + cfg.alchemyWsUrl + ')';
        urlHasKeyEl.style.display = '';
      } else {
        urlEl.value = '';
        urlEl.placeholder = 'wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY';
        urlHasKeyEl.style.display = 'none';
      }
    }

    discoveryConfigLoaded = true;
  } catch { /* best-effort */ }
};

const normalizeEpochMs = (value) => {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // Some backend fields are epoch-seconds; normalize to milliseconds for UI.
  return raw < 1_000_000_000_000 ? raw * 1000 : raw;
};

const relativeTimeFromMs = (value) => {
  const ts = normalizeEpochMs(value);
  if (!Number.isFinite(ts) || ts <= 0) return 'never';
  const delta = Date.now() - ts;
  if (delta < 5000) return 'just now';
  if (delta < 60000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3600000) return `${Math.round(delta / 60000)}m ago`;
  return `${(delta / 3600000).toFixed(1)}h ago`;
};

const loadDiscoveryStatus = async () => {
  const chainEl = document.getElementById('discoveryChainStatus');
  const pollerEl = document.getElementById('discoveryPollerStatus');
  const walletEl = document.getElementById('discoveryWalletCount');
  const tradeEl = document.getElementById('discoveryTradeCount');
  const uptimeEl = document.getElementById('discoveryUptime');
  try {
    const resp = await fetch('/api/discovery/status');
    const data = await resp.json();
    if (!data.success) {
      if (chainEl) chainEl.textContent = 'Unavailable';
      if (pollerEl) pollerEl.textContent = 'Unavailable';
      if (walletEl) walletEl.textContent = '0';
      if (tradeEl) tradeEl.textContent = '0';
      if (uptimeEl) uptimeEl.textContent = '--';
      return;
    }

    if (chainEl) {
      const cl = data.chainListener || {};
      const lastEventMs = normalizeEpochMs(cl.lastEventAt);
      const usingCycleOnlyMode = !cl.connected && !lastEventMs && Boolean(data.latestRun);
      if (usingCycleOnlyMode) {
        chainEl.textContent = 'Cycle mode • no live chain stream';
        chainEl.style.color = '';
      } else {
        const lastEventText = relativeTimeFromMs(lastEventMs);
        chainEl.textContent = cl.connected ? `Connected • last ${lastEventText}` : `Disconnected • last ${lastEventText}`;
        chainEl.style.color = cl.connected ? 'var(--success)' : 'var(--danger, #c00)';
      }
    }
    if (pollerEl) {
      const ap = data.apiPoller || {};
      const lastPollMs = normalizeEpochMs(ap.lastPollAt);
      const lastPollText = relativeTimeFromMs(lastPollMs);
      pollerEl.textContent = ap.running
        ? `Polling (${ap.marketsMonitored}) • last ${lastPollText}`
        : `Stopped • last ${lastPollText}`;
      const stale = lastPollMs && Date.now() - lastPollMs > 60000;
      pollerEl.style.color = ap.running && !stale ? 'var(--success)' : (stale ? 'var(--danger, #c00)' : '');
    }
    if (walletEl) walletEl.textContent = (data.stats?.totalWallets ?? 0).toLocaleString();
    if (tradeEl) tradeEl.textContent = (data.stats?.totalTrades ?? 0).toLocaleString();
    if (uptimeEl) {
      const ms = data.stats?.uptimeMs || 0;
      if (ms === 0) { uptimeEl.textContent = '--'; }
      else if (ms < 60000) { uptimeEl.textContent = Math.round(ms / 1000) + 's'; }
      else if (ms < 3600000) { uptimeEl.textContent = Math.round(ms / 60000) + 'm'; }
      else { uptimeEl.textContent = (ms / 3600000).toFixed(1) + 'h'; }
    }
  } catch {
    if (chainEl) chainEl.textContent = 'Unavailable';
    if (pollerEl) pollerEl.textContent = 'Unavailable';
    if (walletEl) walletEl.textContent = '0';
    if (tradeEl) tradeEl.textContent = '0';
    if (uptimeEl) uptimeEl.textContent = '--';
  }
};

const loadDiscoveryWallets = async () => {
  discoveryWalletOffset = 0;
  await fetchDiscoveryWallets(false);
};

const handleDiscoveryFastModeToggle = () => {
  const fastModeEl = document.getElementById('discoveryFastMode');
  const pollEl = document.getElementById('discoveryPollInterval');
  if (!fastModeEl || !pollEl) return;
  pollEl.value = fastModeEl.checked ? '15' : '30';
};

const loadMoreDiscoveryWallets = async () => {
  discoveryWalletOffset += DISCOVERY_PAGE_SIZE;
  await fetchDiscoveryWallets(true);
};

const discoveryCategoryLabel = (category) => {
  const labels = {
    politics: 'Politics',
    macro: 'Macro',
    company: 'Company',
    legal: 'Legal',
    geopolitics: 'Geopolitics',
    entertainment: 'Entertainment',
    sports: 'Sports',
    crypto: 'Crypto',
    event: 'Real-World',
    other: 'Other',
  };
  return labels[category] || 'Real-World';
};

const discoveryCategoryBadge = (category) => {
  const label = discoveryCategoryLabel(category);
  return `<span class="win-badge" style="margin-left:6px;">${label}</span>`;
};

const fetchDiscoveryWallets = async (append) => {
  try {
    const sortEl = document.getElementById('discoveryWalletSort');
    const sort = sortEl ? sortEl.value : 'score';
    const focusEl = document.getElementById('discoveryFocus');
    const focus = focusEl ? focusEl.value : 'all-real-world';
    const minScoreEl = document.getElementById('filterMinScore');
    const heatEl = document.getElementById('filterHeat');
    const hasSignalsEl = document.getElementById('filterHasSignals');
    let url = `/api/discovery/wallets?sort=${encodeURIComponent(sort)}&limit=${DISCOVERY_PAGE_SIZE}&offset=${discoveryWalletOffset}`;
    if (focus) url += '&focus=' + encodeURIComponent(focus);
    if (minScoreEl && parseInt(minScoreEl.value, 10) > 0) url += '&minScore=' + minScoreEl.value;
    if (heatEl && heatEl.value) url += '&heat=' + encodeURIComponent(heatEl.value);
    if (hasSignalsEl && hasSignalsEl.checked) url += '&hasSignals=true';

    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.success) return;

    const tbody = document.getElementById('discoveryWalletsBody');
    if (!tbody) return;

    if (!append) tbody.innerHTML = '';

    const wallets = data.wallets || [];
    if (wallets.length === 0 && !append) {
      tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">No wallets discovered yet</td></tr>';
    }

    for (const w of wallets) {
      const tr = document.createElement('tr');
      tr.className = 'discovery-wallet-row';
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-label', 'View wallet ' + (w.address || '').slice(0, 10) + '...');
      const shortAddr = w.address ? (w.address.slice(0, 6) + '...' + w.address.slice(-4)) : '—';
      const trackBtn = w.isTracked
        ? '<button class="win-btn win-btn-sm" disabled>Tracked</button>'
        : '<button class="win-btn win-btn-sm win-btn-primary" onclick="event.stopPropagation();trackDiscoveredWallet(\'' + (w.address || '').replace(/'/g, "\\'") + '\', this)" aria-label="Track and activate wallet" tabindex="0">Track &amp; Activate</button>';
      const roiLabel = roiText(w.roiPct) + (w.positionDataSource === 'verified'
        ? ' <span class="text-xs text-muted">(verified)</span>'
        : ' <span class="text-xs text-muted">(estimated)</span>');
      const categoryBadge = discoveryCategoryBadge(w.focusCategory);
      const sourceLine = Array.isArray(w.sourceChannels) && w.sourceChannels.length
        ? `<div class="text-xs text-muted" style="margin-top:2px;">Sources: ${w.sourceChannels.join(', ')}</div>`
        : '';
      const marketLine = Array.isArray(w.supportingMarkets) && w.supportingMarkets.length
        ? `<div class="text-xs text-muted" style="margin-top:2px;max-width:280px;">Markets: ${w.supportingMarkets.join(', ')}</div>`
        : '';
      const stateLine = w.discoveryState
        ? `<div class="text-xs" style="margin-top:2px;"><strong>${w.discoveryState}</strong>${w.whyNotTracked ? ` • ${w.whyNotTracked}` : ''}</div>`
        : '';
      const changeLine = w.whatChanged
        ? `<div class="text-xs text-muted" style="margin-top:2px;max-width:280px;">Changed: ${w.whatChanged}</div>`
        : '';
      const reasonCodeLine = Array.isArray(w.reasonCodes) && w.reasonCodes.length
        ? `<div class="text-xs text-muted" style="margin-top:2px;">Codes: ${w.reasonCodes.join(', ')}</div>`
        : '';
      const whySurfaced = w.whySurfaced
        ? `<div class="text-xs text-muted" style="margin-top:2px;max-width:280px;">${w.whySurfaced}</div>${stateLine}${changeLine}${sourceLine}${marketLine}${reasonCodeLine}`
        : `${stateLine}${changeLine}${sourceLine}${marketLine}${reasonCodeLine}`;
      const signalCell = w.discoveryState
        ? `${w.discoveryState}${Array.isArray(w.failedGates) && w.failedGates.length
          ? `<div class="text-xs text-muted" style="margin-top:2px;">${w.failedGates.join(', ')}</div>`
          : (Array.isArray(w.warningReasons) && w.warningReasons.length
            ? `<div class="text-xs text-muted" style="margin-top:2px;">${w.warningReasons[0]}</div>`
            : '')}`
        : 'Qualified';
      tr.innerHTML =
        '<td>' + heatBadge(w.heatIndicator) + '</td>' +
        '<td class="text-mono" title="' + (w.address || '') + '">' + shortAddr + categoryBadge + '</td>' +
        '<td><div>' + (w.pseudonym || '—') + '</div>' + whySurfaced + '</td>' +
        '<td>' + scoreBar(w.whaleScore) + '</td>' +
        '<td>' + roiLabel + '</td>' +
        '<td>$' + (w.volume7d || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>' +
        '<td>' + (w.tradeCount7d || 0).toLocaleString() + '</td>' +
        '<td>' + (w.activePositions ?? 0) + '</td>' +
        '<td>' + signalCell + '</td>' +
        '<td>' + trackBtn + '</td>';
      tr.onclick = () => openWalletDetail(w.address);
      tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWalletDetail(w.address); } };
      tbody.appendChild(tr);
    }

    const countEl = document.getElementById('discoveryWalletsCount');
    if (countEl) {
      const focusLabel = focus === 'high-information' ? 'High-Information' : 'All Real-World';
      countEl.textContent = `${discoveryWalletOffset + wallets.length} wallets shown • ${focusLabel}`;
    }

    const loadMoreBtn = document.getElementById('discoveryLoadMoreBtn');
    if (loadMoreBtn) loadMoreBtn.style.display = wallets.length >= DISCOVERY_PAGE_SIZE ? '' : 'none';
  } catch { /* best-effort */ }
};

const applyDiscoveryFilters = () => {
  discoveryWalletOffset = 0;
  fetchDiscoveryWallets(false);
};

const loadDiscoverySignals = async () => {
  try {
    const severityEl = document.getElementById('signalSeverityFilter');
    const severity = severityEl ? severityEl.value : '';
    let url = '/api/discovery/signals?limit=10&offset=0';
    if (severity) url += '&severity=' + encodeURIComponent(severity);
    const resp = await fetch(url);
    const data = await resp.json();
    const listEl = document.getElementById('discoverySignalsList');
    const countEl = document.getElementById('signalCount');
    if (!data.success || !listEl) return;

    const signals = data.signals || [];
    if (countEl) countEl.textContent = signals.length + ' signal' + (signals.length !== 1 ? 's' : '') + ' shown';

    if (signals.length === 0) {
      listEl.innerHTML = '<div class="text-center text-muted text-sm">No signals yet — collecting data...</div>';
      return;
    }

    const priority = { CONVICTION_BUILD: 0, COORDINATED_ENTRY: 1, MARKET_PIONEER: 2, NEW_WHALE: 3, VOLUME_SPIKE: 4, SIZE_ANOMALY: 5, DORMANT_ACTIVATION: 6 };
    const sortedSignals = [...signals].sort((a, b) => (priority[a.signalType] ?? 99) - (priority[b.signalType] ?? 99));
    listEl.innerHTML = sortedSignals.map((s) => {
      const timeAgo = s.detectedAt ? (Date.now() - s.detectedAt < 60000 ? 'Just now' : Math.floor((Date.now() - s.detectedAt) / 60000) + 'm ago') : '';
      const dismissBtn = s.canDismiss
        ? '<button class="win-btn win-btn-sm" onclick="dismissSignal(' + s.id + ')" aria-label="Dismiss">Dismiss</button>'
        : '';
      const meta = s.metadata || {};
      const detail = s.signalType === 'CONVICTION_BUILD'
        ? `Fills: ${meta.fills || 0} • Notional: $${Number(meta.totalNotional || 0).toLocaleString()}`
        : s.signalType === 'COORDINATED_ENTRY'
          ? `Wallets: ${meta.walletCount || 0} • Volume: $${Number(meta.totalVolume || 0).toLocaleString()} • Avg score: ${Number(meta.avgScore || 0).toFixed(1)}`
          : '';
      return '<div class="signal-card severity-' + (s.severity || 'medium') + '">' +
        '<span class="signal-type-badge">' + (s.signalType || '').replace(/_/g, ' ') + '</span>' +
        '<strong>' + (s.title || '') + '</strong> ' + timeAgo + '<br>' +
        '<span class="text-sm text-muted">' + (s.description || '') + '</span>' + (detail ? '<br><span class="text-xs text-muted">' + detail + '</span>' : '') + '<br>' +
        dismissBtn + '</div>';
    }).join('');
  } catch { /* best-effort */ }
};

const dismissSignal = async (id) => {
  try {
    await fetch('/api/discovery/signals/' + id + '/dismiss', { method: 'POST' });
    loadDiscoverySignals();
  } catch { /* best-effort */ }
};

const loadUnusualMarkets = async () => {
  try {
    const resp = await fetch('/api/discovery/signals/markets?days=7');
    const data = await resp.json();
    const tbody = document.getElementById('unusualMarketsBody');
    if (!data.success || !tbody) return;

    const markets = data.markets || [];
    if (markets.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No unusual markets yet — this section only shows strict MARKET_PIONEER / COORDINATED_ENTRY signals.</td></tr>';
      return;
    }
    tbody.innerHTML = markets.map((m) => {
      const title = m.market_title || m.condition_id?.slice(0, 12) || '—';
      const types = (m.signal_types || '').replace(/,/g, ', ');
      const walletCount = m.wallets ? m.wallets.split(',').length : 0;
      const firstDetected = m.first_detected ? new Date(m.first_detected).toLocaleString() : '—';
      const wallets = (m.wallets || '').split(',').filter(Boolean);
      const walletActions = wallets.slice(0, 3).map((wallet) => {
        const safeWallet = String(wallet).replace(/'/g, "\\'");
        return `<button class="win-btn win-btn-sm" style="margin-right:4px;" onclick="event.stopPropagation();openWalletDetail('${safeWallet}')">${wallet.slice(0, 6)}...${wallet.slice(-4)}</button>`;
      }).join('');
      return `<tr>
        <td>${title}</td>
        <td>${types}</td>
        <td>${walletCount}</td>
        <td>${firstDetected}<div style="margin-top:4px;">${walletActions || '<span class="text-xs text-muted">No linked wallets</span>'}</div></td>
      </tr>`;
    }).join('');
  } catch { /* best-effort */ }
};

const loadDiscoveryOverview = async () => {
  try {
    const resp = await fetch('/api/discovery/summary?days=7');
    const data = await resp.json();
    if (!data.success) return;

    const overview = data.overview || {};
    const quality = overview.quality || {};
    const categoryMix = overview.surfacedByCategory || [];
    const signalMix = overview.signalCountsByCategory || [];
    const topWalletsByDay = overview.topWalletsByDay || [];

    const surfacedTodayEl = document.getElementById('discoverySurfacedToday');
    if (surfacedTodayEl) surfacedTodayEl.textContent = String(quality.walletsSurfacedToday || 0);
    const highInfoPctEl = document.getElementById('discoveryHighInfoPct');
    if (highInfoPctEl) highInfoPctEl.textContent = `${quality.highInformationWalletPct || 0}%`;
    const strongSignalsEl = document.getElementById('discoveryStrongSignals');
    if (strongSignalsEl) strongSignalsEl.textContent = String(quality.walletsWithTwoStrongSignals || 0);
    const trackedCountEl = document.getElementById('discoveryTrackedCount');
    if (trackedCountEl) trackedCountEl.textContent = String(quality.trackedWallets || 0);

    const categoryMixEl = document.getElementById('discoveryCategoryMix');
    if (categoryMixEl) {
      categoryMixEl.innerHTML = categoryMix.length === 0
        ? 'Collecting data...'
        : categoryMix.map((item) => `<div>${discoveryCategoryLabel(item.category)}: <strong>${item.count}</strong></div>`).join('');
    }

    const signalMixEl = document.getElementById('discoverySignalMix');
    if (signalMixEl) {
      signalMixEl.innerHTML = signalMix.length === 0
        ? 'Collecting data...'
        : signalMix.map((item) => `<div>${discoveryCategoryLabel(item.category)}: <strong>${item.count}</strong></div>`).join('');
    }

    const topWalletsEl = document.getElementById('discoveryTopWalletsByDay');
    if (topWalletsEl) {
      topWalletsEl.innerHTML = topWalletsByDay.length === 0
        ? 'Collecting data...'
        : topWalletsByDay.map((day) => {
          const wallets = (day.wallets || []).slice(0, 3).map((wallet) => {
            const shortAddr = wallet.address ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}` : '—';
            return `${shortAddr} (${discoveryCategoryLabel(wallet.focusCategory)})`;
          }).join(', ');
          return `<div><strong>${day.day}</strong>: ${wallets || 'No surfaced wallets'}</div>`;
        }).join('');
    }
  } catch { /* best-effort */ }
};

const openWalletDetail = async (address) => {
  if (!address) return;
  const overlay = document.getElementById('walletDetailOverlay');
  const titleEl = document.getElementById('walletDetailTitle');
  const bodyEl = document.getElementById('walletDetailBody');
  if (!overlay || !bodyEl) return;
  titleEl.textContent = 'Wallet ' + address.slice(0, 10) + '...';
  bodyEl.innerHTML = '<p class="text-muted">Loading...</p>';
  overlay.style.display = 'flex';

  try {
    const [posResp, sigResp] = await Promise.all([
      fetch('/api/discovery/wallets/' + encodeURIComponent(address.toLowerCase()) + '/positions'),
      fetch('/api/discovery/wallets/' + encodeURIComponent(address.toLowerCase()) + '/signals'),
    ]);
    const posData = await posResp.json();
    const sigData = await sigResp.json();
    const positions = posData.success ? (posData.positions || []) : [];
    const signals = sigData.success ? (sigData.signals || []) : [];
    const positionSource = posData.source || 'derived';
    const positionSourceLabel = positionSource === 'verified'
      ? 'Live open positions from Polymarket'
      : positionSource === 'cached'
        ? 'Cached Polymarket snapshot'
        : 'Derived from observed discovery trades';

    const profileUrl = posData.profileUrl || '';
    let html = '<p class="text-mono text-sm mb-4">' + address + '</p>';
    if (profileUrl) {
      html += '<p class="mb-8"><a href="' + profileUrl + '" target="_blank" rel="noopener noreferrer" style="color:#0066cc;text-decoration:underline;font-size:12px;" tabindex="0" aria-label="View Polymarket profile for this wallet">View on Polymarket &rarr;</a></p>';
    } else {
      html += '<p class="text-xs text-muted mb-8">No public Polymarket profile link is available for this wallet identity yet.</p>';
    }
    html += '<p class="text-sm mb-4">Position source: <strong>' + positionSourceLabel + '</strong></p>';
    if (positionSource === 'cached') {
      html += '<p class="text-xs text-muted mb-4">This is a fallback cache from the last successful wallet validation, not a fresh live query.</p>';
    }
    html += '<h4 class="mb-4">Positions</h4>';
    if (positions.length === 0) {
      html += '<p class="text-muted text-sm">No positions</p>';
    } else {
      html += '<table class="win-listview"><thead><tr><th>Market</th><th>Shares</th><th>Cost</th><th>PnL</th><th>ROI</th><th>Trust</th></tr></thead><tbody>';
      positions.forEach((p) => {
        const marketLabel = (p.marketTitle || p.conditionId?.slice(0, 12) || '—') + (p.outcome ? ` (${p.outcome})` : '');
        const priceNote = (p.currentPrice === null || p.currentPrice === undefined) ? ' <span class="text-xs text-muted">(price pending)</span>' : '';
        const dataBadge = p.dataSource === 'verified'
          ? 'Live'
          : p.dataSource === 'cached'
            ? 'Cached'
            : 'Derived';
        html += '<tr><td>' + marketLabel + priceNote + '</td><td>' + (p.shares || 0).toLocaleString() + '</td><td>$' + (p.totalCost || 0).toLocaleString() + '</td><td>' + pnlText(p.unrealizedPnl) + '</td><td>' + roiText(p.roiPct) + '</td><td>' + dataBadge + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    html += '<h4 class="mb-4 mt-8">Signals</h4>';
    if (signals.length === 0) {
      html += '<p class="text-muted text-sm">No signals</p>';
    } else {
      signals.slice(0, 10).forEach((s) => {
        html += '<div class="signal-card severity-' + (s.severity || 'medium') + ' mb-4"><strong>' + (s.title || '') + '</strong><br><span class="text-sm">' + (s.description || '') + '</span></div>';
      });
    }
    html += '<div class="mt-8"><button class="win-btn win-btn-primary" onclick="trackDiscoveredWallet(\'' + address.replace(/'/g, "\\'") + '\', this); closeWalletDetail();">Track &amp; Activate</button></div>';
    bodyEl.innerHTML = html;
  } catch (err) {
    bodyEl.innerHTML = '<p class="text-danger">Failed to load wallet details.</p>';
  }
};

const closeWalletDetail = () => {
  const overlay = document.getElementById('walletDetailOverlay');
  if (overlay) overlay.style.display = 'none';
};

const trackDiscoveredWallet = async (address, btn) => {
  try {
    btn.disabled = true;
    btn.textContent = '...';

    const resp = await fetch('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    const data = await resp.json();
    const alreadyTracked = !resp.ok && typeof data.error === 'string' && data.error.includes('already being tracked');

    if (data.success || resp.ok || alreadyTracked) {
      const toggleResp = await fetch('/api/wallets/' + encodeURIComponent(address) + '/toggle', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });
      const toggleData = await toggleResp.json();
      if (!toggleResp.ok || !toggleData.success) {
        throw new Error(toggleData.error || 'Failed to activate wallet');
      }

      await fetch(`/api/discovery/wallets/${address}/track`, { method: 'POST' });
      btn.textContent = 'Active';
      btn.classList.remove('win-btn-primary');
    } else {
      btn.textContent = 'Track & Activate';
      btn.disabled = false;
      win95Dialog.alert('Error', data.error || 'Failed to track wallet');
    }
  } catch (err) {
    btn.textContent = 'Track & Activate';
    btn.disabled = false;
    if (err?.message) {
      win95Dialog.alert('Error', err.message);
    }
  }
};

const saveDiscoveryConfig = async () => {
  try {
    const urlEl = document.getElementById('discoveryAlchemyUrl');
    const pollEl = document.getElementById('discoveryPollInterval');
    const marketEl = document.getElementById('discoveryMarketCount');
    const statsEl = document.getElementById('discoveryStatsInterval');
    const enabledEl = document.getElementById('discoveryEnabled');

    const body = {
      enabled: enabledEl?.checked ?? false,
      pollIntervalMs: (parseInt(pollEl?.value) || 30) * 1000,
      marketCount: parseInt(marketEl?.value) || 50,
      statsIntervalMs: (parseInt(statsEl?.value) || 5) * 60000,
    };

    // Only send URL if the user typed a new one (field is not empty)
    const urlVal = (urlEl?.value || '').trim();
    if (urlVal) {
      body.alchemyWsUrl = urlVal;
    }

    const resp = await fetch('/api/discovery/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.success) {
      // Refresh the "key saved" indicator
      discoveryConfigLoaded = false;
      loadDiscoveryConfig();

      const msg = urlVal
        ? 'Settings saved. Restart the engine for URL changes to take effect.'
        : 'Settings saved.';
      win95Dialog.alert('Settings Saved', msg);
    } else {
      win95Dialog.alert('Error', data.error || 'Failed to save settings');
    }
  } catch (err) {
    win95Dialog.alert('Error', 'Failed to save settings: ' + err.message);
  }
};

const handleDiscoveryToggle = async () => {
  const enabledEl = document.getElementById('discoveryEnabled');
  const enabled = enabledEl?.checked ?? false;
  try {
    await fetch('/api/discovery/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    // Always restart — if enabled=true it starts, if enabled=false it stops
    await fetch('/api/discovery/config/restart', { method: 'POST' });
    loadDiscoveryStatus();
  } catch { /* best-effort */ }
};

const restartDiscovery = async () => {
  try {
    const resp = await fetch('/api/discovery/config/restart', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      win95Dialog.alert('Restart Needed', 'Discovery settings were saved. The dedicated discovery worker is restarted separately.');
    } else {
      win95Dialog.alert('Error', data.error || 'Failed to restart');
    }
  } catch (err) {
    win95Dialog.alert('Error', 'Failed to restart: ' + err.message);
  }
};

const purgeDiscoveryData = async () => {
  const firstConfirm = await win95Dialog.confirm(
    'Clear Discovery Data',
    'Warning: this will erase the full discovery feed (wallets, trades, positions, signals, and market cache).'
  );
  if (!firstConfirm) return;

  const secondConfirm = await win95Dialog.confirm(
    'Confirm Permanent Deletion',
    'This cannot be undone. Click OK again to permanently clear discovery data.'
  );
  if (!secondConfirm) return;

  try {
    const resp = await fetch('/api/discovery/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full: true }),
    });
    const data = await resp.json();
    if (data.success) {
      clearDiscoveryUiState();
      await Promise.all([
        loadDiscoveryStatus(),
        loadDiscoveryWallets(),
        loadDiscoveryOverview(),
        loadDiscoverySignals(),
        loadUnusualMarkets(),
      ]);

      const deletedTotal = typeof data.deleted?.total === 'number' ? data.deleted.total : 0;
      win95Dialog.alert('Cleared', `Discovery data cleared. Removed ${deletedTotal} records.`);
    }
  } catch { /* best-effort */ }
};

const clearDiscoveryUiState = () => {
  discoveryWalletOffset = 0;

  const walletsBody = document.getElementById('discoveryWalletsBody');
  if (walletsBody) {
    walletsBody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">No wallets discovered yet</td></tr>';
  }

  const walletsCount = document.getElementById('discoveryWalletsCount');
  if (walletsCount) walletsCount.textContent = '0 wallets shown';

  const loadMoreBtn = document.getElementById('discoveryLoadMoreBtn');
  if (loadMoreBtn) loadMoreBtn.style.display = 'none';

  const signalsList = document.getElementById('discoverySignalsList');
  if (signalsList) {
    signalsList.innerHTML = '<div class="text-center text-muted text-sm">No signals yet — collecting data...</div>';
  }

  const signalCount = document.getElementById('signalCount');
  if (signalCount) signalCount.textContent = '0 signals shown';

  const unusualBody = document.getElementById('unusualMarketsBody');
  if (unusualBody) {
    unusualBody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No unusual markets yet — this section only shows strict MARKET_PIONEER / COORDINATED_ENTRY signals.</td></tr>';
  }

  const overviewDefaults = {
    discoverySurfacedToday: '0',
    discoveryHighInfoPct: '0%',
    discoveryStrongSignals: '0',
    discoveryTrackedCount: '0',
  };
  Object.entries(overviewDefaults).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });

  ['discoveryCategoryMix', 'discoverySignalMix', 'discoveryTopWalletsByDay'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = 'Collecting data...';
  });
};

const startDiscoveryRefresh = () => {
  stopDiscoveryRefresh();
  loadDiscoveryConfig();
  loadDiscoveryStatus();
  loadDiscoveryWallets();
  loadDiscoveryOverview();
  loadDiscoverySignals();
  loadUnusualMarkets();
  discoveryRefreshTimer = setInterval(() => {
    if (currentTab !== 'discovery') {
      stopDiscoveryRefresh();
      return;
    }
    loadDiscoveryStatus();
    if (discoveryWalletOffset === 0) {
      fetchDiscoveryWallets(false);
    }
    loadDiscoveryOverview();
    loadDiscoverySignals();
    loadUnusualMarkets();
  }, 10000);
};

const stopDiscoveryRefresh = () => {
  if (discoveryRefreshTimer) {
    clearInterval(discoveryRefreshTimer);
    discoveryRefreshTimer = null;
  }
};

// Hook into the existing switchTab to start/stop discovery refresh
const originalSwitchTab = typeof switchTab === 'function' ? switchTab : null;

// Close menus when clicking outside
document.addEventListener('click', (e) => {
  if (activeMenu && !e.target.closest('.win-menu-dropdown') && !e.target.closest('.win-menu-item')) {
    closeAllMenus();
  }
});

// Close all modals and menus on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAllMenus();
    const modalIds = ['tradeDetailModal', 'paperModeModal', 'aboutModal', 'tradingWalletSettingsModal', 'builderCredsModal', 'walletModal', 'mirrorModal', 'walletDetailOverlay'];
    const closeFns = { tradeDetailModal: closeTradeDetailModal, paperModeModal: closePaperModeModal, aboutModal: closeAboutModal, tradingWalletSettingsModal: closeTradingWalletSettingsModal, builderCredsModal: closeBuilderCredsModal, walletModal: closeWalletModal, mirrorModal: closeMirrorModal, walletDetailOverlay: closeWalletDetail };
    for (const id of modalIds) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden') && closeFns[id]) {
        closeFns[id]();
        break;
      }
    }
  }
});
