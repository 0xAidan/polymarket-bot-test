/**
 * CopyTrade95 - Main Application Logic
 * Win95-themed Polymarket Copy Trading Bot Dashboard
 */

// Global state
let currentTab = 'dashboard';
let refreshInterval = null;
let botRunning = false;

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
    alert: (message, title = 'CopyTrade95') => {
      const escaped = String(message).replace(/</g, '&lt;').replace(/\n/g, '<br>');
      return createDialog(title, `<p style="margin:0;line-height:1.5">${escaped}</p>`, [
        { label: 'OK', value: true, primary: true },
      ]);
    },

    success: (message, title = 'Success') => {
      const escaped = String(message).replace(/</g, '&lt;').replace(/\n/g, '<br>');
      return createDialog(title, `<p style="margin:0;line-height:1.5;color:var(--win-success,#008000)">${escaped}</p>`, [
        { label: 'OK', value: true, primary: true },
      ]);
    },

    error: (message, title = 'Error') => {
      const escaped = String(message).replace(/</g, '&lt;').replace(/\n/g, '<br>');
      return createDialog(title, `<p style="margin:0;line-height:1.5;color:#cc0000">${escaped}</p>`, [
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
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  console.log('CopyTrade95 initialized');
  updateClock();
  setInterval(updateClock, 1000);
  loadAllData();
  startAutoRefresh();
});

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
      loadPlatformStatus().catch(() => {}),
      checkLockStatus(),
      loadLadderStatus().catch(() => {})
    ]);
  } catch (error) {
    console.error('Error loading data:', error);
  }
}

// ============================================================
// TAB NAVIGATION
// ============================================================

function switchTab(tabName) {
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
    document.getElementById('statusBarMain').textContent = 
      `${data.wallets.active} wallet(s) tracked | ${data.monitoringMode || 'polling'} mode`;
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
        <td>${trade.marketId?.slice(0, 12)}...</td>
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
    <div class="detail-value">${trade.marketTitle || trade.marketId || 'Unknown'}</div>

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
    const res = await fetch(`/api/wallets/${address}/balance`);
    const data = await res.json();
    
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
  
  document.getElementById('modalThresholdEnabled').onchange = function() {
    document.getElementById('modalThresholdInputs').className = this.checked ? '' : 'hidden';
    updateModalPipeline();
  };
  
  document.querySelectorAll('input[name="modalTradeSideFilter"]').forEach(r => r.onchange = updateModalPipeline);
  
  document.getElementById('modalNoRepeatEnabled').onchange = function() {
    document.getElementById('modalNoRepeatInputs').className = this.checked ? '' : 'hidden';
    updateModalPipeline();
  };
  document.getElementById('modalNoRepeatPeriod').onchange = updateModalPipeline;
  
  document.getElementById('modalValueFilterEnabled').onchange = function() {
    document.getElementById('modalValueFilterInputs').className = this.checked ? '' : 'hidden';
    updateModalPipeline();
  };
  
  document.getElementById('modalRateLimitEnabled').onchange = function() {
    document.getElementById('modalRateLimitInputs').className = this.checked ? '' : 'hidden';
    updateModalPipeline();
  };
  
  document.getElementById('modalPriceLimitsMin').onchange = function() { updatePriceBadge(); updateModalPipeline(); };
  document.getElementById('modalPriceLimitsMax').onchange = function() { updatePriceBadge(); updateModalPipeline(); };
  document.getElementById('modalSlippagePercent').onchange = function() { updateSlippageBadge(); updateModalPipeline(); };
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

// Enter key handlers for password fields
document.addEventListener('DOMContentLoaded', () => {
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
    const data = await API.getLockStatus();
    if (data.unlocked) {
      document.getElementById('unlockSection').classList.add('hidden');
      document.getElementById('tradingWalletsSection').classList.remove('hidden');
      loadTradingWallets();
    } else {
      // Show the right messaging based on whether wallets exist
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

    if (result.migrated) {
      await win95Dialog.alert('Existing .env private key was migrated to encrypted storage as your "main" wallet.');
    }

    document.getElementById('unlockSection').classList.add('hidden');
    document.getElementById('tradingWalletsSection').classList.remove('hidden');
    await loadTradingWallets();
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

    if (result.migrated) {
      await win95Dialog.alert('Existing .env private key was migrated to encrypted storage as "main" wallet.');
    }
    document.getElementById('unlockSection').classList.add('hidden');
    document.getElementById('tradingWalletsSection').classList.remove('hidden');
    await loadTradingWallets();
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
    `;}).join('');
    
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
  
  if (!id || !label || !pk) { await win95Dialog.alert('Wallet ID, Label, and Private Key are required'); return; }
  if (!masterPassword) { await win95Dialog.alert('Wallets must be unlocked first'); return; }
  
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
    await API.addTradingWallet(id, label, pk, masterPassword, apiKey, apiSecret, apiPassphrase);
    document.getElementById('newTradingWalletId').value = '';
    document.getElementById('newTradingWalletLabel').value = '';
    document.getElementById('newTradingWalletKey').value = '';
    document.getElementById('newTradingWalletApiKey').value = '';
    document.getElementById('newTradingWalletApiSecret').value = '';
    document.getElementById('newTradingWalletApiPassphrase').value = '';
    await win95Dialog.success('Trading wallet added!');
    await loadTradingWallets();
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
  if (!masterPassword) { await win95Dialog.alert('Wallets must be unlocked first'); return; }

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

  const errorEl = document.getElementById('builderCredsError');
  const errorText = document.getElementById('builderCredsErrorText');

  // Validate all fields are filled
  if (!apiKey || !apiSecret || !apiPassphrase) {
    errorEl.classList.remove('hidden');
    errorText.textContent = 'All three fields are required.';
    return;
  }

  if (!masterPassword) {
    errorEl.classList.remove('hidden');
    errorText.textContent = 'Wallets must be unlocked first.';
    return;
  }

  // Hide error
  errorEl.classList.add('hidden');

  try {
    await API.updateTradingWalletCredentials(walletId, apiKey, apiSecret, apiPassphrase, masterPassword);
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
    document.getElementById('mirrorTradesBody').innerHTML = `<tr class="empty-row"><td colspan="8">Error: ${error.message}</td></tr>`;
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
  
  // Hide skipped rows initially
  document.querySelectorAll('.skipped-row').forEach(r => r.style.display = 'none');
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
  showMenu('menuBot', [
    { label: botRunning ? 'Stop Bot' : 'Start Bot', action: toggleBot },
    { label: 'Paper Mode Info...', action: openPaperModeModal },
    { separator: true },
    { label: 'Lock Vault', action: async () => {
      if (await win95Dialog.confirm('Lock the wallet vault? You will need to re-enter your master password to trade.')) {
        masterPassword = '';
        document.getElementById('unlockSection').classList.remove('hidden');
        document.getElementById('tradingWalletsSection').classList.add('hidden');
      }
    }},
  ]);
};

const toggleViewMenu = () => {
  showMenu('menuView', [
    { label: 'Dashboard', action: () => switchTab('dashboard') },
    { label: 'Tracked Wallets', action: () => switchTab('wallets') },
    { label: 'Trading Wallets', action: () => switchTab('trading-wallets') },
    { label: 'Platforms', action: () => switchTab('platforms') },
    { label: 'Cross-Platform', action: () => switchTab('cross-platform') },
    { label: 'Settings', action: () => switchTab('settings') },
    { label: 'Diagnostics', action: () => switchTab('diagnostics') },
    { separator: true },
    { label: 'Refresh Now', action: () => refreshCurrentTab() },
  ]);
};

const toggleHelpMenu = () => {
  showMenu('menuHelp', [
    { label: 'About CopyTrade95...', action: openAboutModal },
    { label: 'What is Paper Mode?', action: openPaperModeModal },
    { separator: true },
    { label: 'GitHub Repository', action: () => window.open('https://github.com/0xAidan/polymarket-bot-test', '_blank') },
  ]);
};

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
    const modalIds = ['tradeDetailModal', 'paperModeModal', 'aboutModal', 'tradingWalletSettingsModal', 'builderCredsModal', 'walletModal', 'mirrorModal'];
    const closeFns = { tradeDetailModal: closeTradeDetailModal, paperModeModal: closePaperModeModal, aboutModal: closeAboutModal, tradingWalletSettingsModal: closeTradingWalletSettingsModal, builderCredsModal: closeBuilderCredsModal, walletModal: closeWalletModal, mirrorModal: closeMirrorModal };
    for (const id of modalIds) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden') && closeFns[id]) {
        closeFns[id]();
        break;
      }
    }
  }
});
