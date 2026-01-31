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
    case 'filters':
      loadFiltersData();
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
      loadFiltersData(),
      loadSettings(),
      ConflictDetector.refreshConflictDisplay()
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

async function loadWallets() {
  try {
    const data = await API.getWallets();
    const list = document.getElementById('walletsList');
    
    if (!data.wallets || data.wallets.length === 0) {
      list.innerHTML = '<div class="empty-state">No wallets tracked yet</div>';
      return;
    }
    
    list.innerHTML = data.wallets.map(wallet => `
      <div class="wallet-item">
        <div class="wallet-item-info">
          <div class="wallet-item-address">
            ${wallet.label ? `<span class="wallet-item-label">${wallet.label}</span>` : ''}
            ${wallet.address.slice(0, 10)}...${wallet.address.slice(-8)}
          </div>
          <div class="wallet-item-config">
            ${getWalletConfigSummary(wallet)}
          </div>
        </div>
        <div class="wallet-item-actions">
          <label class="toggle">
            <input type="checkbox" ${wallet.active ? 'checked' : ''} onchange="toggleWallet('${wallet.address}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
          <button class="btn btn-sm btn-outline" onclick="openWalletModal('${wallet.address}')">Configure</button>
          <button class="btn btn-sm btn-danger" onclick="removeWallet('${wallet.address}')">Remove</button>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading wallets:', error);
  }
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
  } catch (error) {
    alert(`Failed to add wallet: ${error.message}`);
  }
}

async function removeWallet(address) {
  if (!confirm('Are you sure you want to remove this wallet?')) return;
  
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
  } catch (error) {
    alert(`Failed to toggle wallet: ${error.message}`);
    await loadWallets();
  }
}

function openWalletModal(address) {
  // Simplified for now - can expand later
  alert(`Configure wallet: ${address}\n\nUse the API or extend this modal to configure per-wallet settings.`);
}

function closeWalletModal() {
  document.getElementById('walletModal').style.display = 'none';
}

// ============================================================
// TRADE FILTERS
// ============================================================

async function loadFiltersData() {
  try {
    const config = await API.getAllConfig();
    const c = config.config;
    
    // Trade Side Filter
    document.querySelector(`input[name="tradeSideFilter"][value="${c.tradeSideFilter || 'all'}"]`).checked = true;
    
    // Price Limits
    document.getElementById('minPrice').value = c.priceLimits?.minPrice || 0.01;
    document.getElementById('maxPrice').value = c.priceLimits?.maxPrice || 0.99;
    
    // No Repeat Trades
    document.getElementById('noRepeatEnabled').checked = c.noRepeatTrades?.enabled || false;
    document.getElementById('noRepeatPeriod').value = c.noRepeatTrades?.blockPeriodHours || 24;
    document.getElementById('noRepeatPeriodRow').style.display = c.noRepeatTrades?.enabled ? 'flex' : 'none';
    document.getElementById('noRepeatHistory').style.display = c.noRepeatTrades?.enabled ? 'flex' : 'none';
    
    // Trade Value Filters
    document.getElementById('valueFilterEnabled').checked = c.tradeValueFilters?.enabled || false;
    document.getElementById('minTradeValue').value = c.tradeValueFilters?.minTradeValueUSD || '';
    document.getElementById('maxTradeValue').value = c.tradeValueFilters?.maxTradeValueUSD || '';
    document.getElementById('valueFilterInputs').style.display = c.tradeValueFilters?.enabled ? 'block' : 'none';
    
    // Rate Limiting
    document.getElementById('rateLimitEnabled').checked = c.rateLimiting?.enabled || false;
    document.getElementById('maxTradesPerHour').value = c.rateLimiting?.maxTradesPerHour || 10;
    document.getElementById('maxTradesPerDay').value = c.rateLimiting?.maxTradesPerDay || 50;
    document.getElementById('rateLimitInputs').style.display = c.rateLimiting?.enabled ? 'block' : 'none';
    
    // Slippage
    document.getElementById('slippagePercent').value = c.slippagePercent || 2;
    
    // Update pipeline display
    updatePipelineDisplay(c);
    
    // Load rate limit status if enabled
    if (c.rateLimiting?.enabled) {
      await loadRateLimitStatus();
    }
    
    // Check for conflicts
    await ConflictDetector.refreshConflictDisplay();
  } catch (error) {
    console.error('Error loading filters data:', error);
  }
}

function updatePipelineDisplay(config) {
  // Side Filter
  const sideFilter = config.tradeSideFilter || 'all';
  document.getElementById('pipeline-side-desc').textContent = 
    sideFilter === 'buy_only' ? 'BUY only' : sideFilter === 'sell_only' ? 'SELL only' : 'All trades';
  document.getElementById('pipeline-side-status').textContent = sideFilter !== 'all' ? 'ON' : 'OFF';
  document.getElementById('pipeline-side-status').className = `step-status ${sideFilter !== 'all' ? 'on' : 'off'}`;
  
  // Price Limits
  const priceLimits = config.priceLimits || { minPrice: 0.01, maxPrice: 0.99 };
  const isDefaultPrice = priceLimits.minPrice === 0.01 && priceLimits.maxPrice === 0.99;
  document.getElementById('pipeline-price-desc').textContent = `$${priceLimits.minPrice} - $${priceLimits.maxPrice}`;
  document.getElementById('pipeline-price-status').textContent = isDefaultPrice ? 'DEFAULT' : 'CUSTOM';
  document.getElementById('pipeline-price-status').className = `step-status ${isDefaultPrice ? 'off' : 'on'}`;
  
  // No Repeat
  const noRepeat = config.noRepeatTrades || { enabled: false };
  document.getElementById('pipeline-norepeat-desc').textContent = noRepeat.enabled ? `Block ${noRepeat.blockPeriodHours}h` : 'Disabled';
  document.getElementById('pipeline-norepeat-status').textContent = noRepeat.enabled ? 'ON' : 'OFF';
  document.getElementById('pipeline-norepeat-status').className = `step-status ${noRepeat.enabled ? 'on' : 'off'}`;
  
  // Value Filter
  const valueFilter = config.tradeValueFilters || { enabled: false };
  let valueDesc = 'No limits';
  if (valueFilter.enabled) {
    const parts = [];
    if (valueFilter.minTradeValueUSD) parts.push(`Min $${valueFilter.minTradeValueUSD}`);
    if (valueFilter.maxTradeValueUSD) parts.push(`Max $${valueFilter.maxTradeValueUSD}`);
    valueDesc = parts.join(', ') || 'No limits set';
  }
  document.getElementById('pipeline-value-desc').textContent = valueDesc;
  document.getElementById('pipeline-value-status').textContent = valueFilter.enabled ? 'ON' : 'OFF';
  document.getElementById('pipeline-value-status').className = `step-status ${valueFilter.enabled ? 'on' : 'off'}`;
  
  // Rate Limiting
  const rateLimit = config.rateLimiting || { enabled: false };
  document.getElementById('pipeline-rate-desc').textContent = rateLimit.enabled 
    ? `${rateLimit.maxTradesPerHour}/hr, ${rateLimit.maxTradesPerDay}/day` 
    : 'Disabled';
  document.getElementById('pipeline-rate-status').textContent = rateLimit.enabled ? 'ON' : 'OFF';
  document.getElementById('pipeline-rate-status').className = `step-status ${rateLimit.enabled ? 'on' : 'off'}`;
  
  // Stop Loss
  const stopLoss = config.usageStopLoss || { enabled: false };
  document.getElementById('pipeline-stoploss-desc').textContent = stopLoss.enabled 
    ? `Max ${stopLoss.maxCommitmentPercent}%` 
    : 'Disabled';
  document.getElementById('pipeline-stoploss-status').textContent = stopLoss.enabled ? 'ON' : 'OFF';
  document.getElementById('pipeline-stoploss-status').className = `step-status ${stopLoss.enabled ? 'on' : 'off'}`;
}

async function loadRateLimitStatus() {
  try {
    const data = await API.getRateLimitStatus();
    document.getElementById('tradesThisHour').textContent = data.current?.tradesThisHour || 0;
    document.getElementById('tradesThisDay').textContent = data.current?.tradesThisDay || 0;
  } catch (error) {
    console.error('Error loading rate limit status:', error);
  }
}

// Filter update functions
async function updateTradeSideFilter(value) {
  try {
    await API.setTradeSideFilter(value);
    await loadFiltersData();
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

async function updatePriceLimits() {
  const minPrice = parseFloat(document.getElementById('minPrice').value);
  const maxPrice = parseFloat(document.getElementById('maxPrice').value);
  
  try {
    await API.setPriceLimits(minPrice, maxPrice);
    await loadFiltersData();
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

async function updateNoRepeatTrades() {
  const enabled = document.getElementById('noRepeatEnabled').checked;
  const blockPeriodHours = parseInt(document.getElementById('noRepeatPeriod').value);
  
  document.getElementById('noRepeatPeriodRow').style.display = enabled ? 'flex' : 'none';
  document.getElementById('noRepeatHistory').style.display = enabled ? 'flex' : 'none';
  
  try {
    await API.setNoRepeatTrades(enabled, blockPeriodHours);
    await loadFiltersData();
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

async function viewNoRepeatHistory() {
  try {
    const data = await API.getNoRepeatHistory();
    const modal = document.getElementById('noRepeatModal');
    const body = document.getElementById('noRepeatModalBody');
    
    if (!data.positions || data.positions.length === 0) {
      body.innerHTML = '<div class="empty-state">No blocked markets</div>';
    } else {
      body.innerHTML = `
        <p>Active blocks: ${data.activeBlocks} / ${data.totalPositions}</p>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr><th>Market</th><th>Side</th><th>Age</th><th>Expires</th><th>Status</th></tr>
            </thead>
            <tbody>
              ${data.positions.map(p => `
                <tr>
                  <td>${p.marketId.slice(0, 12)}...</td>
                  <td>${p.side}</td>
                  <td>${p.age}</td>
                  <td>${new Date(p.expiresAt).toLocaleString()}</td>
                  <td><span class="status-pill ${p.isBlocking ? 'pending' : 'success'}">${p.isBlocking ? 'Blocking' : 'Expired'}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
    
    modal.style.display = 'flex';
  } catch (error) {
    alert(`Failed to load history: ${error.message}`);
  }
}

function closeNoRepeatModal() {
  document.getElementById('noRepeatModal').style.display = 'none';
}

async function clearNoRepeatHistory() {
  if (!confirm('Clear all blocked markets? This will allow repeat trades in all markets.')) return;
  
  try {
    await API.clearNoRepeatHistory();
    alert('History cleared');
  } catch (error) {
    alert(`Failed to clear: ${error.message}`);
  }
}

async function updateTradeValueFilters() {
  const enabled = document.getElementById('valueFilterEnabled').checked;
  const minValue = document.getElementById('minTradeValue').value || null;
  const maxValue = document.getElementById('maxTradeValue').value || null;
  
  document.getElementById('valueFilterInputs').style.display = enabled ? 'block' : 'none';
  
  try {
    await API.setTradeValueFilters(enabled, minValue ? parseFloat(minValue) : null, maxValue ? parseFloat(maxValue) : null);
    await loadFiltersData();
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

async function updateRateLimiting() {
  const enabled = document.getElementById('rateLimitEnabled').checked;
  const maxPerHour = parseInt(document.getElementById('maxTradesPerHour').value);
  const maxPerDay = parseInt(document.getElementById('maxTradesPerDay').value);
  
  document.getElementById('rateLimitInputs').style.display = enabled ? 'block' : 'none';
  
  try {
    await API.setRateLimiting(enabled, maxPerHour, maxPerDay);
    await loadFiltersData();
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

async function updateSlippage() {
  const slippagePercent = parseFloat(document.getElementById('slippagePercent').value);
  
  try {
    await API.setSlippage(slippagePercent);
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
  }
}

// ============================================================
// SETTINGS
// ============================================================

async function loadSettings() {
  try {
    const [tradeSize, stopLoss, interval] = await Promise.all([
      API.getTradeSize(),
      API.getStopLoss(),
      API.getMonitoringInterval()
    ]);
    
    document.getElementById('tradeSize').value = tradeSize.tradeSize || 2;
    document.getElementById('stopLossEnabled').checked = stopLoss.enabled || false;
    document.getElementById('stopLossPercent').value = stopLoss.maxCommitmentPercent || 80;
    document.getElementById('stopLossInputs').style.display = stopLoss.enabled ? 'block' : 'none';
    document.getElementById('monitoringInterval').value = interval.intervalSeconds || 15;
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

async function updateTradeSize() {
  const size = document.getElementById('tradeSize').value;
  
  try {
    await API.setTradeSize(size);
  } catch (error) {
    alert(`Failed to update: ${error.message}`);
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
    alert('Private key updated. Restart the bot to apply.');
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
    alert('Builder credentials updated. Restart the bot to apply.');
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
