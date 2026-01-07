import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { createRoutes } from './api/routes.js';
import { CopyTrader } from './copyTrader.js';

/**
 * Create and configure the Express server
 */
export async function createServer(copyTrader: CopyTrader): Promise<express.Application> {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // API routes
  app.use('/api', createRoutes(copyTrader));

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve dashboard UI
  app.get('/', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Polymarket Copytrade Bot - Dashboard</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
          }
          .dashboard {
            max-width: 1400px;
            margin: 0 auto;
          }
          .header {
            background: white;
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
          }
          .header h1 {
            color: #333;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .header-controls {
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
          }
          .status-badge {
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 14px;
          }
          .status-badge.running {
            background: #d4edda;
            color: #155724;
          }
          .status-badge.stopped {
            background: #f8d7da;
            color: #721c24;
          }
          .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
          }
          .metric-card {
            background: white;
            padding: 25px;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
          }
          .metric-card h3 {
            color: #666;
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .metric-value {
            font-size: 32px;
            font-weight: 700;
            color: #333;
            margin-bottom: 5px;
          }
          .metric-label {
            font-size: 12px;
            color: #999;
          }
          .metric-card.success { border-left: 4px solid #28a745; }
          .metric-card.warning { border-left: 4px solid #ffc107; }
          .metric-card.danger { border-left: 4px solid #dc3545; }
          .metric-card.info { border-left: 4px solid #17a2b8; }
          .section {
            background: white;
            padding: 25px;
            border-radius: 12px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
          }
          .section h2 {
            color: #333;
            margin-bottom: 20px;
            font-size: 20px;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          button {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
          }
          button:hover { transform: translateY(-2px); box-shadow: 0 4px 8px rgba(0,0,0,0.2); }
          button:active { transform: translateY(0); }
          .btn-primary { background: #007bff; color: white; }
          .btn-danger { background: #dc3545; color: white; }
          .btn-success { background: #28a745; color: white; }
          input[type="text"] {
            padding: 10px 15px;
            border: 2px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            width: 100%;
            max-width: 500px;
            margin-right: 10px;
          }
          input:focus {
            outline: none;
            border-color: #007bff;
          }
          .wallet-input-group {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
          }
          .wallet-list {
            display: grid;
            gap: 15px;
          }
          .wallet-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            border: 1px solid #e9ecef;
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 15px;
            align-items: start;
          }
          .wallet-info {
            display: grid;
            gap: 8px;
          }
          .wallet-address {
            font-family: monospace;
            font-size: 14px;
            color: #333;
            word-break: break-all;
          }
          .wallet-stats {
            display: flex;
            gap: 20px;
            margin-top: 10px;
            flex-wrap: wrap;
          }
          .wallet-stat {
            font-size: 13px;
            color: #666;
          }
          .wallet-stat strong {
            color: #333;
            display: block;
            font-size: 16px;
            margin-bottom: 2px;
          }
          .table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
          }
          .table th,
          .table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #e9ecef;
          }
          .table th {
            background: #f8f9fa;
            font-weight: 600;
            color: #666;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .table td {
            font-size: 14px;
          }
          .badge {
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
          }
          .badge-success { background: #d4edda; color: #155724; }
          .badge-danger { background: #f8d7da; color: #721c24; }
          .badge-yes { background: #cce5ff; color: #004085; }
          .badge-no { background: #ffe5e5; color: #721c24; }
          .issue-item {
            padding: 15px;
            margin-bottom: 10px;
            border-radius: 6px;
            border-left: 4px solid;
            background: #f8f9fa;
          }
          .issue-item.error { border-left-color: #dc3545; }
          .issue-item.warning { border-left-color: #ffc107; }
          .issue-item.info { border-left-color: #17a2b8; }
          .issue-header {
            display: flex;
            justify-content: space-between;
            align-items: start;
            margin-bottom: 5px;
          }
          .issue-message {
            font-weight: 600;
            color: #333;
          }
          .issue-time {
            font-size: 12px;
            color: #999;
          }
          .issue-details {
            font-size: 13px;
            color: #666;
            margin-top: 5px;
          }
          .loading {
            text-align: center;
            padding: 40px;
            color: #999;
          }
          .empty-state {
            text-align: center;
            padding: 40px;
            color: #999;
          }
          @media (max-width: 768px) {
            .metrics-grid {
              grid-template-columns: 1fr;
            }
            .wallet-card {
              grid-template-columns: 1fr;
            }
            .table {
              font-size: 12px;
            }
            .table th,
            .table td {
              padding: 8px;
            }
          }
        </style>
      </head>
      <body>
        <div class="dashboard">
          <div class="header">
            <h1>🤖 Polymarket Copytrade Bot</h1>
            <div class="header-controls">
              <span id="statusBadge" class="status-badge stopped">⏸️ Stopped</span>
              <button id="startBtn" onclick="startBot()" class="btn-success">▶ Start Bot</button>
              <button id="stopBtn" onclick="stopBot()" class="btn-danger">⏸ Stop Bot</button>
            </div>
          </div>

          <div class="metrics-grid" id="metricsGrid">
            <div class="metric-card success">
              <h3>Success Rate</h3>
              <div class="metric-value" id="successRate">0%</div>
              <div class="metric-label">Trade Success</div>
            </div>
            <div class="metric-card info">
              <h3>Total Trades</h3>
              <div class="metric-value" id="totalTrades">0</div>
              <div class="metric-label" id="tradesLabel">All time</div>
            </div>
            <div class="metric-card warning">
              <h3>Average Latency</h3>
              <div class="metric-value" id="avgLatency">0ms</div>
              <div class="metric-label">Execution Time</div>
            </div>
            <div class="metric-card info">
              <h3>Wallets Tracked</h3>
              <div class="metric-value" id="walletsTracked">0</div>
              <div class="metric-label">Active wallets</div>
            </div>
            <div class="metric-card success">
              <h3>Successful Trades</h3>
              <div class="metric-value" id="successfulTrades">0</div>
              <div class="metric-label">Completed</div>
            </div>
            <div class="metric-card danger">
              <h3>Failed Trades</h3>
              <div class="metric-value" id="failedTrades">0</div>
              <div class="metric-label">Errors</div>
            </div>
          </div>

          <div class="section">
            <h2>📊 Tracked Wallets</h2>
            <div class="wallet-input-group">
              <input type="text" id="walletInput" placeholder="Enter wallet address (0x...)" />
              <button onclick="addWallet()" class="btn-success">+ Add Wallet</button>
            </div>
            <div id="walletList" class="wallet-list">
              <div class="loading">Loading wallets...</div>
            </div>
          </div>

          <div class="section">
            <h2>📈 Recent Trades</h2>
            <div id="tradesContainer">
              <div class="loading">Loading trades...</div>
            </div>
          </div>

          <div class="section">
            <h2>⚠️ System Issues</h2>
            <div id="issuesContainer">
              <div class="loading">Loading issues...</div>
            </div>
          </div>
        </div>

        <script>
          // State management
          let updateInterval = null;

          // Format helpers
          function formatTime(ms) {
            if (ms < 1000) return ms + 'ms';
            if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
            if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
            return Math.floor(ms / 3600000) + 'h';
          }

          function formatDate(dateStr) {
            if (!dateStr) return 'N/A';
            const date = new Date(dateStr);
            return date.toLocaleString();
          }

          function formatAddress(address) {
            if (!address) return 'N/A';
            return address.substring(0, 6) + '...' + address.substring(address.length - 4);
          }

          // Load performance metrics
          async function loadPerformance() {
            try {
              const res = await fetch('/api/performance');
              const data = await res.json();
              if (data.success) {
                document.getElementById('successRate').textContent = data.successRate.toFixed(1) + '%';
                document.getElementById('totalTrades').textContent = data.totalTrades;
                document.getElementById('tradesLabel').textContent = 
                  \`\${data.tradesLast24h} last 24h, \${data.tradesLastHour} last hour\`;
                document.getElementById('avgLatency').textContent = 
                  data.averageLatencyMs > 0 ? data.averageLatencyMs + 'ms' : 'N/A';
                document.getElementById('walletsTracked').textContent = data.walletsTracked;
                document.getElementById('successfulTrades').textContent = data.successfulTrades;
                document.getElementById('failedTrades').textContent = data.failedTrades;
              }
            } catch (error) {
              console.error('Failed to load performance:', error);
            }
          }

          // Load status
          async function loadStatus() {
            try {
              const res = await fetch('/api/status');
              const data = await res.json();
              const badge = document.getElementById('statusBadge');
              if (data.running) {
                badge.className = 'status-badge running';
                badge.textContent = \`✅ Running (\${data.executedTradesCount} trades)\`;
              } else {
                badge.className = 'status-badge stopped';
                badge.textContent = '⏸️ Stopped';
              }
            } catch (error) {
              console.error('Failed to load status:', error);
            }
          }

          // Load wallets
          async function loadWallets() {
            try {
              const res = await fetch('/api/wallets');
              const data = await res.json();
              const container = document.getElementById('walletList');
              
              if (data.wallets && data.wallets.length > 0) {
                container.innerHTML = await Promise.all(
                  data.wallets.map(async (w) => {
                    try {
                      const statsRes = await fetch(\`/api/wallets/\${w.address}/stats\`);
                      const statsData = await statsRes.json();
                      if (statsData.success) {
                        const stats = statsData;
                        return \`
                          <div class="wallet-card">
                            <div class="wallet-info">
                              <div class="wallet-address">\${w.address}</div>
                              <div class="wallet-stats">
                                <div class="wallet-stat">
                                  <strong>\${stats.tradesCopied}</strong>
                                  Trades Copied
                                </div>
                                <div class="wallet-stat">
                                  <strong>\${stats.successRate.toFixed(1)}%</strong>
                                  Success Rate
                                </div>
                                <div class="wallet-stat">
                                  <strong>\${stats.averageLatencyMs}ms</strong>
                                  Avg Latency
                                </div>
                                <div class="wallet-stat">
                                  <strong>\${stats.lastActivity ? formatDate(stats.lastActivity) : 'Never'}</strong>
                                  Last Activity
                                </div>
                              </div>
                            </div>
                            <button onclick="removeWallet('\${w.address}')" class="btn-danger">Remove</button>
                          </div>
                        \`;
                      }
                    } catch (e) {
                      console.error('Failed to load wallet stats:', e);
                    }
                    return \`
                      <div class="wallet-card">
                        <div class="wallet-info">
                          <div class="wallet-address">\${w.address}</div>
                          <div class="wallet-stats">
                            <div class="wallet-stat">Added: \${formatDate(w.addedAt)}</div>
                          </div>
                        </div>
                        <button onclick="removeWallet('\${w.address}')" class="btn-danger">Remove</button>
                      </div>
                    \`;
                  })
                ).then(html => html.join(''));
              } else {
                container.innerHTML = '<div class="empty-state">No wallets tracked yet. Add one above to get started!</div>';
              }
            } catch (error) {
              console.error('Failed to load wallets:', error);
              document.getElementById('walletList').innerHTML = 
                '<div class="empty-state">Error loading wallets</div>';
            }
          }

          // Load recent trades
          async function loadTrades() {
            try {
              const res = await fetch('/api/trades?limit=20');
              const data = await res.json();
              const container = document.getElementById('tradesContainer');
              
              if (data.trades && data.trades.length > 0) {
                container.innerHTML = \`
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Wallet</th>
                        <th>Market</th>
                        <th>Outcome</th>
                        <th>Amount</th>
                        <th>Status</th>
                        <th>Latency</th>
                      </tr>
                    </thead>
                    <tbody>
                      \${data.trades.map(t => \`
                        <tr>
                          <td>\${formatDate(t.timestamp)}</td>
                          <td><code>\${formatAddress(t.walletAddress)}</code></td>
                          <td><code>\${formatAddress(t.marketId)}</code></td>
                          <td><span class="badge badge-\${t.outcome.toLowerCase()}">\${t.outcome}</span></td>
                          <td>\${t.amount}</td>
                          <td>
                            <span class="badge badge-\${t.success ? 'success' : 'danger'}">
                              \${t.success ? '✅ Success' : '❌ Failed'}
                            </span>
                          </td>
                          <td>\${t.executionTimeMs}ms</td>
                        </tr>
                      \`).join('')}
                    </tbody>
                  </table>
                \`;
              } else {
                container.innerHTML = '<div class="empty-state">No trades yet. Start the bot and wait for activity!</div>';
              }
            } catch (error) {
              console.error('Failed to load trades:', error);
              document.getElementById('tradesContainer').innerHTML = 
                '<div class="empty-state">Error loading trades</div>';
            }
          }

          // Load issues
          async function loadIssues() {
            try {
              const res = await fetch('/api/issues?resolved=false&limit=10');
              const data = await res.json();
              const container = document.getElementById('issuesContainer');
              
              if (data.issues && data.issues.length > 0) {
                container.innerHTML = data.issues.map(issue => \`
                  <div class="issue-item \${issue.severity}">
                    <div class="issue-header">
                      <div class="issue-message">
                        [\${issue.category}] \${issue.message}
                      </div>
                      <button onclick="resolveIssue('\${issue.id}')" class="btn-primary" style="font-size: 12px; padding: 5px 10px;">Resolve</button>
                    </div>
                    <div class="issue-time">\${formatDate(issue.timestamp)}</div>
                    \${issue.details ? \`<div class="issue-details">\${JSON.stringify(issue.details)}</div>\` : ''}
                  </div>
                \`).join('');
              } else {
                container.innerHTML = '<div class="empty-state">✅ No active issues! Everything looks good.</div>';
              }
            } catch (error) {
              console.error('Failed to load issues:', error);
              document.getElementById('issuesContainer').innerHTML = 
                '<div class="empty-state">Error loading issues</div>';
            }
          }

          // Wallet management
          async function addWallet() {
            const input = document.getElementById('walletInput');
            const address = input.value.trim();
            if (!address) {
              alert('Please enter a wallet address');
              return;
            }

            if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
              alert('Invalid wallet address format');
              return;
            }

            try {
              const res = await fetch('/api/wallets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address })
              });
              const data = await res.json();
              if (data.success) {
                input.value = '';
                loadWallets();
                loadPerformance();
              } else {
                alert('Error: ' + data.error);
              }
            } catch (error) {
              alert('Failed to add wallet');
              console.error(error);
            }
          }

          async function removeWallet(address) {
            if (!confirm('Remove this wallet from tracking?')) return;

            try {
              const res = await fetch(\`/api/wallets/\${address}\`, {
                method: 'DELETE'
              });
              const data = await res.json();
              if (data.success) {
                loadWallets();
                loadPerformance();
              } else {
                alert('Error: ' + data.error);
              }
            } catch (error) {
              alert('Failed to remove wallet');
              console.error(error);
            }
          }

          // Bot control
          async function startBot() {
            try {
              const res = await fetch('/api/start', { method: 'POST' });
              const data = await res.json();
              if (data.success) {
                loadStatus();
              } else {
                alert('Error: ' + data.error);
              }
            } catch (error) {
              alert('Failed to start bot');
              console.error(error);
            }
          }

          async function stopBot() {
            try {
              const res = await fetch('/api/stop', { method: 'POST' });
              const data = await res.json();
              if (data.success) {
                loadStatus();
              } else {
                alert('Error: ' + data.error);
              }
            } catch (error) {
              alert('Failed to stop bot');
              console.error(error);
            }
          }

          // Issue resolution
          async function resolveIssue(issueId) {
            try {
              const res = await fetch(\`/api/issues/\${issueId}/resolve\`, {
                method: 'POST'
              });
              const data = await res.json();
              if (data.success) {
                loadIssues();
              }
            } catch (error) {
              console.error('Failed to resolve issue:', error);
            }
          }

          // Auto-refresh function
          function refreshAll() {
            loadStatus();
            loadPerformance();
            loadWallets();
            loadTrades();
            loadIssues();
          }

          // Allow Enter key to add wallet
          document.addEventListener('DOMContentLoaded', () => {
            const walletInput = document.getElementById('walletInput');
            walletInput.addEventListener('keypress', (e) => {
              if (e.key === 'Enter') {
                addWallet();
              }
            });

            // Initial load
            refreshAll();

            // Auto-refresh every 3 seconds
            updateInterval = setInterval(refreshAll, 3000);
          });

          // Cleanup on page unload
          window.addEventListener('beforeunload', () => {
            if (updateInterval) {
              clearInterval(updateInterval);
            }
          });
        </script>
      </body>
      </html>
    `);
  });

  return app;
}

/**
 * Start the server
 */
export async function startServer(app: express.Application): Promise<void> {
  return new Promise((resolve) => {
    app.listen(config.port, () => {
      console.log(`\n🚀 Server running on http://localhost:${config.port}`);
      console.log(`📊 Open your browser to manage wallets and control the bot\n`);
      resolve();
    });
  });
}
