/**
 * Main Application Logic
 * Handles UI interactions and data binding
 */

// Global state
let currentTab = 'dashboard';
let refreshInterval = null;

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  console.log('Dashboard initialized');
  loadAllData();
  startAutoRefresh();
});

function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    refreshCurrentTab();
  }, 5000); // Refresh every 5 seconds
}

function refreshCurrentTab() {
  switch (currentTab) {
    case 'dashboard':
      loadDashboardData();
      break;
    case 'wallets':
      loadWallets();
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
      loadSettings()
    ]);
  } catch (error) {
    console.error('Error loading data:', error);
  }
}

// ============================================================
// TAB NAVIGATION
// ============================================================

function switchTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  
  // Update tab panels
  document.querySelectorAll('.tab-panel').forEach(panel => {
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
  const badge = document.getElementById('statusBadge');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  
  if (data.running) {
    badge.textContent = 'Running';
    badge.className = 'status-badge status-running';
    startBtn.style.display = 'none';
    stopBtn.style.display = 'inline-flex';
  } else {
    badge.textContent = 'Stopped';
    badge.className = 'status-badge status-stopped';
    startBtn.style.display = 'inline-flex';
    stopBtn.style.display = 'none';
  }
  
  // Update metrics
  if (data.wallets) {
    document.getElementById('walletsTracked').textContent = data.wallets.active;
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
    
    console.log('[Dashboard] Wallet balance:', balance.currentBalance);
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
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No trades yet</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.trades.map(trade => `
      <tr>
        <td>${new Date(trade.timestamp).toLocaleTimeString()}</td>
        <td>${trade.walletLabel || trade.walletAddress.slice(0, 8)}...</td>
        <td>${trade.marketId?.slice(0, 12)}...</td>
        <td>${trade.outcome} ${trade.side || 'BUY'}</td>
        <td>$${parseFloat(trade.amount || 0).toFixed(2)}</td>
        <td><span class="status-pill ${trade.success ? 'success' : (trade.status === 'pending' ? 'pending' : 'failed')}">${trade.status || (trade.success ? 'Executed' : 'Failed')}</span></td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Error loading trades:', error);
  }
}

// ============================================================
// BOT CONTROL
// ============================================================

async function startBot() {
  try {
    await API.startBot();
    await loadStatus();
  } catch (error) {
    alert(`Failed to start bot: ${error.message}`);
  }
}

async function stopBot() {
  try {
    await API.stopBot();
    await loadStatus();
  } catch (error) {
    alert(`Failed to stop bot: ${error.message}`);
  }
}

// ============================================================
// WALLETS
// ============================================================

// Current wallet being configured in modal
let currentWalletAddress = null;

async function loadWallets() {
  try {
    const data = await API.getWallets();
    const list = document.getElementById('walletsList');
    
    if (!data.wallets || data.wallets.length === 0) {
      list.innerHTML = '<div class="empty-state">No wallets tracked yet. Add a wallet address above to start copy trading.</div>';
      return;
    }
    
    // First render without balances
    list.innerHTML = data.wallets.map(wallet => {
      const isActive = wallet.active;
      const configBadges = getWalletConfigBadges(wallet);
      
      return `
        <div class="wallet-item ${isActive ? 'active' : 'inactive'}" id="wallet-${wallet.address}">
          <div class="wallet-item-info">
            <div class="wallet-item-header">
              <div class="wallet-item-address">
                ${wallet.label ? `<span class="wallet-item-label">${wallet.label}</span>` : ''}
                <span style="font-family: monospace;">${wallet.address.slice(0, 10)}...${wallet.address.slice(-8)}</span>
              </div>
              <div class="wallet-item-balance" id="balance-${wallet.address}">
                <span class="balance-loading">Loading...</span>
              </div>
            </div>
            <div class="wallet-item-status">
              <span class="status-dot ${isActive ? 'active' : 'inactive'}"></span>
              <span>${isActive ? 'Active - Copy trading enabled' : 'Inactive - Not copying trades'}</span>
            </div>
            <div class="wallet-item-config" style="margin-top: 8px;">
              ${configBadges}
            </div>
          </div>
          <div class="wallet-item-actions">
            <label class="toggle">
              <input type="checkbox" ${isActive ? 'checked' : ''} onchange="toggleWallet('${wallet.address}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <button class="btn btn-sm btn-primary" onclick="openMirrorModal('${wallet.address}')">Mirror Positions</button>
            <button class="btn btn-sm btn-outline" onclick="openWalletModal('${wallet.address}')">Configure</button>
            <button class="btn btn-sm btn-danger" onclick="removeWallet('${wallet.address}')">Remove</button>
          </div>
        </div>
      `;
    }).join('');
    
    // Then fetch balances asynchronously for each wallet
    for (const wallet of data.wallets) {
      loadTrackedWalletBalance(wallet.address);
    }
  } catch (error) {
    console.error('Error loading wallets:', error);
  }
}

// Fetch and display balance for a tracked wallet
async function loadTrackedWalletBalance(address) {
  const balanceEl = document.getElementById(`balance-${address}`);
  if (!balanceEl) return;
  
  try {
    const res = await fetch(`/api/wallets/${address}/balance`);
    const data = await res.json();
    
    if (data.success && data.currentBalance !== undefined) {
      const totalValue = data.currentBalance;
      const usdcBalance = data.usdcBalance || 0;
      const positionsValue = data.positionsValue || 0;
      const posCount = data.positionCount || 0;
      
      if (totalValue > 0) {
        // Show breakdown: USDC + positions
        let breakdown = [];
        if (usdcBalance > 0) breakdown.push(`$${formatNumber(usdcBalance)} USDC`);
        if (positionsValue > 0) breakdown.push(`$${formatNumber(positionsValue)} in ${posCount} pos`);
        
        balanceEl.innerHTML = `
          <span class="balance-value">$${formatNumber(totalValue)}</span>
          <span class="balance-note">${breakdown.join(' + ') || 'No breakdown'}</span>
        `;
      } else {
        balanceEl.innerHTML = `
          <span class="balance-value muted">$0</span>
          <span class="balance-note">No funds detected</span>
        `;
      }
    } else {
      balanceEl.innerHTML = `<span class="balance-error">Error</span>`;
    }
  } catch (error) {
    console.error(`Error loading balance for ${address}:`, error);
    balanceEl.innerHTML = `<span class="balance-error">-</span>`;
  }
}

// Format number with commas and reasonable decimals
function formatNumber(num) {
  if (num >= 1000) {
    return num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  } else if (num >= 1) {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else {
    return num.toFixed(2);
  }
}

function getWalletConfigBadges(wallet) {
  const badges = [];
  
  // Trade sizing mode
  if (wallet.tradeSizingMode === 'fixed') {
    badges.push(`<span class="badge badge-success">Fixed $${wallet.fixedTradeSize || '?'}</span>`);
    if (wallet.thresholdEnabled) {
      badges.push(`<span class="badge badge-success">${wallet.thresholdPercent}% threshold</span>`);
    }
  } else if (wallet.tradeSizingMode === 'proportional') {
    badges.push(`<span class="badge badge-success">Proportional</span>`);
  } else {
    badges.push(`<span class="badge badge-default">Global size</span>`);
  }
  
  // Trade side filter
  if (wallet.tradeSideFilter && wallet.tradeSideFilter !== 'all') {
    const label = wallet.tradeSideFilter === 'buy_only' ? 'BUY only' : 'SELL only';
    badges.push(`<span class="badge badge-warning">${label}</span>`);
  }
  
  // Advanced filters
  if (wallet.noRepeatEnabled) {
    const period = wallet.noRepeatPeriodHours === 0 ? 'forever' : `${wallet.noRepeatPeriodHours}h`;
    badges.push(`<span class="badge badge-success">No repeat (${period})</span>`);
  }
  
  if (wallet.rateLimitEnabled) {
    badges.push(`<span class="badge badge-success">Rate limited</span>`);
  }
  
  if (wallet.valueFilterEnabled) {
    badges.push(`<span class="badge badge-success">Value filter</span>`);
  }
  
  return badges.join(' ') || '<span class="badge badge-default">Using defaults</span>';
}

function getWalletConfigSummary(wallet) {
  const parts = [];
  
  if (wallet.tradeSizingMode === 'fixed') {
    parts.push(`Fixed $${wallet.fixedTradeSize || 'global'}`);
    if (wallet.thresholdEnabled) {
      parts.push(`${wallet.thresholdPercent}% threshold`);
    }
  } else if (wallet.tradeSizingMode === 'proportional') {
    parts.push('Proportional');
  } else {
    parts.push('Global defaults');
  }
  
  if (wallet.tradeSideFilter && wallet.tradeSideFilter !== 'all') {
    parts.push(wallet.tradeSideFilter === 'buy_only' ? 'BUY only' : 'SELL only');
  }
  
  return parts.join(' | ') || 'Using global settings';
}

async function addWallet() {
  const input = document.getElementById('newWalletAddress');
  const address = input.value.trim();
  
  if (!address) {
    alert('Please enter a wallet address');
    return;
  }
  
  try {
    await API.addWallet(address);
    input.value = '';
    await loadWallets();
    // Prompt to configure the new wallet
    if (confirm('Wallet added (inactive by default). Would you like to configure it now?')) {
      openWalletModal(address.toLowerCase());
    }
  } catch (error) {
    alert(`Failed to add wallet: ${error.message}`);
  }
}

async function removeWallet(address) {
  if (!confirm('Are you sure you want to remove this wallet? This will stop copy trading from this wallet.')) return;
  
  try {
    await API.removeWallet(address);
    await loadWallets();
  } catch (error) {
    alert(`Failed to remove wallet: ${error.message}`);
  }
}

async function toggleWallet(address, active) {
  try {
    await API.toggleWallet(address, active);
    await loadWallets();
  } catch (error) {
    alert(`Failed to toggle wallet: ${error.message}`);
    await loadWallets();
  }
}

// ============================================================
// WALLET CONFIGURATION MODAL
// ============================================================

async function openWalletModal(address) {
  currentWalletAddress = address;
  
  try {
    // Load wallet data
    const data = await API.getWallets();
    const wallet = data.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    
    if (!wallet) {
      alert('Wallet not found');
      return;
    }
    
    // Populate modal fields
    document.getElementById('walletModalTitle').textContent = `Configure: ${wallet.label || address.slice(0, 10) + '...'}`;
    document.getElementById('modalWalletAddress').textContent = address;
    
    const statusEl = document.getElementById('modalWalletStatus');
    statusEl.textContent = wallet.active ? 'Active' : 'Inactive';
    statusEl.className = `wallet-modal-status ${wallet.active ? 'active' : 'inactive'}`;
    
    document.getElementById('modalWalletLabel').value = wallet.label || '';
    
    // Trade size (the primary setting)
    document.getElementById('modalTradeSize').value = wallet.fixedTradeSize || 2;
    
    // Trade sizing mode
    const modeValue = wallet.tradeSizingMode || 'fixed';
    document.querySelector(`input[name="modalTradeSizingMode"][value="${modeValue}"]`).checked = true;
    
    // Threshold settings
    document.getElementById('modalThresholdEnabled').checked = wallet.thresholdEnabled || false;
    document.getElementById('modalThresholdInputs').style.display = wallet.thresholdEnabled ? 'block' : 'none';
    document.getElementById('modalThresholdPercent').value = wallet.thresholdPercent || 10;
    
    // Trade side filter
    const sideValue = wallet.tradeSideFilter || 'all';
    document.querySelector(`input[name="modalTradeSideFilter"][value="${sideValue}"]`).checked = true;
    
    // Advanced filters
    document.getElementById('modalNoRepeatEnabled').checked = wallet.noRepeatEnabled || false;
    document.getElementById('modalNoRepeatInputs').style.display = wallet.noRepeatEnabled ? 'block' : 'none';
    document.getElementById('modalNoRepeatPeriod').value = wallet.noRepeatPeriodHours ?? 24;
    
    document.getElementById('modalPriceLimitsMin').value = wallet.priceLimitsMin ?? 0.01;
    document.getElementById('modalPriceLimitsMax').value = wallet.priceLimitsMax ?? 0.99;
    updatePriceBadge();
    
    document.getElementById('modalValueFilterEnabled').checked = wallet.valueFilterEnabled || false;
    document.getElementById('modalValueFilterInputs').style.display = wallet.valueFilterEnabled ? 'block' : 'none';
    document.getElementById('modalValueFilterMin').value = wallet.valueFilterMin || '';
    document.getElementById('modalValueFilterMax').value = wallet.valueFilterMax || '';
    
    document.getElementById('modalRateLimitEnabled').checked = wallet.rateLimitEnabled || false;
    document.getElementById('modalRateLimitInputs').style.display = wallet.rateLimitEnabled ? 'block' : 'none';
    document.getElementById('modalRateLimitPerHour').value = wallet.rateLimitPerHour ?? 10;
    document.getElementById('modalRateLimitPerDay').value = wallet.rateLimitPerDay ?? 50;
    
    document.getElementById('modalSlippagePercent').value = wallet.slippagePercent || '';
    updateSlippageBadge();
    
    // Update pipeline display
    updateModalPipeline();
    
    // Show modal
    document.getElementById('walletModal').style.display = 'flex';
    
    // Set up event listeners for dynamic updates
    setupModalEventListeners();
    
  } catch (error) {
    console.error('Error loading wallet for modal:', error);
    alert(`Failed to load wallet: ${error.message}`);
  }
}

function setupModalEventListeners() {
  // Trade size change
  document.getElementById('modalTradeSize').onchange = updateModalPipeline;
  
  // Trade sizing mode change
  document.querySelectorAll('input[name="modalTradeSizingMode"]').forEach(radio => {
    radio.onchange = updateModalPipeline;
  });
  
  // Threshold toggle
  document.getElementById('modalThresholdEnabled').onchange = function() {
    document.getElementById('modalThresholdInputs').style.display = this.checked ? 'block' : 'none';
    updateModalPipeline();
  };
  
  // Trade side filter change
  document.querySelectorAll('input[name="modalTradeSideFilter"]').forEach(radio => {
    radio.onchange = updateModalPipeline;
  });
  
  // No repeat toggle
  document.getElementById('modalNoRepeatEnabled').onchange = function() {
    document.getElementById('modalNoRepeatInputs').style.display = this.checked ? 'block' : 'none';
    updateModalPipeline();
  };
  document.getElementById('modalNoRepeatPeriod').onchange = updateModalPipeline;
  
  // Value filter toggle
  document.getElementById('modalValueFilterEnabled').onchange = function() {
    document.getElementById('modalValueFilterInputs').style.display = this.checked ? 'block' : 'none';
    updateModalPipeline();
  };
  document.getElementById('modalValueFilterMin').onchange = updateModalPipeline;
  document.getElementById('modalValueFilterMax').onchange = updateModalPipeline;
  
  // Rate limit toggle
  document.getElementById('modalRateLimitEnabled').onchange = function() {
    document.getElementById('modalRateLimitInputs').style.display = this.checked ? 'block' : 'none';
    updateModalPipeline();
  };
  document.getElementById('modalRateLimitPerHour').onchange = updateModalPipeline;
  document.getElementById('modalRateLimitPerDay').onchange = updateModalPipeline;
  
  // Price limits change
  document.getElementById('modalPriceLimitsMin').onchange = function() {
    updatePriceBadge();
    updateModalPipeline();
  };
  document.getElementById('modalPriceLimitsMax').onchange = function() {
    updatePriceBadge();
    updateModalPipeline();
  };
  
  // Slippage change
  document.getElementById('modalSlippagePercent').onchange = function() {
    updateSlippageBadge();
    updateModalPipeline();
  };
}

// Update the pipeline visualization in the modal
function updateModalPipeline() {
  // Trade size
  const tradeSize = document.getElementById('modalTradeSize').value || 2;
  document.getElementById('modal-pipeline-size-desc').textContent = `$${tradeSize} USDC`;
  
  // Side filter
  const side = document.querySelector('input[name="modalTradeSideFilter"]:checked').value;
  const sideDesc = document.getElementById('modal-pipeline-side-desc');
  const sideStatus = document.getElementById('modal-pipeline-side-status');
  if (side !== 'all') {
    sideDesc.textContent = side === 'buy_only' ? 'BUY only' : 'SELL only';
    sideStatus.textContent = 'ON';
    sideStatus.className = 'step-status on';
  } else {
    sideDesc.textContent = 'All trades';
    sideStatus.textContent = 'OFF';
    sideStatus.className = 'step-status off';
  }
  
  // Price limits
  const minPrice = document.getElementById('modalPriceLimitsMin').value || 0.01;
  const maxPrice = document.getElementById('modalPriceLimitsMax').value || 0.99;
  const isDefaultPrice = parseFloat(minPrice) === 0.01 && parseFloat(maxPrice) === 0.99;
  document.getElementById('modal-pipeline-price-desc').textContent = `$${minPrice} - $${maxPrice}`;
  document.getElementById('modal-pipeline-price-status').textContent = isDefaultPrice ? 'DEFAULT' : 'CUSTOM';
  document.getElementById('modal-pipeline-price-status').className = `step-status ${isDefaultPrice ? 'off' : 'on'}`;
  
  // No repeat
  const noRepeatEnabled = document.getElementById('modalNoRepeatEnabled').checked;
  const noRepeatPeriod = document.getElementById('modalNoRepeatPeriod').value;
  const noRepeatDesc = document.getElementById('modal-pipeline-norepeat-desc');
  const noRepeatStatus = document.getElementById('modal-pipeline-norepeat-status');
  if (noRepeatEnabled) {
    noRepeatDesc.textContent = noRepeatPeriod === '0' ? 'Block forever' : `Block ${noRepeatPeriod}h`;
    noRepeatStatus.textContent = 'ON';
    noRepeatStatus.className = 'step-status on';
  } else {
    noRepeatDesc.textContent = 'Disabled';
    noRepeatStatus.textContent = 'OFF';
    noRepeatStatus.className = 'step-status off';
  }
  
  // Value filter
  const valueEnabled = document.getElementById('modalValueFilterEnabled').checked;
  const valueMin = document.getElementById('modalValueFilterMin').value;
  const valueMax = document.getElementById('modalValueFilterMax').value;
  const valueDesc = document.getElementById('modal-pipeline-value-desc');
  const valueStatus = document.getElementById('modal-pipeline-value-status');
  if (valueEnabled) {
    const parts = [];
    if (valueMin) parts.push(`>$${valueMin}`);
    if (valueMax) parts.push(`<$${valueMax}`);
    valueDesc.textContent = parts.length > 0 ? parts.join(', ') : 'No limits set';
    valueStatus.textContent = 'ON';
    valueStatus.className = 'step-status on';
  } else {
    valueDesc.textContent = 'No limits';
    valueStatus.textContent = 'OFF';
    valueStatus.className = 'step-status off';
  }
  
  // Rate limit
  const rateEnabled = document.getElementById('modalRateLimitEnabled').checked;
  const rateHour = document.getElementById('modalRateLimitPerHour').value || 10;
  const rateDay = document.getElementById('modalRateLimitPerDay').value || 50;
  const rateDesc = document.getElementById('modal-pipeline-rate-desc');
  const rateStatus = document.getElementById('modal-pipeline-rate-status');
  if (rateEnabled) {
    rateDesc.textContent = `${rateHour}/hr, ${rateDay}/day`;
    rateStatus.textContent = 'ON';
    rateStatus.className = 'step-status on';
  } else {
    rateDesc.textContent = 'Unlimited';
    rateStatus.textContent = 'OFF';
    rateStatus.className = 'step-status off';
  }
}

function updatePriceBadge() {
  const min = parseFloat(document.getElementById('modalPriceLimitsMin').value);
  const max = parseFloat(document.getElementById('modalPriceLimitsMax').value);
  const isDefault = min === 0.01 && max === 0.99;
  
  const badge = document.getElementById('modalPriceBadge');
  badge.textContent = isDefault ? 'DEFAULT' : 'CUSTOM';
  badge.className = `badge ${isDefault ? 'badge-default' : 'badge-success'}`;
}

function updateSlippageBadge() {
  const value = document.getElementById('modalSlippagePercent').value;
  const badge = document.getElementById('modalSlippageBadge');
  
  if (!value || parseFloat(value) === 2) {
    badge.textContent = 'DEFAULT (2%)';
    badge.className = 'badge badge-default';
  } else {
    badge.textContent = `${value}%`;
    badge.className = 'badge badge-success';
  }
}

function toggleSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (section) {
    section.style.display = section.style.display === 'none' ? 'block' : 'none';
  }
}

function closeWalletModal() {
  document.getElementById('walletModal').style.display = 'none';
  currentWalletAddress = null;
}

// Save wallet config (draft mode - doesn't enable)
async function saveWalletConfig() {
  if (!currentWalletAddress) return;
  
  try {
    const config = collectModalConfig();
    
    // Update label if changed
    const newLabel = document.getElementById('modalWalletLabel').value.trim();
    await API.updateWalletLabel(currentWalletAddress, newLabel);
    
    // Update trade config
    await API.updateWalletTradeConfig(currentWalletAddress, config);
    
    alert('Configuration saved (wallet remains inactive until enabled)');
    closeWalletModal();
    await loadWallets();
  } catch (error) {
    alert(`Failed to save: ${error.message}`);
  }
}

// Save and enable wallet
async function saveWalletConfigAndEnable() {
  if (!currentWalletAddress) return;
  
  try {
    const config = collectModalConfig();
    
    // Update label if changed
    const newLabel = document.getElementById('modalWalletLabel').value.trim();
    await API.updateWalletLabel(currentWalletAddress, newLabel);
    
    // Update trade config
    await API.updateWalletTradeConfig(currentWalletAddress, config);
    
    // Enable the wallet
    await API.toggleWallet(currentWalletAddress, true);
    
    alert('Configuration saved and wallet enabled!');
    closeWalletModal();
    await loadWallets();
  } catch (error) {
    alert(`Failed to save: ${error.message}`);
  }
}

function collectModalConfig() {
  const mode = document.querySelector('input[name="modalTradeSizingMode"]:checked').value;
  const side = document.querySelector('input[name="modalTradeSideFilter"]:checked').value;
  const tradeSize = parseFloat(document.getElementById('modalTradeSize').value);
  
  return {
    // Trade sizing - use the trade size field for fixed size
    tradeSizingMode: mode || 'fixed',
    fixedTradeSize: tradeSize || 2,
    thresholdEnabled: document.getElementById('modalThresholdEnabled').checked,
    thresholdPercent: document.getElementById('modalThresholdEnabled').checked 
      ? parseFloat(document.getElementById('modalThresholdPercent').value) : null,
    
    // Side filter
    tradeSideFilter: side || 'all',
    
    // No repeat
    noRepeatEnabled: document.getElementById('modalNoRepeatEnabled').checked,
    noRepeatPeriodHours: document.getElementById('modalNoRepeatEnabled').checked 
      ? parseInt(document.getElementById('modalNoRepeatPeriod').value) : null,
    
    // Price limits
    priceLimitsMin: parseFloat(document.getElementById('modalPriceLimitsMin').value) || 0.01,
    priceLimitsMax: parseFloat(document.getElementById('modalPriceLimitsMax').value) || 0.99,
    
    // Value filter
    valueFilterEnabled: document.getElementById('modalValueFilterEnabled').checked,
    valueFilterMin: document.getElementById('modalValueFilterEnabled').checked 
      ? (parseFloat(document.getElementById('modalValueFilterMin').value) || null) : null,
    valueFilterMax: document.getElementById('modalValueFilterEnabled').checked 
      ? (parseFloat(document.getElementById('modalValueFilterMax').value) || null) : null,
    
    // Rate limit
    rateLimitEnabled: document.getElementById('modalRateLimitEnabled').checked,
    rateLimitPerHour: document.getElementById('modalRateLimitEnabled').checked 
      ? parseInt(document.getElementById('modalRateLimitPerHour').value) : null,
    rateLimitPerDay: document.getElementById('modalRateLimitEnabled').checked 
      ? parseInt(document.getElementById('modalRateLimitPerDay').value) : null,
    
    // Slippage
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
    document.getElementById('stopLossInputs').style.display = stopLoss.enabled ? 'block' : 'none';
    document.getElementById('monitoringInterval').value = interval.intervalSeconds || 15;
    
    // Load proxy wallet address if configured
    if (proxyWallet.proxyWalletAddress) {
      document.getElementById('proxyWalletAddress').value = proxyWallet.proxyWalletAddress;
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

async function updateStopLoss() {
  const enabled = document.getElementById('stopLossEnabled').checked;
  const percent = parseInt(document.getElementById('stopLossPercent').value);
  
  document.getElementById('stopLossInputs').style.display = enabled ? 'block' : 'none';
  
  try {
    await API.setStopLoss(enabled, percent);
    await loadFiltersData(); // Update pipeline display
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

async function updateMonitoringInterval() {
  const interval = parseInt(document.getElementById('monitoringInterval').value);
  
  try {
    await API.setMonitoringInterval(interval);
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

async function updatePrivateKey() {
  const privateKey = document.getElementById('privateKey').value;
  
  if (!privateKey) {
    alert('Please enter a private key');
    return;
  }
  
  try {
    await API.updatePrivateKey(privateKey);
    document.getElementById('privateKey').value = '';
    alert('Private key updated and bot reinitialized!');
    // Refresh wallet display
    loadWalletBalance();
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

async function updateBuilderCredentials() {
  const apiKey = document.getElementById('builderApiKey').value;
  const secret = document.getElementById('builderSecret').value;
  const passphrase = document.getElementById('builderPassphrase').value;
  
  if (!apiKey || !secret || !passphrase) {
    alert('Please fill in all fields');
    return;
  }
  
  try {
    await API.updateBuilderCredentials(apiKey, secret, passphrase);
    document.getElementById('builderApiKey').value = '';
    document.getElementById('builderSecret').value = '';
    document.getElementById('builderPassphrase').value = '';
    alert('Builder credentials updated. Bot reinitialized.');
    // Refresh wallet balance to show updated info
    loadWalletBalance();
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

async function updateProxyWallet() {
  const proxyAddress = document.getElementById('proxyWalletAddress').value.trim();
  
  if (!proxyAddress) {
    alert('Please enter your proxy wallet address');
    return;
  }
  
  if (!/^0x[a-fA-F0-9]{40}$/.test(proxyAddress)) {
    alert('Invalid address format. Must be 0x followed by 40 hex characters.');
    return;
  }
  
  try {
    const response = await fetch('/api/config/proxy-wallet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyWalletAddress: proxyAddress })
    });
    const data = await response.json();
    
    if (data.success) {
      alert('Proxy wallet address saved! Balance will update shortly.');
      // Refresh wallet balance to show updated info
      loadWalletBalance();
    } else {
      alert(`Failed to save: ${data.error}`);
    }
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

// ============================================================
// DIAGNOSTICS
// ============================================================

async function testClobConnectivity() {
  const resultsDiv = document.getElementById('clobTestResults');
  resultsDiv.innerHTML = '<div class="empty-state">Running tests...</div>';
  resultsDiv.style.display = 'block';
  
  try {
    const data = await API.testClobConnectivity();
    
    let html = '<h4>Test Results</h4>';
    
    data.tests.forEach(test => {
      html += `
        <div class="test-item">
          <span class="test-icon ${test.success ? 'success' : 'failed'}">${test.success ? '&#10004;' : '&#10008;'}</span>
          <span>${test.name}: ${test.success ? 'Passed' : (test.error || `HTTP ${test.status}`)}</span>
        </div>
      `;
    });
    
    html += `<div class="test-item"><strong>Diagnosis:</strong> ${data.summary.diagnosis}</div>`;
    
    resultsDiv.innerHTML = html;
  } catch (error) {
    resultsDiv.innerHTML = `<div class="empty-state">Test failed: ${error.message}</div>`;
  }
}

async function loadFailedTrades() {
  const container = document.getElementById('failedTradesAnalysis');
  
  try {
    const data = await API.getFailedTrades();
    
    if (!data.trades || data.trades.length === 0) {
      container.innerHTML = '<div class="empty-state">No failed trades found</div>';
      return;
    }
    
    let html = '<h4>Error Type Breakdown</h4>';
    
    for (const [type, count] of Object.entries(data.analysis.errorTypes)) {
      html += `<div class="analysis-stat"><span>${type}</span><span>${count}</span></div>`;
    }
    
    html += `<h4 style="margin-top: 16px;">Recent Failed Trades</h4>`;
    html += data.trades.slice(0, 5).map(t => `
      <div class="issue-item error">
        <div class="issue-content">
          <div class="issue-message">${t.errorType}: ${t.error?.slice(0, 100) || 'Unknown'}</div>
          <div class="issue-time">${new Date(t.timestamp).toLocaleString()} | ${t.marketId?.slice(0, 12)}...</div>
        </div>
      </div>
    `).join('');
    
    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `<div class="empty-state">Failed to load: ${error.message}</div>`;
  }
}

// ============================================================
// MIRROR POSITIONS
// ============================================================

let currentMirrorWallet = null;
let currentMirrorTrades = [];

async function openMirrorModal(address) {
  currentMirrorWallet = address;
  
  // Show modal with loading state
  document.getElementById('mirrorModalTitle').textContent = 'Loading Mirror Preview...';
  document.getElementById('mirrorTradesBody').innerHTML = '<tr><td colspan="8" class="empty-state">Loading positions...</td></tr>';
  document.getElementById('mirrorExecuteBtn').disabled = true;
  document.getElementById('mirrorModal').style.display = 'flex';
  
  try {
    // Get wallet label
    const walletsData = await API.getWallets();
    const wallet = walletsData.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
    const walletLabel = wallet?.label || address.slice(0, 10) + '...';
    
    document.getElementById('mirrorModalTitle').textContent = `Mirror Positions: ${walletLabel}`;
    
    // Get mirror preview
    const preview = await API.getMirrorPreview(address, 10);
    
    // Update portfolio values
    document.getElementById('mirrorYourPortfolio').textContent = `$${formatNumber(preview.yourPortfolioValue)}`;
    document.getElementById('mirrorTheirPortfolio').textContent = `$${formatNumber(preview.theirPortfolioValue)}`;
    
    // Store trades for execution
    currentMirrorTrades = preview.trades;
    
    // Render trades table
    renderMirrorTrades(preview.trades);
    
    // Update summary
    updateMirrorSummary();
    
  } catch (error) {
    console.error('Error loading mirror preview:', error);
    document.getElementById('mirrorTradesBody').innerHTML = 
      `<tr><td colspan="8" class="empty-state">Error: ${error.message}</td></tr>`;
  }
}

function renderMirrorTrades(trades) {
  const tbody = document.getElementById('mirrorTradesBody');
  
  if (!trades || trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No positions to mirror</td></tr>';
    return;
  }
  
  // Separate actionable trades from skipped ones
  const actionableTrades = [];
  const skippedTrades = [];
  
  trades.forEach((trade, index) => {
    trade._originalIndex = index; // Preserve original index for toggle
    if (trade.status === 'skipped' || trade.action === 'SKIP') {
      skippedTrades.push(trade);
    } else {
      actionableTrades.push(trade);
    }
  });
  
  // Render actionable trades
  let html = actionableTrades.map(trade => renderTradeRow(trade, false)).join('');
  
  // Add skipped trades in accordion if any exist
  if (skippedTrades.length > 0) {
    html += `
      <tr class="skipped-accordion-row">
        <td colspan="8">
          <div class="skipped-accordion" onclick="toggleSkippedAccordion()">
            <span class="accordion-icon" id="skippedAccordionIcon">&#9658;</span>
            <span class="accordion-label">Skipped positions (${skippedTrades.length})</span>
            <span class="accordion-hint">Resolved markets, below minimum size, etc.</span>
          </div>
        </td>
      </tr>
    `;
    html += `<tbody id="skippedTradesContainer" style="display: none;">`;
    html += skippedTrades.map(trade => renderTradeRow(trade, true)).join('');
    html += `</tbody>`;
  }
  
  tbody.innerHTML = html;
}

function renderTradeRow(trade, isSkipped) {
  const actionClass = trade.action === 'BUY' ? 'action-buy' : (trade.action === 'SELL' ? 'action-sell' : 'action-skip');
  const rowClass = isSkipped ? 'row-skipped' : (trade.status === 'warning' ? 'row-warning' : '');
  const statusClass = trade.status === 'ready' ? 'status-ready' : (trade.status === 'warning' ? 'status-warning' : 'status-skipped');
  
  const checkbox = !isSkipped 
    ? `<input type="checkbox" ${trade.selected ? 'checked' : ''} onchange="toggleMirrorTrade(${trade._originalIndex}, this.checked)">`
    : '<span class="skip-icon">-</span>';
  
  const priceWarning = trade.priceDeviationPercent && trade.priceDeviationPercent > 0
    ? `<span class="price-deviation" title="Price moved ${trade.priceDeviationPercent}% from their entry">&#9888; ${trade.priceDeviationPercent > 5 ? '+' : ''}${trade.priceDeviationPercent.toFixed(0)}%</span>`
    : '';
  
  const tradeDetails = trade.action === 'SKIP' 
    ? '-'
    : `${trade.action === 'BUY' ? '+' : '-'}${trade.sharesToTrade.toFixed(1)} shares<br><span class="trade-cost">${trade.action === 'BUY' ? '-' : '+'}$${Math.abs(trade.estimatedCost).toFixed(2)}</span>`;
  
  return `
    <tr class="${rowClass}">
      <td>${checkbox}</td>
      <td class="market-cell">
        <div class="market-title">${trade.marketTitle.slice(0, 30)}${trade.marketTitle.length > 30 ? '...' : ''}</div>
        <div class="market-outcome">${trade.outcome}</div>
      </td>
      <td>
        <div>${trade.theirShares.toFixed(1)} shares</div>
        <div class="allocation-percent">${trade.theirAllocationPercent.toFixed(1)}%</div>
      </td>
      <td>
        <div>${trade.yourShares.toFixed(1)} shares</div>
        <div class="allocation-percent">${trade.yourAllocationPercent.toFixed(1)}%</div>
      </td>
      <td><span class="action-badge ${actionClass}">${trade.action}</span></td>
      <td>${tradeDetails}</td>
      <td>
        <div>$${trade.currentPrice.toFixed(2)}</div>
        ${priceWarning}
      </td>
      <td><span class="status-badge ${statusClass}">${isSkipped ? trade.warning || 'Skipped' : trade.status}</span></td>
    </tr>
  `;
}

function toggleSkippedAccordion() {
  const container = document.getElementById('skippedTradesContainer');
  const icon = document.getElementById('skippedAccordionIcon');
  
  if (container.style.display === 'none') {
    container.style.display = 'table-row-group';
    icon.innerHTML = '&#9660;'; // Down arrow
  } else {
    container.style.display = 'none';
    icon.innerHTML = '&#9658;'; // Right arrow
  }
}

function toggleMirrorTrade(index, selected) {
  if (currentMirrorTrades[index]) {
    currentMirrorTrades[index].selected = selected;
    updateMirrorSummary();
  }
}

function updateMirrorSummary() {
  const selectedTrades = currentMirrorTrades.filter(t => t.selected && t.action !== 'SKIP');
  const buyTrades = selectedTrades.filter(t => t.action === 'BUY');
  const sellTrades = selectedTrades.filter(t => t.action === 'SELL');
  
  const buyCost = buyTrades.reduce((sum, t) => sum + t.estimatedCost, 0);
  const sellProceeds = Math.abs(sellTrades.reduce((sum, t) => sum + t.estimatedCost, 0));
  
  const excludedCount = currentMirrorTrades.filter(t => !t.selected && t.status !== 'skipped' && t.action !== 'SKIP').length;
  
  let summaryText = `Selected: `;
  const parts = [];
  if (buyTrades.length > 0) parts.push(`<span class="buy-summary">${buyTrades.length} BUY ($${buyCost.toFixed(2)})</span>`);
  if (sellTrades.length > 0) parts.push(`<span class="sell-summary">${sellTrades.length} SELL (+$${sellProceeds.toFixed(2)})</span>`);
  
  if (parts.length === 0) {
    summaryText = 'No trades selected';
  } else {
    summaryText = `Selected: ${parts.join(' | ')}`;
    if (excludedCount > 0) {
      summaryText += ` <span class="excluded-note">(${excludedCount} excluded - kept as USDC)</span>`;
    }
  }
  
  document.getElementById('mirrorSummaryText').innerHTML = summaryText;
  document.getElementById('mirrorExecuteBtn').disabled = selectedTrades.length === 0;
}

async function executeMirrorTrades() {
  const selectedTrades = currentMirrorTrades.filter(t => t.selected && t.action !== 'SKIP');
  
  if (selectedTrades.length === 0) {
    alert('No trades selected');
    return;
  }
  
  if (!confirm(`Execute ${selectedTrades.length} trade(s)? This will place real orders on Polymarket.`)) {
    return;
  }
  
  // Disable button and show loading
  const btn = document.getElementById('mirrorExecuteBtn');
  btn.disabled = true;
  btn.textContent = 'Executing...';
  
  try {
    const result = await API.executeMirrorTrades(currentMirrorWallet, currentMirrorTrades, 2);
    
    // Build detailed result message
    let message = '';
    
    if (result.summary) {
      message += `SELL Phase: ${result.summary.sellsSucceeded}/${result.summary.sellsAttempted} succeeded\n`;
      message += `BUY Phase: ${result.summary.buysSucceeded}/${result.summary.buysAttempted} succeeded\n\n`;
    }
    
    if (result.success) {
      message = `✓ All ${result.executedTrades} trade(s) executed successfully!\n\n` + message;
      alert(message);
    } else {
      message = `⚠️ Partial execution: ${result.executedTrades} succeeded, ${result.failedTrades} failed\n\n` + message;
      
      if (result.results) {
        const failures = result.results.filter(r => !r.success);
        if (failures.length > 0) {
          message += 'Failed trades:\n' + failures.map(f => `• ${f.marketTitle} (${f.action}): ${f.error}`).join('\n');
        }
      }
      alert(message);
    }
    
    closeMirrorModal();
    
  } catch (error) {
    alert(`Execution failed: ${error.message}`);
    btn.disabled = false;
    btn.textContent = 'Execute Selected';
  }
}

function closeMirrorModal() {
  document.getElementById('mirrorModal').style.display = 'none';
  currentMirrorWallet = null;
  currentMirrorTrades = [];
}
