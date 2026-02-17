/**
 * API Communication Layer
 * Handles all communication with the backend API
 */

const API = {
  // Base fetch with error handling
  async fetch(endpoint, options = {}) {
    try {
      const response = await fetch(`/api${endpoint}`, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        },
        ...options
      });
      
      const data = await response.json();
      
      if (!response.ok || data.success === false) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      
      return data;
    } catch (error) {
      console.error(`API Error [${endpoint}]:`, error);
      throw error;
    }
  },

  // GET request
  async get(endpoint) {
    return this.fetch(endpoint);
  },

  // POST request
  async post(endpoint, body) {
    return this.fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  },

  // PATCH request
  async patch(endpoint, body) {
    return this.fetch(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
  },

  // DELETE request
  async delete(endpoint) {
    return this.fetch(endpoint, {
      method: 'DELETE'
    });
  },

  // ============================================================
  // BOT CONTROL
  // ============================================================
  
  async getStatus() {
    return this.get('/status');
  },

  async startBot() {
    return this.post('/start');
  },

  async stopBot() {
    return this.post('/stop');
  },

  // ============================================================
  // WALLET
  // ============================================================

  async getWallet() {
    return this.get('/wallet');
  },

  async getWalletBalance() {
    return this.get('/wallet/balance');
  },

  // ============================================================
  // TRACKED WALLETS
  // ============================================================

  async getWallets() {
    return this.get('/wallets');
  },

  async addWallet(address) {
    return this.post('/wallets', { address });
  },

  async removeWallet(address) {
    return this.delete(`/wallets/${address}`);
  },

  async toggleWallet(address, active) {
    return this.patch(`/wallets/${address}/toggle`, { active });
  },

  async updateWalletLabel(address, label) {
    return this.patch(`/wallets/${address}/label`, { label });
  },

  async updateWalletTags(address, tags) {
    return this.patch(`/wallets/${address}/tags`, { tags });
  },

  async updateWalletTradeConfig(address, config) {
    return this.patch(`/wallets/${address}/trade-config`, config);
  },

  async clearWalletTradeConfig(address) {
    return this.delete(`/wallets/${address}/trade-config`);
  },

  async getTrackedWalletBalance(address) {
    return this.get(`/wallets/${address}/balance`);
  },

  async getWalletStats(address) {
    return this.get(`/wallets/${address}/stats`);
  },

  // ============================================================
  // TRADES
  // ============================================================

  async getTrades(limit = 50) {
    return this.get(`/trades?limit=${limit}`);
  },

  async getFailedTrades(limit = 20) {
    return this.get(`/trades/failed?limit=${limit}`);
  },

  // ============================================================
  // PERFORMANCE
  // ============================================================

  async getPerformance() {
    return this.get('/performance');
  },

  // ============================================================
  // ISSUES
  // ============================================================

  async getIssues(resolved = false, limit = 50) {
    return this.get(`/issues?resolved=${resolved}&limit=${limit}`);
  },

  async resolveIssue(id) {
    return this.post(`/issues/${id}/resolve`);
  },

  // ============================================================
  // CONFIGURATION - Basic
  // ============================================================

  async getTradeSize() {
    return this.get('/config/trade-size');
  },

  async setTradeSize(tradeSize) {
    return this.post('/config/trade-size', { tradeSize });
  },

  async getMonitoringInterval() {
    return this.get('/config/monitoring-interval');
  },

  async setMonitoringInterval(intervalSeconds) {
    return this.post('/config/monitoring-interval', { intervalSeconds });
  },

  async getStopLoss() {
    return this.get('/config/usage-stop-loss');
  },

  async setStopLoss(enabled, maxCommitmentPercent) {
    return this.post('/config/usage-stop-loss', { enabled, maxCommitmentPercent });
  },

  // ============================================================
  // CONFIGURATION - Advanced Trade Filters
  // ============================================================

  async getNoRepeatTrades() {
    return this.get('/config/no-repeat-trades');
  },

  async setNoRepeatTrades(enabled, blockPeriodHours) {
    return this.post('/config/no-repeat-trades', { enabled, blockPeriodHours });
  },

  async getNoRepeatHistory() {
    return this.get('/config/no-repeat-trades/history');
  },

  async clearNoRepeatHistory() {
    return this.delete('/config/no-repeat-trades/history');
  },

  async getPriceLimits() {
    return this.get('/config/price-limits');
  },

  async setPriceLimits(minPrice, maxPrice) {
    return this.post('/config/price-limits', { minPrice, maxPrice });
  },

  async getSlippage() {
    return this.get('/config/slippage');
  },

  async setSlippage(slippagePercent) {
    return this.post('/config/slippage', { slippagePercent });
  },

  async getTradeSideFilter() {
    return this.get('/config/trade-side-filter');
  },

  async setTradeSideFilter(tradeSideFilter) {
    return this.post('/config/trade-side-filter', { tradeSideFilter });
  },

  async getRateLimiting() {
    return this.get('/config/rate-limiting');
  },

  async setRateLimiting(enabled, maxTradesPerHour, maxTradesPerDay) {
    return this.post('/config/rate-limiting', { enabled, maxTradesPerHour, maxTradesPerDay });
  },

  async getRateLimitStatus() {
    return this.get('/config/rate-limiting/status');
  },

  async getTradeValueFilters() {
    return this.get('/config/trade-value-filters');
  },

  async setTradeValueFilters(enabled, minTradeValueUSD, maxTradeValueUSD) {
    return this.post('/config/trade-value-filters', { enabled, minTradeValueUSD, maxTradeValueUSD });
  },

  async getAllConfig() {
    return this.get('/config/all');
  },

  async validateConfig() {
    return this.get('/config/validate');
  },

  // ============================================================
  // SECURITY
  // ============================================================

  async updatePrivateKey(privateKey) {
    return this.post('/config/private-key', { privateKey });
  },

  async updateBuilderCredentials(apiKey, secret, passphrase) {
    return this.post('/config/builder-credentials', { apiKey, secret, passphrase });
  },

  // ============================================================
  // DIAGNOSTICS
  // ============================================================

  async testClobConnectivity() {
    return this.get('/test/clob-connectivity');
  },

  // ============================================================
  // MIRROR POSITIONS
  // ============================================================

  async getMirrorPreview(address, slippageTolerance = 10) {
    return this.post(`/wallets/${address}/mirror-preview`, { slippageTolerance });
  },

  async executeMirrorTrades(address, trades, slippagePercent = 2) {
    try {
      const response = await fetch(`/api/wallets/${address}/mirror-execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades, slippagePercent })
      });
      
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return data;
    } catch (error) {
      console.error('Mirror execute error:', error);
      throw error;
    }
  },

  // ============================================================
  // MULTI-WALLET (Trading Wallets)
  // ============================================================

  async unlockWallets(masterPassword) {
    return this.post('/wallets/unlock', { masterPassword });
  },

  async getLockStatus() {
    return this.get('/wallets/lock-status');
  },

  async getTradingWallets() {
    return this.get('/trading-wallets');
  },

  async addTradingWallet(id, label, privateKey, masterPassword, apiKey, apiSecret, apiPassphrase) {
    return this.post('/trading-wallets', { id, label, privateKey, masterPassword, apiKey, apiSecret, apiPassphrase });
  },

  async updateTradingWalletCredentials(id, apiKey, apiSecret, apiPassphrase, masterPassword) {
    return this.patch(`/trading-wallets/${id}/credentials`, { apiKey, apiSecret, apiPassphrase, masterPassword });
  },

  async removeTradingWallet(id) {
    return this.delete(`/trading-wallets/${id}`);
  },

  async toggleTradingWallet(id, active) {
    return this.patch(`/trading-wallets/${id}/toggle`, { active });
  },

  async getCopyAssignments() {
    return this.get('/copy-assignments');
  },

  async addCopyAssignment(trackedWalletAddress, tradingWalletId, useOwnConfig = false) {
    return this.post('/copy-assignments', { trackedWalletAddress, tradingWalletId, useOwnConfig });
  },

  async removeCopyAssignment(trackedWalletAddress, tradingWalletId) {
    return this.fetch('/copy-assignments', {
      method: 'DELETE',
      body: JSON.stringify({ trackedWalletAddress, tradingWalletId })
    });
  },

  // ============================================================
  // PLATFORM (Multi-platform)
  // ============================================================

  async getPlatforms() {
    return this.get('/platforms');
  },

  async getPlatformBalance(platform) {
    return this.get(`/platforms/${platform}/balance`);
  },

  async getPlatformPositions(platform, identifier) {
    return this.get(`/platforms/${platform}/positions/${identifier}`);
  },

  // ============================================================
  // ENTITIES (Platform Wallets + Cross-Platform Hedges)
  // ============================================================

  async getEntities() {
    return this.get('/entities');
  },

  async addPlatformWallet(entityId, platform, identifier, label) {
    return this.post(`/entities/${entityId}/platform-wallet`, { platform, identifier, label });
  },

  async removePlatformWallet(entityId, platform, identifier) {
    return this.delete(`/entities/${entityId}/platform-wallet/${platform}/${identifier}`);
  },

  async detectCrossPlatformHedges() {
    return this.post('/entities/cross-platform-hedges');
  },

  async getCrossPlatformHedges() {
    return this.get('/entities/cross-platform-hedges');
  },

  // ============================================================
  // CROSS-PLATFORM EXECUTOR
  // ============================================================

  async getExecutorStatus() {
    return this.get('/executor/status');
  },

  async getExecutorHistory() {
    return this.get('/executor/history');
  },

  async getExecutorConfig() {
    return this.get('/executor/config');
  },

  async updateExecutorConfig(config) {
    return this.post('/executor/config', config);
  },

  async executeArb(trade) {
    return this.post('/executor/arb', trade);
  },

  async executeHedge(params) {
    return this.post('/executor/hedge', params);
  },

  // ============================================================
  // ARBITRAGE SCANNER
  // ============================================================

  async getArbStatus() {
    return this.get('/arb/status');
  },

  async getArbOpportunities() {
    return this.get('/arb/opportunities');
  },

  async scanArbitrage() {
    return this.post('/arb/scan');
  },

  // ============================================================
  // HEDGE RECOMMENDATIONS
  // ============================================================

  async getHedgeRecommendations() {
    return this.get('/hedge/recommendations');
  },

  async generateHedgeRecommendations() {
    return this.post('/hedge/generate');
  },

  // ============================================================
  // CROSS-PLATFORM P&L
  // ============================================================

  async getPnlStatus() {
    return this.get('/pnl/status');
  },

  async calculatePnl(walletsByPlatform) {
    return this.post('/pnl/calculate', { walletsByPlatform });
  },

  async getPnlHistory() {
    return this.get('/pnl/history');
  },

  async smartRoute(params) {
    return this.post('/smart-route', params);
  },

  async getMatchedMarkets() {
    return this.get('/matched-markets');
  },

  // ============================================================
  // LADDER EXITS
  // ============================================================

  async getLadderStatus() {
    return this.get('/ladder/status');
  },

  async getLadders(activeOnly = false) {
    return this.get(`/ladder/all?active=${activeOnly}`);
  },

  async createLadder(params) {
    return this.post('/ladder/create', params);
  },

  async cancelLadder(id) {
    return this.post(`/ladder/cancel/${id}`);
  },

  async updateLadderConfig(config) {
    return this.post('/ladder/config', config);
  },

  async getTradingWalletPositions(walletId) {
    return this.get(`/trading-wallets/${walletId}/positions`);
  },

  // ============================================================
  // PRICE MONITOR
  // ============================================================

  async getPriceMonitorStatus() {
    return this.get('/pricemonitor/status');
  },

  async startPriceMonitor() {
    return this.post('/pricemonitor/start');
  },

  async stopPriceMonitor() {
    return this.post('/pricemonitor/stop');
  }
};

// Make API available globally
window.API = API;
