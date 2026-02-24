import { promises as fs } from 'fs';
import path from 'path';
import { config } from './config.js';
import { TradeMetrics, SystemIssue, PerformanceStats, WalletStats, PerformanceDataPoint } from './types.js';

const METRICS_FILE = path.join(config.dataDir, 'trade_metrics.json');
const ISSUES_FILE = path.join(config.dataDir, 'system_issues.json');

/**
 * Tracks performance metrics and system issues
 */
export class PerformanceTracker {
  private startTime: Date;
  private metrics: TradeMetrics[] = [];
  private issues: SystemIssue[] = [];
  private recentTradeKeys = new Map<string, number>();

  constructor() {
    this.startTime = new Date();
  }

  /**
   * Load metrics from file
   */
  async loadMetrics(): Promise<void> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(METRICS_FILE, 'utf-8');
      this.metrics = JSON.parse(data).map((m: any) => ({
        ...m,
        timestamp: new Date(m.timestamp)
      }));
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error('Failed to load metrics:', error);
      }
      this.metrics = [];
    }
  }

  /**
   * Load issues from file
   */
  async loadIssues(): Promise<void> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(ISSUES_FILE, 'utf-8');
      this.issues = JSON.parse(data).map((i: any) => ({
        ...i,
        timestamp: new Date(i.timestamp)
      }));
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error('Failed to load issues:', error);
      }
      this.issues = [];
    }
  }

  /**
   * Save metrics to file
   */
  private async saveMetrics(): Promise<void> {
    try {
      await this.ensureDataDir();
      await fs.writeFile(METRICS_FILE, JSON.stringify(this.metrics, null, 2));
    } catch (error) {
      console.error('Failed to save metrics:', error);
    }
  }

  /**
   * Save issues to file
   */
  private async saveIssues(): Promise<void> {
    try {
      await this.ensureDataDir();
      await fs.writeFile(ISSUES_FILE, JSON.stringify(this.issues, null, 2));
    } catch (error) {
      console.error('Failed to save issues:', error);
    }
  }

  /**
   * Record a trade execution
   */
  async recordTrade(metrics: Omit<TradeMetrics, 'id'>): Promise<void> {
    // Dedup: prevent the same trade from being recorded multiple times in the feed.
    // Uses market+outcome+side+status+5min window as the key so identical rejected/failed
    // entries from repeated polling cycles don't spam the trade feed.
    const ts = metrics.timestamp instanceof Date ? metrics.timestamp.getTime() : Date.now();
    const timeWindow = Math.floor(ts / (5 * 60 * 1000));
    const dedupKey = `${metrics.walletAddress}-${metrics.marketId}-${metrics.outcome}-${metrics.status || 'unknown'}-${timeWindow}`;

    const now = Date.now();
    for (const [key, time] of this.recentTradeKeys.entries()) {
      if (now - time > 5 * 60 * 1000) this.recentTradeKeys.delete(key);
    }

    if (this.recentTradeKeys.has(dedupKey)) {
      return;
    }
    this.recentTradeKeys.set(dedupKey, now);

    const tradeMetric: TradeMetrics = {
      ...metrics,
      id: `${ts}-${Math.random().toString(36).substr(2, 9)}`
    };

    this.metrics.push(tradeMetric);
    
    // Keep only last 1000 trades in memory
    if (this.metrics.length > 1000) {
      this.metrics = this.metrics.slice(-1000);
    }

    await this.saveMetrics();
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
    const issue: SystemIssue = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      severity,
      category,
      message,
      details,
      resolved: false
    };

    this.issues.push(issue);

    // Keep only last 500 issues
    if (this.issues.length > 500) {
      this.issues = this.issues.slice(-500);
    }

    await this.saveIssues();

    // Log to console based on severity
    const logMethod = severity === 'error' ? console.error : severity === 'warning' ? console.warn : console.log;
    logMethod(`[${severity.toUpperCase()}] [${category}] ${message}`, details || '');
  }

  /**
   * Get performance statistics
   */
  async getStats(walletsTracked: number): Promise<PerformanceStats> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const lastHour = new Date(now.getTime() - 60 * 60 * 1000);

    const recentTrades = this.metrics.filter(m => m.timestamp >= last24h);
    const recentTradesLastHour = this.metrics.filter(m => m.timestamp >= lastHour);

    const successfulTrades = this.metrics.filter(m => m.success);
    const failedTrades = this.metrics.filter(m => !m.success);

    const totalVolume = this.metrics.reduce((sum, m) => {
      try {
        return sum + parseFloat(m.amount);
      } catch {
        return sum;
      }
    }, 0).toString();

    const avgLatency = this.metrics.length > 0
      ? this.metrics.reduce((sum, m) => sum + m.executionTimeMs, 0) / this.metrics.length
      : 0;

    const successRate = this.metrics.length > 0
      ? (successfulTrades.length / this.metrics.length) * 100
      : 0;

    const lastTrade = this.metrics.length > 0
      ? this.metrics[this.metrics.length - 1].timestamp
      : undefined;

    return {
      totalTrades: this.metrics.length,
      successfulTrades: successfulTrades.length,
      failedTrades: failedTrades.length,
      successRate: Math.round(successRate * 100) / 100,
      averageLatencyMs: Math.round(avgLatency),
      totalVolume,
      tradesLast24h: recentTrades.length,
      tradesLastHour: recentTradesLastHour.length,
      uptimeMs: now.getTime() - this.startTime.getTime(),
      lastTradeTime: lastTrade,
      issues: this.issues.filter(i => !i.resolved).slice(-20), // Last 20 unresolved issues
      walletsTracked
    };
  }

  /**
   * Get wallet-specific statistics
   */
  getWalletStats(address: string): WalletStats {
    const walletTrades = this.metrics.filter(m => 
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
    return this.metrics.slice(-limit).reverse();
  }

  /**
   * Get all issues (for display)
   */
  getIssues(resolved = false, limit = 50): SystemIssue[] {
    const filtered = this.issues.filter(i => i.resolved === resolved);
    return filtered.slice(-limit).reverse();
  }

  /**
   * Mark an issue as resolved
   */
  async resolveIssue(issueId: string): Promise<void> {
    const issue = this.issues.find(i => i.id === issueId);
    if (issue) {
      issue.resolved = true;
      await this.saveIssues();
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
    if (this.metrics.length === 0) {
      return [{
        timestamp: this.startTime,
        balance: initialBalance,
        totalTrades: 0,
        successfulTrades: 0,
        cumulativeVolume: 0
      }];
    }

    // Sort trades by timestamp
    const sortedTrades = [...this.metrics].sort((a, b) => 
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
