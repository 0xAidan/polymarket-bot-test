/**
 * CopyTrade95 - Main Application Logic
 * Win95-themed Polymarket Copy Trading Bot Dashboard
 */

// Global state
let currentTab = 'dashboard';
let refreshInterval = null;
let botRunning = false;

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
      checkLockStatus()
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
    loadTrades()
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

async function loadTrades() {
  try {
    const data = await API.getTrades(10);
    const tbody = document.getElementById('tradesTableBody');
    
    if (!data.trades || data.trades.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No trades yet</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.trades.map(trade => `
      <tr>
        <td>${new Date(trade.timestamp).toLocaleTimeString()}</td>
        <td>${trade.walletLabel || trade.walletAddress.slice(0, 8)}...</td>
        <td>${trade.marketId?.slice(0, 12)}...</td>
        <td>${trade.outcome} ${trade.side || 'BUY'}</td>
        <td>$${parseFloat(trade.amount || 0).toFixed(2)}</td>
        <td><span class="status-pill ${trade.success ? 'success' : (trade.status === 'pending' ? 'pending' : 'failed')}">${trade.status || (trade.success ? 'OK' : 'FAIL')}</span></td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Error loading trades:', error);
  }
}

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
    alert(`Failed: ${error.message}`);
  }
}

function toggleBotMenu() {
  toggleBot();
}

async function startBot() {
  try { await API.startBot(); await loadStatus(); }
  catch (error) { alert(`Failed to start bot: ${error.message}`); }
}

async function stopBot() {
  try { await API.stopBot(); await loadStatus(); }
  catch (error) { alert(`Failed to stop bot: ${error.message}`); }
}

// ============================================================
// TRACKED WALLETS
// ============================================================

let currentWalletAddress = null;

async function loadWallets() {
  try {
    const data = await API.getWallets();
    const list = document.getElementById('walletsList');
    
    if (!data.wallets || data.wallets.length === 0) {
      list.innerHTML = '<div class="text-center text-muted" style="padding:20px;">No wallets tracked yet. Add a wallet address above to start copy trading.</div>';
      return;
    }
    
    list.innerHTML = data.wallets.map(wallet => {
      const isActive = wallet.active;
      const configBadges = getWalletConfigBadges(wallet);
      
      return `
        <div class="wallet-entry ${isActive ? 'active-wallet' : 'inactive-wallet'}" id="wallet-${wallet.address}">
          <div class="wallet-entry-info">
            <div class="wallet-entry-address">
              ${wallet.label ? `<span class="wallet-entry-label">${wallet.label}</span>` : ''}
              <span class="text-mono">${wallet.address.slice(0, 10)}...${wallet.address.slice(-8)}</span>
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
  if (!address) { alert('Please enter a wallet address'); return; }
  
  try {
    await API.addWallet(address);
    input.value = '';
    await loadWallets();
    if (confirm('Wallet added (inactive by default). Configure it now?')) {
      openWalletModal(address.toLowerCase());
    }
  } catch (error) {
    alert(`Failed to add wallet: ${error.message}`);
  }
}

async function removeWallet(address) {
  if (!confirm('Remove this tracked wallet?')) return;
  try { await API.removeWallet(address); await loadWallets(); }
  catch (error) { alert(`Failed to remove wallet: ${error.message}`); }
}

async function toggleWallet(address, active) {
  try { await API.toggleWallet(address, active); await loadWallets(); }
  catch (error) { alert(`Failed to toggle wallet: ${error.message}`); await loadWallets(); }
}

// ============================================================
// WALLET CONFIGURATION MODAL
// ============================================================

async function openWalletModal(address) {
  currentWalletAddress = address;
  
  try {
    const data = await API.getWallets();
    const wallet = data.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) { alert('Wallet not found'); return; }
    
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
    
    updateModalPipeline();
    document.getElementById('walletModal').classList.remove('hidden');
    setupModalEventListeners();
  } catch (error) {
    alert(`Failed to load wallet: ${error.message}`);
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

async function saveWalletConfig() {
  if (!currentWalletAddress) return;
  try {
    const config = collectModalConfig();
    await API.updateWalletLabel(currentWalletAddress, document.getElementById('modalWalletLabel').value.trim());
    await API.updateWalletTradeConfig(currentWalletAddress, config);
    alert('Configuration saved (wallet remains inactive until enabled)');
    closeWalletModal();
    await loadWallets();
  } catch (error) { alert(`Failed to save: ${error.message}`); }
}

async function saveWalletConfigAndEnable() {
  if (!currentWalletAddress) return;
  try {
    const config = collectModalConfig();
    await API.updateWalletLabel(currentWalletAddress, document.getElementById('modalWalletLabel').value.trim());
    await API.updateWalletTradeConfig(currentWalletAddress, config);
    await API.toggleWallet(currentWalletAddress, true);
    alert('Configuration saved and wallet enabled!');
    closeWalletModal();
    await loadWallets();
  } catch (error) { alert(`Failed to save: ${error.message}`); }
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
  try { await API.setStopLoss(enabled, percent); } catch (error) { alert(`Failed: ${error.message}`); }
}

async function updateMonitoringInterval() {
  try { await API.setMonitoringInterval(parseInt(document.getElementById('monitoringInterval').value)); }
  catch (error) { alert(`Failed: ${error.message}`); }
}

async function updatePrivateKey() {
  const pk = document.getElementById('privateKey').value;
  if (!pk) { alert('Please enter a private key'); return; }
  try { await API.updatePrivateKey(pk); document.getElementById('privateKey').value = ''; alert('Private key updated!'); loadWalletBalance(); }
  catch (error) { alert(`Failed: ${error.message}`); }
}

async function updateBuilderCredentials() {
  const apiKey = document.getElementById('builderApiKey').value;
  const secret = document.getElementById('builderSecret').value;
  const passphrase = document.getElementById('builderPassphrase').value;
  if (!apiKey || !secret || !passphrase) { alert('Please fill in all fields'); return; }
  try {
    await API.updateBuilderCredentials(apiKey, secret, passphrase);
    document.getElementById('builderApiKey').value = '';
    document.getElementById('builderSecret').value = '';
    document.getElementById('builderPassphrase').value = '';
    alert('Builder credentials updated.');
    loadWalletBalance();
  } catch (error) { alert(`Failed: ${error.message}`); }
}

async function updateProxyWallet() {
  const addr = document.getElementById('proxyWalletAddress').value.trim();
  if (!addr) { alert('Please enter your proxy wallet address'); return; }
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) { alert('Invalid address format.'); return; }
  try {
    const response = await fetch('/api/config/proxy-wallet', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyWalletAddress: addr })
    });
    const data = await response.json();
    if (data.success) { alert('Proxy wallet saved!'); loadWalletBalance(); }
    else alert(`Failed: ${data.error}`);
  } catch (error) { alert(`Failed: ${error.message}`); }
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

async function checkLockStatus() {
  try {
    const data = await API.getLockStatus();
    if (data.unlocked) {
      document.getElementById('unlockSection').classList.add('hidden');
      document.getElementById('tradingWalletsSection').classList.remove('hidden');
      loadTradingWallets();
    }
  } catch (error) { console.error('Error checking lock status:', error); }
}

async function unlockVault() {
  const pw = document.getElementById('masterPasswordInput').value;
  if (!pw) { alert('Enter your master password'); return; }
  
  try {
    const result = await API.unlockWallets(pw);
    masterPassword = pw;
    if (result.migrated) {
      alert('Existing .env private key was migrated to encrypted storage as "main" wallet.');
    }
    document.getElementById('unlockSection').classList.add('hidden');
    document.getElementById('tradingWalletsSection').classList.remove('hidden');
    await loadTradingWallets();
  } catch (error) {
    alert(`Unlock failed: ${error.message}`);
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
    
    list.innerHTML = data.wallets.map(w => `
      <div class="trading-wallet-card ${w.isActive ? 'active-card' : 'inactive-card'}">
        <div class="flex-between flex-wrap gap-8">
          <div>
            <div class="text-bold">${w.label} <span class="win-badge ${w.isActive ? 'badge-success' : ''}">${w.id}</span></div>
            <div class="text-mono text-sm">${w.address}</div>
            <div class="text-sm text-muted">Created: ${new Date(w.createdAt).toLocaleDateString()}</div>
          </div>
          <div class="flex-row gap-4">
            <label class="win-toggle">
              <input type="checkbox" ${w.isActive ? 'checked' : ''} onchange="toggleTradingWalletActive('${w.id}', this.checked)">
            </label>
            <button class="win-btn win-btn-sm win-btn-danger" onclick="removeTradingWalletUI('${w.id}')">Remove</button>
          </div>
        </div>
      </div>
    `).join('');
    
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
  
  if (!id || !label || !pk) { alert('All fields are required'); return; }
  if (!masterPassword) { alert('Wallets must be unlocked first'); return; }
  
  try {
    await API.addTradingWallet(id, label, pk, masterPassword);
    document.getElementById('newTradingWalletId').value = '';
    document.getElementById('newTradingWalletLabel').value = '';
    document.getElementById('newTradingWalletKey').value = '';
    alert('Trading wallet added!');
    await loadTradingWallets();
  } catch (error) {
    alert(`Failed: ${error.message}`);
  }
}

async function removeTradingWalletUI(id) {
  if (!confirm(`Remove trading wallet "${id}"? This will delete the encrypted keystore.`)) return;
  try { await API.removeTradingWallet(id); await loadTradingWallets(); }
  catch (error) { alert(`Failed: ${error.message}`); }
}

async function toggleTradingWalletActive(id, active) {
  try { await API.toggleTradingWallet(id, active); await loadTradingWallets(); }
  catch (error) { alert(`Failed: ${error.message}`); await loadTradingWallets(); }
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
  if (!tracked || !trading) { alert('Select both wallets'); return; }
  
  try {
    await API.addCopyAssignment(tracked, trading, false);
    await loadCopyAssignments();
  } catch (error) { alert(`Failed: ${error.message}`); }
}

async function removeAssignment(tracked, trading) {
  try { await API.removeCopyAssignment(tracked, trading); await loadCopyAssignments(); }
  catch (error) { alert(`Failed: ${error.message}`); }
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
  if (selected.length === 0) { alert('No trades selected'); return; }
  if (!confirm(`Execute ${selected.length} trade(s)? This will place real orders.`)) return;
  
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
    
    alert(msg);
    closeMirrorModal();
  } catch (error) {
    alert(`Execution failed: ${error.message}`);
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
