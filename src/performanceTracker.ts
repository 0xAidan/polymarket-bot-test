import { promises as fs, existsSync, readFileSync } from 'fs';
import path from 'path';
import { config } from './config.js';
import { TradeMetrics, SystemIssue, PerformanceStats, WalletStats, PerformanceDataPoint } from './types.js';
import { createComponentLogger } from './logger.js';
import { getTenantIdOrDefault } from './tenantContext.js';

const log = createComponentLogger('PerformanceTracker');

function scopedTenantId(): string {
  const tenantId = getTenantIdOrDefault();
  return tenantId.replace(/[^A-Za-z0-9_-]/g, '_');
}

function metricsFileForTenant(tenantId: string): string {
  return path.join(config.dataDir, `trade_metrics_${tenantId}.json`);
}

function issuesFileForTenant(tenantId: string): string {
  return path.join(config.dataDir, `system_issues_${tenantId}.json`);
}

/**
 * Tracks performance metrics and system issues
 */
export class PerformanceTracker {
  private startTime: Date;
  private metricsByTenant = new Map<string, TradeMetrics[]>();
  private issuesByTenant = new Map<string, SystemIssue[]>();
  private recentTradeKeysByTenant = new Map<string, Map<string, number>>();
  private loadedTenants = new Set<string>();

  constructor() {
    this.startTime = new Date();
  }

  private getMetricsStore(tenantId: string): TradeMetrics[] {
    let metrics = this.metricsByTenant.get(tenantId);
    if (!metrics) {
      metrics = [];
      this.metricsByTenant.set(tenantId, metrics);
    }
    return metrics;
  }

  private getIssuesStore(tenantId: string): SystemIssue[] {
    let issues = this.issuesByTenant.get(tenantId);
    if (!issues) {
      issues = [];
      this.issuesByTenant.set(tenantId, issues);
    }
    return issues;
  }

  private getRecentTradeKeyStore(tenantId: string): Map<string, number> {
    let keys = this.recentTradeKeysByTenant.get(tenantId);
    if (!keys) {
      keys = new Map();
      this.recentTradeKeysByTenant.set(tenantId, keys);
    }
    return keys;
  }

  private async ensureTenantLoaded(tenantId: string): Promise<void> {
    if (this.loadedTenants.has(tenantId)) {
      return;
    }
    await this.loadMetricsForTenant(tenantId);
    await this.loadIssuesForTenant(tenantId);
    this.loadedTenants.add(tenantId);
  }

  private ensureTenantLoadedSync(tenantId: string): void {
    if (this.loadedTenants.has(tenantId)) {
      return;
    }

    const metricsFile = metricsFileForTenant(tenantId);
    const issuesFile = issuesFileForTenant(tenantId);

    if (existsSync(metricsFile)) {
      const metrics = JSON.parse(readFileSync(metricsFile, 'utf-8')).map((m: any) => ({
        ...m,
        timestamp: new Date(m.timestamp),
      }));
      this.metricsByTenant.set(tenantId, metrics);
    } else {
      this.metricsByTenant.set(tenantId, []);
    }

    if (existsSync(issuesFile)) {
      const issues = JSON.parse(readFileSync(issuesFile, 'utf-8')).map((i: any) => ({
        ...i,
        timestamp: new Date(i.timestamp),
      }));
      this.issuesByTenant.set(tenantId, issues);
    } else {
      this.issuesByTenant.set(tenantId, []);
    }

    this.loadedTenants.add(tenantId);
  }

  /**
   * Load metrics from file
   */
  async loadMetrics(): Promise<void> {
    await this.loadMetricsForTenant(scopedTenantId());
  }

  private async loadMetricsForTenant(tenantId: string): Promise<void> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(metricsFileForTenant(tenantId), 'utf-8');
      this.metricsByTenant.set(tenantId, JSON.parse(data).map((m: any) => ({
        ...m,
        timestamp: new Date(m.timestamp)
      })));
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        log.error({ err: error }, 'Failed to load metrics')
      }
      this.metricsByTenant.set(tenantId, []);
    }
  }

  /**
   * Load issues from file
   */
  async loadIssues(): Promise<void> {
    await this.loadIssuesForTenant(scopedTenantId());
  }

  private async loadIssuesForTenant(tenantId: string): Promise<void> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(issuesFileForTenant(tenantId), 'utf-8');
      this.issuesByTenant.set(tenantId, JSON.parse(data).map((i: any) => ({
        ...i,
        timestamp: new Date(i.timestamp)
      })));
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        log.error({ err: error }, 'Failed to load issues')
      }
      this.issuesByTenant.set(tenantId, []);
    }
  }

  /**
   * Save metrics to file
   */
  private async saveMetrics(tenantId: string): Promise<void> {
    try {
      await this.ensureDataDir();
      await fs.writeFile(metricsFileForTenant(tenantId), JSON.stringify(this.getMetricsStore(tenantId), null, 2));
    } catch (error) {
      log.error({ err: error }, 'Failed to save metrics')
    }
  }

  /**
   * Save issues to file
   */
  private async saveIssues(tenantId: string): Promise<void> {
    try {
      await this.ensureDataDir();
      await fs.writeFile(issuesFileForTenant(tenantId), JSON.stringify(this.getIssuesStore(tenantId), null, 2));
    } catch (error) {
      log.error({ err: error }, 'Failed to save issues')
    }
  }

  /**
   * Record a trade execution
   */
  async recordTrade(metrics: Omit<TradeMetrics, 'id'>): Promise<void> {
    const tenantId = scopedTenantId();
    await this.ensureTenantLoaded(tenantId);
    const tenantMetrics = this.getMetricsStore(tenantId);
    const recentTradeKeys = this.getRecentTradeKeyStore(tenantId);

    // Dedup: prevent the same trade from being recorded multiple times in the feed.
    // Uses market+outcome+side+status+5min window as the key so identical rejected/failed
    // entries from repeated polling cycles don't spam the trade feed.
    const ts = metrics.timestamp instanceof Date ? metrics.timestamp.getTime() : Date.now();
    const timeWindow = Math.floor(ts / (5 * 60 * 1000));
    const dedupKey = `${metrics.walletAddress}-${metrics.marketId}-${metrics.outcome}-${metrics.status || 'unknown'}-${timeWindow}`;

    const now = Date.now();
    for (const [key, time] of recentTradeKeys.entries()) {
      if (now - time > 5 * 60 * 1000) recentTradeKeys.delete(key);
    }

    if (recentTradeKeys.has(dedupKey)) {
      return;
    }
    recentTradeKeys.set(dedupKey, now);

    const tradeMetric: TradeMetrics = {
      ...metrics,
      id: `${ts}-${Math.random().toString(36).substr(2, 9)}`
    };

    tenantMetrics.push(tradeMetric);

    // Keep only last 1000 trades in memory
    if (tenantMetrics.length > 1000) {
      this.metricsByTenant.set(tenantId, tenantMetrics.slice(-1000));
    }

    await this.saveMetrics(tenantId);
  }

  /**
   * Log a system issue
   */
  async logIssue(
    severity: SystemIssue['severity'],
    category: SystemIssue['category'],
    message: string,
    details?: any
  ): Promise<void> {
    const tenantId = scopedTenantId();
    await this.ensureTenantLoaded(tenantId);
    const issues = this.getIssuesStore(tenantId);
    const issue: SystemIssue = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      severity,
      category,
      message,
      details,
      resolved: false
    };

    issues.push(issue);

    // Keep only last 500 issues
    if (issues.length > 500) {
      this.issuesByTenant.set(tenantId, issues.slice(-500));
    }

    await this.saveIssues(tenantId);

    // Log to structured logger based on severity
    const logLevel = severity === 'error' ? 'error' : severity === 'warning' ? 'warn' : 'info';
    log[logLevel]({ category, details }, message);
  }

  /**
   * Get performance statistics
   */
  async getStats(walletsTracked: number): Promise<PerformanceStats> {
    const tenantId = scopedTenantId();
    await this.ensureTenantLoaded(tenantId);
    const metrics = this.getMetricsStore(tenantId);
    const issues = this.getIssuesStore(tenantId);
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const lastHour = new Date(now.getTime() - 60 * 60 * 1000);

    const recentTrades = metrics.filter(m => m.timestamp >= last24h);
    const recentTradesLastHour = metrics.filter(m => m.timestamp >= lastHour);

    const successfulTrades = metrics.filter(m => m.success);
    const failedTrades = metrics.filter(m => !m.success);

    const totalVolume = metrics.reduce((sum, m) => {
      try {
        return sum + parseFloat(m.amount);
      } catch {
        return sum;
      }
    }, 0).toString();

    const avgLatency = metrics.length > 0
      ? metrics.reduce((sum, m) => sum + m.executionTimeMs, 0) / metrics.length
      : 0;

    const successRate = metrics.length > 0
      ? (successfulTrades.length / metrics.length) * 100
      : 0;

    const lastTrade = metrics.length > 0
      ? metrics[metrics.length - 1].timestamp
      : undefined;

    return {
      totalTrades: metrics.length,
      successfulTrades: successfulTrades.length,
      failedTrades: failedTrades.length,
      successRate: Math.round(successRate * 100) / 100,
      averageLatencyMs: Math.round(avgLatency),
      totalVolume,
      tradesLast24h: recentTrades.length,
      tradesLastHour: recentTradesLastHour.length,
      uptimeMs: now.getTime() - this.startTime.getTime(),
      lastTradeTime: lastTrade,
      issues: issues.filter(i => !i.resolved).slice(-20), // Last 20 unresolved issues
      walletsTracked
    };
  }

  /**
   * Get wallet-specific statistics
   */
  getWalletStats(address: string): WalletStats {
    const tenantId = scopedTenantId();
    this.ensureTenantLoadedSync(tenantId);
    const walletTrades = this.getMetricsStore(tenantId).filter(m =>
      m.walletAddress.toLowerCase() === address.toLowerCase()
    );

    const successful = walletTrades.filter(m => m.success);
    const failed = walletTrades.filter(m => !m.success);

    const avgLatency = walletTrades.length > 0
      ? walletTrades.reduce((sum, m) => sum + m.executionTimeMs, 0) / walletTrades.length
      : 0;

    const successRate = walletTrades.length > 0
      ? (successful.length / walletTrades.length) * 100
      : 0;

    const lastActivity = walletTrades.length > 0
      ? walletTrades[walletTrades.length - 1].timestamp
      : undefined;

    return {
      address,
      tradesCopied: walletTrades.length,
      successfulCopies: successful.length,
      failedCopies: failed.length,
      successRate: Math.round(successRate * 100) / 100,
      averageLatencyMs: Math.round(avgLatency),
      lastActivity
    };
  }

  /**
   * Get all recent trades (for display)
   */
  getRecentTrades(limit = 50): TradeMetrics[] {
    const tenantId = scopedTenantId();
    this.ensureTenantLoadedSync(tenantId);
    return this.getMetricsStore(tenantId).slice(-limit).reverse();
  }

  /**
   * Get all issues (for display)
   */
  getIssues(resolved = false, limit = 50): SystemIssue[] {
    const tenantId = scopedTenantId();
    this.ensureTenantLoadedSync(tenantId);
    const filtered = this.getIssuesStore(tenantId).filter(i => i.resolved === resolved);
    return filtered.slice(-limit).reverse();
  }

  /**
   * Mark an issue as resolved
   */
  async resolveIssue(issueId: string): Promise<void> {
    const tenantId = scopedTenantId();
    await this.ensureTenantLoaded(tenantId);
    const issue = this.getIssuesStore(tenantId).find(i => i.id === issueId);
    if (issue) {
      issue.resolved = true;
      await this.saveIssues(tenantId);
    }
  }

  /**
   * Ensure data directory exists
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(config.dataDir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
  }

  /**
   * Get performance data over time for charting
   * Simulates balance changes based on trade outcomes
   */
  getPerformanceData(initialBalance = 1000): PerformanceDataPoint[] {
    const tenantId = scopedTenantId();
    this.ensureTenantLoadedSync(tenantId);
    const metrics = this.getMetricsStore(tenantId);

    if (metrics.length === 0) {
      return [{
        timestamp: this.startTime,
        balance: initialBalance,
        totalTrades: 0,
        successfulTrades: 0,
        cumulativeVolume: 0
      }];
    }

    // Sort trades by timestamp
    const sortedTrades = [...metrics].sort((a, b) =>
      a.timestamp.getTime() - b.timestamp.getTime()
    );

    const dataPoints: PerformanceDataPoint[] = [];
    let currentBalance = initialBalance;
    let cumulativeVolume = 0;

    // Add starting point
    dataPoints.push({
      timestamp: this.startTime,
      balance: currentBalance,
      totalTrades: 0,
      successfulTrades: 0,
      cumulativeVolume: 0
    });

    // Process each trade
    let successfulCount = 0;
    for (const trade of sortedTrades) {
      cumulativeVolume += parseFloat(trade.amount) || 0;

      // Simulate balance change
      // For successful trades, assume small profit/loss based on price movement
      // This is a simplified model - in reality you'd track actual P&L
      if (trade.success) {
        const amount = parseFloat(trade.amount) || 0;
        const price = parseFloat(trade.price) || 0;
        // Simple model: assume we can profit if price moves favorably
        // In practice, you'd need to track actual position outcomes
        const estimatedPnL = amount * price * 0.02; // 2% estimated gain/loss
        currentBalance += estimatedPnL;
        successfulCount++;
      } else {
        // Failed trades don't affect balance (order didn't execute)
      }

      dataPoints.push({
        timestamp: trade.timestamp,
        balance: Math.max(0, currentBalance), // Ensure non-negative
        totalTrades: dataPoints.length,
        successfulTrades: successfulCount,
        cumulativeVolume,
        tradeId: trade.id,
        tradeDetails: {
          marketId: trade.marketId,
          outcome: trade.outcome,
          amount: trade.amount,
          price: trade.price,
          success: trade.success
        }
      });
    }

    return dataPoints;
  }

  /**
   * Initialize - load existing data
   */
  async initialize(): Promise<void> {
    await this.loadMetrics();
    await this.loadIssues();
  }
}
