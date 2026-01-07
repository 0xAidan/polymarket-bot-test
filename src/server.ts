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
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          
          :root {
            --primary: #6366f1;
            --primary-dark: #4f46e5;
            --success: #10b981;
            --danger: #ef4444;
            --warning: #f59e0b;
            --info: #3b82f6;
            --bg: #0f172a;
            --surface: #1e293b;
            --surface-light: #334155;
            --text: #f1f5f9;
            --text-muted: #94a3b8;
            --border: #334155;
            --shadow: rgba(0, 0, 0, 0.3);
          }

          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
            padding: 24px;
            line-height: 1.6;
          }

          .dashboard {
            max-width: 1600px;
            margin: 0 auto;
          }

          .header {
            background: linear-gradient(135deg, var(--surface) 0%, var(--surface-light) 100%);
            padding: 32px;
            border-radius: 16px;
            margin-bottom: 24px;
            box-shadow: 0 8px 24px var(--shadow);
            border: 1px solid var(--border);
          }

          .header-content {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 20px;
          }

          .header h1 {
            font-size: 28px;
            font-weight: 700;
            background: linear-gradient(135deg, var(--primary) 0%, #8b5cf6 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
          }

          .header-controls {
            display: flex;
            gap: 12px;
            align-items: center;
          }

          .status-badge {
            padding: 10px 20px;
            border-radius: 24px;
            font-weight: 600;
            font-size: 14px;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }

          .status-badge.running {
            background: rgba(16, 185, 129, 0.2);
            color: var(--success);
            border: 1px solid rgba(16, 185, 129, 0.3);
          }

          .status-badge.stopped {
            background: rgba(239, 68, 68, 0.2);
            color: var(--danger);
            border: 1px solid rgba(239, 68, 68, 0.3);
          }

          .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px;
            margin-bottom: 24px;
          }

          .metric-card {
            background: var(--surface);
            padding: 24px;
            border-radius: 16px;
            box-shadow: 0 4px 12px var(--shadow);
            border: 1px solid var(--border);
            transition: transform 0.2s, box-shadow 0.2s;
          }

          .metric-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px var(--shadow);
          }

          .metric-card h3 {
            color: var(--text-muted);
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 12px;
            text-transform: uppercase;
            letter-spacing: 1px;
          }

          .metric-value {
            font-size: 36px;
            font-weight: 700;
            margin-bottom: 8px;
            background: linear-gradient(135deg, var(--text) 0%, var(--text-muted) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
          }

          .metric-label {
            font-size: 13px;
            color: var(--text-muted);
          }

          .metric-card.success { border-left: 4px solid var(--success); }
          .metric-card.warning { border-left: 4px solid var(--warning); }
          .metric-card.danger { border-left: 4px solid var(--danger); }
          .metric-card.info { border-left: 4px solid var(--info); }

          .section {
            background: var(--surface);
            padding: 28px;
            border-radius: 16px;
            margin-bottom: 24px;
            box-shadow: 0 4px 12px var(--shadow);
            border: 1px solid var(--border);
          }

          .section h2 {
            font-size: 22px;
            font-weight: 700;
            margin-bottom: 24px;
            color: var(--text);
            display: flex;
            align-items: center;
            gap: 10px;
          }

          button {
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            font-family: inherit;
          }

          button:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
          button:active { transform: translateY(0); }
          button:disabled { opacity: 0.5; cursor: not-allowed; }

          .btn-primary { 
            background: var(--primary); 
            color: white; 
          }
          .btn-primary:hover { background: var(--primary-dark); }

          .btn-danger { 
            background: var(--danger); 
            color: white; 
          }
          .btn-danger:hover { background: #dc2626; }

          .btn-success { 
            background: var(--success); 
            color: white; 
          }
          .btn-success:hover { background: #059669; }

          .input-group {
            display: flex;
            gap: 12px;
            margin-bottom: 24px;
            flex-wrap: wrap;
            align-items: start;
          }

          input[type="text"] {
            flex: 1;
            min-width: 300px;
            padding: 14px 18px;
            border: 2px solid var(--border);
            border-radius: 8px;
            font-size: 14px;
            background: var(--bg);
            color: var(--text);
            font-family: 'Monaco', 'Menlo', monospace;
            transition: all 0.2s;
          }

          input:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
          }

          input.error {
            border-color: var(--danger);
          }

          .input-error {
            color: var(--danger);
            font-size: 13px;
            margin-top: 6px;
            display: none;
          }

          .input-error.show {
            display: block;
          }

          .chart-container {
            position: relative;
            height: 400px;
            margin-top: 20px;
            background: var(--bg);
            border-radius: 12px;
            padding: 20px;
          }

          .wallet-list {
            display: grid;
            gap: 16px;
          }

          .wallet-card {
            background: var(--bg);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid var(--border);
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 20px;
            align-items: start;
            transition: all 0.2s;
          }

          .wallet-card:hover {
            border-color: var(--primary);
            box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2);
          }

          .wallet-info {
            display: grid;
            gap: 12px;
          }

          .wallet-address {
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 15px;
            color: var(--text);
            word-break: break-all;
            font-weight: 500;
          }

          .wallet-stats {
            display: flex;
            gap: 24px;
            margin-top: 8px;
            flex-wrap: wrap;
          }

          .wallet-stat {
            font-size: 13px;
            color: var(--text-muted);
          }

          .wallet-stat strong {
            color: var(--text);
            display: block;
            font-size: 18px;
            margin-bottom: 4px;
            font-weight: 600;
          }

          .table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 16px;
          }

          .table th,
          .table td {
            padding: 14px;
            text-align: left;
            border-bottom: 1px solid var(--border);
          }

          .table th {
            background: var(--bg);
            font-weight: 600;
            color: var(--text-muted);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }

          .table td {
            font-size: 14px;
            color: var(--text);
          }

          .table tr:hover {
            background: rgba(99, 102, 241, 0.05);
          }

          .badge {
            padding: 6px 12px;
            border-radius: 16px;
            font-size: 12px;
            font-weight: 600;
            display: inline-block;
          }

          .badge-success { background: rgba(16, 185, 129, 0.2); color: var(--success); }
          .badge-danger { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
          .badge-yes { background: rgba(59, 130, 246, 0.2); color: var(--info); }
          .badge-no { background: rgba(239, 68, 68, 0.2); color: var(--danger); }

          .issue-item {
            padding: 16px;
            margin-bottom: 12px;
            border-radius: 8px;
            border-left: 4px solid;
            background: var(--bg);
            border: 1px solid var(--border);
          }

          .issue-item.error { border-left-color: var(--danger); }
          .issue-item.warning { border-left-color: var(--warning); }
          .issue-item.info { border-left-color: var(--info); }

          .issue-header {
            display: flex;
            justify-content: space-between;
            align-items: start;
            margin-bottom: 8px;
          }

          .issue-message {
            font-weight: 600;
            color: var(--text);
          }

          .issue-time {
            font-size: 12px;
            color: var(--text-muted);
          }

          .issue-details {
            font-size: 13px;
            color: var(--text-muted);
            margin-top: 8px;
            font-family: monospace;
          }

          .loading, .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--text-muted);
            font-size: 15px;
          }

          .tooltip {
            position: absolute;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 12px;
            box-shadow: 0 8px 24px var(--shadow);
            z-index: 1000;
            pointer-events: none;
            display: none;
            max-width: 300px;
            font-size: 13px;
          }

          .tooltip.show {
            display: block;
          }

          .tooltip h4 {
            margin-bottom: 8px;
            color: var(--text);
            font-size: 14px;
          }

          .tooltip p {
            margin: 4px 0;
            color: var(--text-muted);
            font-size: 12px;
          }

          @media (max-width: 768px) {
            body { padding: 16px; }
            .metrics-grid { grid-template-columns: 1fr; }
            .wallet-card { grid-template-columns: 1fr; }
            .header-content { flex-direction: column; align-items: stretch; }
            .input-group { flex-direction: column; }
            input[type="text"] { min-width: 100%; }
          }
        </style>
      </head>
      <body>
        <div class="dashboard">
          <div class="header">
            <div class="header-content">
              <h1>🤖 Polymarket Copytrade Bot</h1>
              <div class="header-controls">
                <span id="statusBadge" class="status-badge stopped">⏸️ Stopped</span>
                <button id="startBtn" onclick="startBot()" class="btn-success">▶ Start</button>
                <button id="stopBtn" onclick="stopBot()" class="btn-danger">⏸ Stop</button>
              </div>
            </div>
          </div>

          <div class="section" style="margin-bottom: 24px;">
            <h2>💼 Trading Wallet Configuration</h2>
            <div id="walletConfig" style="display: grid; gap: 16px;">
              <div class="wallet-card" style="background: var(--bg);">
                <div class="wallet-info">
                  <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                    <span style="font-size: 16px; color: var(--text-muted);">Your Wallet Address:</span>
                    <span id="tradingWalletAddress" style="font-family: 'Monaco', 'Menlo', monospace; font-size: 15px; color: var(--primary); font-weight: 600; word-break: break-all;">
                      Loading...
                    </span>
                  </div>
                  <div style="display: flex; gap: 24px; margin-top: 16px; flex-wrap: wrap;">
                    <div style="flex: 1; min-width: 200px;">
                      <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 4px;">Current Balance (USDC)</div>
                      <div id="userBalance" style="font-size: 24px; font-weight: 700; color: var(--text);">Loading...</div>
                    </div>
                    <div style="flex: 1; min-width: 200px;">
                      <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 4px;">24h Change</div>
                      <div id="userBalanceChange" style="font-size: 24px; font-weight: 700;">Loading...</div>
                    </div>
                  </div>
                  <div style="padding: 16px; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; font-size: 13px; color: var(--text-muted); margin-top: 16px;">
                    <strong style="color: var(--info); display: block; margin-bottom: 8px;">💡 How to configure your wallet:</strong>
                    <p style="margin: 0;">This wallet is set up using the <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">PRIVATE_KEY</code> in your <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">.env</code> file.</p>
                    <p style="margin: 8px 0 0 0;"><strong>To set up or change your wallet:</strong> Run <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">npm run setup</code> in your terminal, then restart the bot.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="section" style="margin-bottom: 24px;">
            <h2>⚙️ Trade Configuration</h2>
            <div style="display: grid; gap: 16px;">
              <div class="wallet-card" style="background: var(--bg);">
                <div class="wallet-info">
                  <div style="margin-bottom: 16px;">
                    <label style="display: block; font-size: 14px; color: var(--text-muted); margin-bottom: 8px; font-weight: 600;">
                      Trade Size (USD per trade)
                    </label>
                    <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                      <input type="number" id="tradeSizeInput" min="0.01" step="0.01" style="flex: 1; min-width: 200px; padding: 12px; border: 2px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 16px; font-weight: 600;" placeholder="20.00" />
                      <button onclick="saveTradeSize()" class="btn-primary">💾 Save Trade Size</button>
                    </div>
                    <div style="margin-top: 8px; font-size: 13px; color: var(--text-muted);">
                      <span id="tradeSizeInfo">Loading current trade size...</span>
                    </div>
                  </div>
                  <div style="padding: 16px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; font-size: 13px; color: var(--text-muted);">
                    <strong style="color: var(--success); display: block; margin-bottom: 8px;">💡 How trade size works:</strong>
                    <p style="margin: 0;">Instead of copying the exact position size from tracked wallets, the bot will execute trades with a fixed USD amount you configure. For example, if you set $20, every trade will be executed as a $20 position regardless of what the tracked wallet is doing.</p>
                  </div>
                </div>
              </div>
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
            <h2>📈 Performance Over Time</h2>
            <div class="chart-container">
              <canvas id="performanceChart"></canvas>
            </div>
            <div id="chartTooltip" class="tooltip"></div>
          </div>

          <div class="section">
            <h2>📊 Tracked Wallets</h2>
            <div class="input-group">
              <div style="flex: 1; min-width: 300px;">
                <input type="text" id="walletInput" placeholder="Enter wallet address (0x...)" />
                <div id="walletInputError" class="input-error">Invalid wallet address format</div>
              </div>
              <button onclick="addWallet()" class="btn-success">+ Add Wallet</button>
            </div>
            <div id="walletList" class="wallet-list">
              <div class="loading">Loading wallets...</div>
            </div>
          </div>

          <div class="section">
            <h2>📋 Recent Trades</h2>
            <div id="tradesContainer">
              <div class="loading">Loading trades...</div>
            </div>
          </div>

          <div class="section">
            <h2>❌ Failed Trades</h2>
            <div id="failedTradesContainer">
              <div class="loading">Loading failed trades...</div>
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
          let performanceChart = null;
          let tooltip = null;

          // Wallet validation
          function isValidWalletAddress(address) {
            return /^0x[a-fA-F0-9]{40}$/i.test(address);
          }

          function validateWalletInput(input) {
            const errorDiv = document.getElementById('walletInputError');
            const address = input.value.trim();
            
            if (!address) {
              input.classList.remove('error');
              errorDiv.classList.remove('show');
              return true;
            }

            if (!isValidWalletAddress(address)) {
              input.classList.add('error');
              errorDiv.classList.add('show');
              return false;
            }

            input.classList.remove('error');
            errorDiv.classList.remove('show');
            return true;
          }

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

          function formatCurrency(value) {
            return new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: 'USD',
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            }).format(value);
          }

          function formatBalance(value) {
            return new Intl.NumberFormat('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            }).format(value);
          }

          function formatPercent(value) {
            const sign = value >= 0 ? '+' : '';
            return sign + value.toFixed(2) + '%';
          }

          // Initialize Chart.js
          function initChart() {
            const ctx = document.getElementById('performanceChart');
            tooltip = document.getElementById('chartTooltip');
            
            performanceChart = new Chart(ctx, {
              type: 'line',
              data: {
                datasets: [{
                  label: 'Balance',
                  data: [],
                  borderColor: '#6366f1',
                  backgroundColor: 'rgba(99, 102, 241, 0.1)',
                  borderWidth: 2,
                  fill: true,
                  tension: 0.4,
                  pointRadius: 0,
                  pointHoverRadius: 6,
                  pointHoverBackgroundColor: '#6366f1',
                  pointHoverBorderColor: '#fff',
                  pointHoverBorderWidth: 2
                }]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: {
                    display: false
                  },
                  tooltip: {
                    enabled: false,
                    external: function(context) {
                      const tooltipEl = tooltip;
                      if (!tooltipEl) return;
                      
                      if (context.tooltip.opacity === 0) {
                        tooltipEl.classList.remove('show');
                        return;
                      }

                      const dataPoint = context.tooltip.dataPoints[0];
                      if (!dataPoint) return;

                      const point = dataPoint.raw;
                      const tradeDetails = point.tradeDetails;

                      if (tradeDetails) {
                        tooltipEl.innerHTML = \`
                          <h4>Trade Details</h4>
                          <p><strong>Time:</strong> \${formatDate(point.x)}</p>
                          <p><strong>Balance:</strong> \${formatCurrency(point.y)}</p>
                          <p><strong>Outcome:</strong> \${tradeDetails.outcome}</p>
                          <p><strong>Amount:</strong> \${tradeDetails.amount}</p>
                          <p><strong>Price:</strong> \${tradeDetails.price}</p>
                          <p><strong>Status:</strong> \${tradeDetails.success ? '✅ Success' : '❌ Failed'}</p>
                        \`;
                      } else {
                        tooltipEl.innerHTML = \`
                          <h4>Starting Point</h4>
                          <p><strong>Time:</strong> \${formatDate(point.x)}</p>
                          <p><strong>Balance:</strong> \${formatCurrency(point.y)}</p>
                        \`;
                      }

                      const position = context.chart.canvas.getBoundingClientRect();
                      tooltipEl.style.left = position.left + context.tooltip.caretX + 'px';
                      tooltipEl.style.top = position.top + context.tooltip.caretY - 60 + 'px';
                      tooltipEl.classList.add('show');
                    }
                  }
                },
                scales: {
                  x: {
                    type: 'time',
                    time: {
                      displayFormats: {
                        hour: 'HH:mm',
                        day: 'MMM dd'
                      }
                    },
                    grid: {
                      color: 'rgba(148, 163, 184, 0.1)'
                    },
                    ticks: {
                      color: '#94a3b8'
                    }
                  },
                  y: {
                    grid: {
                      color: 'rgba(148, 163, 184, 0.1)'
                    },
                    ticks: {
                      color: '#94a3b8',
                      callback: function(value) {
                        return formatCurrency(value);
                      }
                    }
                  }
                },
                interaction: {
                  intersect: false,
                  mode: 'index'
                }
              }
            });

            loadChartData();
          }

          // Load chart data
          async function loadChartData() {
            try {
              const res = await fetch('/api/performance/data?initialBalance=1000');
              const data = await res.json();
              
              if (data.success && data.dataPoints && data.dataPoints.length > 0) {
                const chartData = data.dataPoints.map(dp => ({
                  x: new Date(dp.timestamp),
                  y: dp.balance,
                  tradeDetails: dp.tradeDetails
                }));

                performanceChart.data.datasets[0].data = chartData;
                performanceChart.update('none');
              }
            } catch (error) {
              console.error('Failed to load chart data:', error);
            }
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
              
              await loadChartData();
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
                      const [statsRes, balanceRes] = await Promise.all([
                        fetch(\`/api/wallets/\${w.address}/stats\`),
                        fetch(\`/api/wallets/\${w.address}/balance\`)
                      ]);
                      
                      const statsData = await statsRes.json();
                      const balanceData = await balanceRes.json();
                      
                      if (statsData.success) {
                        const stats = statsData;
                        let balanceHtml = '';
                        let changeHtml = '';
                        
                        if (balanceData.success) {
                          balanceHtml = \`
                            <div class="wallet-stat">
                              <strong>\${formatBalance(balanceData.currentBalance)} USDC</strong>
                              Current Balance
                            </div>
                          \`;
                          
                          if (balanceData.balance24hAgo !== null) {
                            const change = balanceData.change24h;
                            const changeText = formatPercent(change);
                            const changeColor = change >= 0 ? 'var(--success)' : 'var(--danger)';
                            changeHtml = \`
                              <div class="wallet-stat">
                                <strong style="color: \${changeColor};">\${changeText}</strong>
                                24h Change
                              </div>
                            \`;
                          } else {
                            changeHtml = \`
                              <div class="wallet-stat">
                                <strong style="color: var(--text-muted);">No data</strong>
                                24h Change
                              </div>
                            \`;
                          }
                        }
                        
                        return \`
                          <div class="wallet-card">
                            <div class="wallet-info">
                              <div class="wallet-address">\${w.address}</div>
                              <div class="wallet-stats">
                                \${balanceHtml}
                                \${changeHtml}
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
                    
                    // Fallback: try to load balance even if stats fail
                    try {
                      const balanceRes = await fetch(\`/api/wallets/\${w.address}/balance\`);
                      const balanceData = await balanceRes.json();
                      let balanceHtml = '';
                      let changeHtml = '';
                      
                      if (balanceData.success) {
                        balanceHtml = \`
                          <div class="wallet-stat">
                            <strong>\${formatBalance(balanceData.currentBalance)} USDC</strong>
                            Current Balance
                          </div>
                        \`;
                        
                        if (balanceData.balance24hAgo !== null) {
                          const change = balanceData.change24h;
                          const changeText = formatPercent(change);
                          const changeColor = change >= 0 ? 'var(--success)' : 'var(--danger)';
                          changeHtml = \`
                            <div class="wallet-stat">
                              <strong style="color: \${changeColor};">\${changeText}</strong>
                              24h Change
                            </div>
                          \`;
                        }
                      }
                      
                      return \`
                        <div class="wallet-card">
                          <div class="wallet-info">
                            <div class="wallet-address">\${w.address}</div>
                            <div class="wallet-stats">
                              \${balanceHtml}
                              \${changeHtml}
                              <div class="wallet-stat">Added: \${formatDate(w.addedAt)}</div>
                            </div>
                          </div>
                          <button onclick="removeWallet('\${w.address}')" class="btn-danger">Remove</button>
                        </div>
                      \`;
                    } catch (e2) {
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
                    }
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

          // Load failed trades
          async function loadFailedTrades() {
            try {
              const res = await fetch('/api/trades/failed?limit=50');
              const data = await res.json();
              const container = document.getElementById('failedTradesContainer');
              
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
                        <th>Error Reason</th>
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
                          <td style="max-width: 400px; word-break: break-word;">
                            <span style="color: var(--danger); font-size: 13px;">\${t.error || 'Unknown error'}</span>
                          </td>
                          <td>\${t.executionTimeMs || 'N/A'}ms</td>
                        </tr>
                      \`).join('')}
                    </tbody>
                  </table>
                \`;
              } else {
                container.innerHTML = '<div class="empty-state">✅ No failed trades! All trades executed successfully.</div>';
              }
            } catch (error) {
              console.error('Failed to load failed trades:', error);
              document.getElementById('failedTradesContainer').innerHTML = 
                '<div class="empty-state">Error loading failed trades</div>';
            }
          }

          // Load and save trade size configuration
          async function loadTradeSizeConfig() {
            try {
              const res = await fetch('/api/config');
              const data = await res.json();
              if (data.success && data.config) {
                const tradeSize = data.config.tradeSizeUsd || 20;
                document.getElementById('tradeSizeInput').value = tradeSize;
                document.getElementById('tradeSizeInfo').textContent = 
                  \`Current trade size: $\${tradeSize.toFixed(2)} USD per trade\`;
              }
            } catch (error) {
              console.error('Failed to load trade size config:', error);
              document.getElementById('tradeSizeInfo').textContent = 'Error loading configuration';
            }
          }

          async function saveTradeSize() {
            const input = document.getElementById('tradeSizeInput');
            const tradeSize = parseFloat(input.value);
            
            if (isNaN(tradeSize) || tradeSize <= 0) {
              alert('Please enter a valid trade size (must be greater than 0)');
              return;
            }

            try {
              const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tradeSizeUsd: tradeSize })
              });
              
              const data = await res.json();
              if (data.success) {
                document.getElementById('tradeSizeInfo').textContent = 
                  \`✅ Trade size updated to $\${tradeSize.toFixed(2)} USD per trade\`;
                document.getElementById('tradeSizeInfo').style.color = 'var(--success)';
                setTimeout(() => {
                  document.getElementById('tradeSizeInfo').style.color = 'var(--text-muted)';
                }, 3000);
              } else {
                alert('Failed to save trade size: ' + (data.error || 'Unknown error'));
              }
            } catch (error) {
              console.error('Failed to save trade size:', error);
              alert('Failed to save trade size. Please try again.');
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
                      <button onclick="resolveIssue('\${issue.id}')" class="btn-primary" style="font-size: 12px; padding: 6px 12px;">Resolve</button>
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

            if (!validateWalletInput(input)) {
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
                input.classList.remove('error');
                document.getElementById('walletInputError').classList.remove('show');
                // Force immediate refresh of wallets list
                await loadWallets();
                await loadPerformance();
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

          // Load wallet configuration (trading wallet)
          async function loadWalletConfig() {
            try {
              const res = await fetch('/api/wallet');
              const data = await res.json();
              const walletAddressEl = document.getElementById('tradingWalletAddress');
              
              if (data.success && data.walletAddress) {
                walletAddressEl.textContent = data.walletAddress;
                walletAddressEl.style.color = 'var(--success)';
                // Load balance
                await loadUserBalance();
              } else {
                walletAddressEl.innerHTML = '<span style="color: var(--danger);">❌ Not configured</span><br><span style="font-size: 12px; color: var(--text-muted);">Run: npm run setup</span>';
                document.getElementById('userBalance').textContent = 'N/A';
                document.getElementById('userBalanceChange').textContent = 'N/A';
              }
            } catch (error) {
              console.error('Failed to load wallet config:', error);
              const walletAddressEl = document.getElementById('tradingWalletAddress');
              walletAddressEl.innerHTML = '<span style="color: var(--danger);">❌ Error</span><br><span style="font-size: 12px; color: var(--text-muted);">Run: npm run setup</span>';
              document.getElementById('userBalance').textContent = 'Error';
              document.getElementById('userBalanceChange').textContent = 'Error';
            }
          }

          // Load user wallet balance
          async function loadUserBalance() {
            try {
              const res = await fetch('/api/wallet/balance');
              const data = await res.json();
              
              if (data.success) {
                const balanceEl = document.getElementById('userBalance');
                const changeEl = document.getElementById('userBalanceChange');
                
                balanceEl.textContent = formatBalance(data.currentBalance) + ' USDC';
                
                if (data.balance24hAgo !== null) {
                  const change = data.change24h;
                  const changeText = formatPercent(change);
                  changeEl.textContent = changeText;
                  changeEl.style.color = change >= 0 ? 'var(--success)' : 'var(--danger)';
                } else {
                  changeEl.textContent = 'No data';
                  changeEl.style.color = 'var(--text-muted)';
                }
              } else {
                document.getElementById('userBalance').textContent = 'Error';
                document.getElementById('userBalanceChange').textContent = 'Error';
              }
            } catch (error) {
              console.error('Failed to load user balance:', error);
              document.getElementById('userBalance').textContent = 'Error';
              document.getElementById('userBalanceChange').textContent = 'Error';
            }
          }

          // Auto-refresh function
          function refreshAll() {
            loadStatus();
            loadWalletConfig();
            loadPerformance();
            loadWallets();
            loadTrades();
            loadFailedTrades();
            loadIssues();
            // Balance will be loaded as part of loadWalletConfig and loadWallets
          }

          // Initialize on page load
          document.addEventListener('DOMContentLoaded', () => {
            const walletInput = document.getElementById('walletInput');
            
            // Real-time wallet validation
            walletInput.addEventListener('input', () => {
              validateWalletInput(walletInput);
            });

            walletInput.addEventListener('keypress', (e) => {
              if (e.key === 'Enter') {
                addWallet();
              }
            });

            // Initialize chart
            initChart();

            // Load trade size config
            loadTradeSizeConfig();

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
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, () => {
      console.log(`\n🚀 Server running on http://localhost:${config.port}`);
      console.log(`📊 Open your browser to manage wallets and control the bot\n`);
      resolve();
    });

    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${config.port} is already in use!\n`);
        console.error('To fix this, you can:');
        console.error(`  1. Kill the process using port ${config.port}:`);
        console.error(`     lsof -ti:${config.port} | xargs kill -9`);
        console.error(`  2. Or use a different port by setting PORT in your .env file`);
        console.error(`     Example: PORT=3001 npm run dev\n`);
        reject(error);
      } else {
        reject(error);
      }
    });
  });
}
