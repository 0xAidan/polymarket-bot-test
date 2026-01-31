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

  async updateWalletTradeConfig(address, config) {
    return this.patch(`/wallets/${address}/trade-config`, config);
  },

  async clearWalletTradeConfig(address) {
    return this.delete(`/wallets/${address}/trade-config`);
  },

  async getWalletBalance(address) {
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
  }
};

// Make API available globally
window.API = API;
