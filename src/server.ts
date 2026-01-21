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

          .wallet-list {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }

          .wallet-card {
            background: var(--bg);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            gap: 16px;
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

          .table tr.trade-row {
            cursor: pointer;
            transition: background 0.2s;
          }

          .table tr.trade-row:hover {
            background: rgba(99, 102, 241, 0.1);
          }

          .trade-details-row {
            display: none;
          }
          
          .trade-details-row.show {
            display: table-row;
          }

          .trade-details-row td {
            padding: 0 !important;
            border-bottom: 1px solid var(--border);
          }

          .trade-details-content {
            padding: 16px 20px;
            background: var(--bg);
            border-left: 3px solid var(--primary);
          }

          .trade-details-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
          }

          .trade-detail-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
          }

          .trade-detail-label {
            font-size: 11px;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }

          .trade-detail-value {
            font-size: 13px;
            color: var(--text);
            font-family: 'Monaco', 'Menlo', monospace;
            word-break: break-all;
          }

          .trade-detail-value a {
            color: var(--primary);
            text-decoration: none;
          }

          .trade-detail-value a:hover {
            text-decoration: underline;
          }

          .trade-error {
            margin-top: 12px;
            padding: 12px;
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.3);
            border-radius: 8px;
            color: var(--danger);
            font-size: 13px;
          }

          .expand-indicator {
            color: var(--text-muted);
            font-size: 12px;
            transition: transform 0.2s;
            display: inline-block;
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
          .badge-warning { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
          .badge-pending { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
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

          /* Modal styles */
          .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.75);
            z-index: 10000;
            align-items: center;
            justify-content: center;
            padding: 20px;
            overflow-y: auto;
          }

          .modal.show {
            display: flex;
          }

          .modal-content {
            background: var(--surface);
            border-radius: 16px;
            border: 1px solid var(--border);
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
            max-width: 1200px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            position: relative;
            animation: modalSlideIn 0.3s ease-out;
          }

          @keyframes modalSlideIn {
            from {
              opacity: 0;
              transform: translateY(-20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          .modal-header {
            padding: 24px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            background: var(--surface);
            z-index: 10;
          }

          .modal-header h2 {
            margin: 0;
            font-size: 22px;
            color: var(--text);
          }

          .modal-close {
            background: none;
            border: none;
            color: var(--text-muted);
            font-size: 28px;
            cursor: pointer;
            padding: 0;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
            transition: all 0.2s;
          }

          .modal-close:hover {
            background: var(--bg);
            color: var(--text);
          }

          .modal-body {
            padding: 24px;
          }

          .wallet-status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }

          .wallet-status-badge.active {
            background: rgba(16, 185, 129, 0.2);
            color: var(--success);
            border: 1px solid rgba(16, 185, 129, 0.3);
          }

          .wallet-status-badge.inactive {
            background: rgba(148, 163, 184, 0.2);
            color: var(--text-muted);
            border: 1px solid rgba(148, 163, 184, 0.3);
          }

          .wallet-card.wallet-inactive {
            opacity: 0.7;
          }

          .toggle-switch {
            position: relative;
            display: inline-block;
            width: 48px;
            height: 24px;
          }

          .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
          }

          .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--surface-light);
            transition: 0.3s;
            border-radius: 24px;
          }

          .toggle-slider:before {
            position: absolute;
            content: "";
            height: 18px;
            width: 18px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            transition: 0.3s;
            border-radius: 50%;
          }

          .toggle-switch input:checked + .toggle-slider {
            background-color: var(--success);
          }

          .toggle-switch input:checked + .toggle-slider:before {
            transform: translateX(24px);
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
                    <span style="font-size: 16px; color: var(--text-muted);">Your Trading Wallet:</span>
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
            <h2>⚙️ Copy Trade Configuration</h2>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; align-items: start;">
              <div style="background: var(--bg); padding: 20px; border-radius: 12px; border: 1px solid var(--border);">
                <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px;">Trade Size (USDC)</div>
                <div style="display: flex; gap: 8px; align-items: center;">
                  <input 
                    type="text" 
                    id="tradeSizeInput" 
                    placeholder="10" 
                    style="flex: 1; padding: 10px 14px; border: 2px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 14px; min-width: 100px;"
                  />
                  <button onclick="saveTradeSize()" class="btn-primary" style="padding: 10px 20px; white-space: nowrap;">Save</button>
                </div>
                <div id="tradeSizeError" class="input-error">Invalid trade size</div>
                <div style="font-size: 12px; color: var(--text-muted); margin-top: 8px; line-height: 1.5;">
                  Fixed USD value used for all copy trades. The bot will calculate the number of shares based on the detected trade price (USD ÷ price = shares).
                </div>
              </div>
              <div style="background: rgba(99, 102, 241, 0.1); padding: 20px; border-radius: 12px; border: 1px solid rgba(99, 102, 241, 0.3);">
                <div style="font-size: 14px; font-weight: 600; color: var(--primary); margin-bottom: 8px;">💡 How it works</div>
                <div style="font-size: 13px; color: var(--text-muted); line-height: 1.6;">
                  The bot copies trade direction (BUY/SELL) and outcome (YES/NO) from tracked wallets, but uses your configured trade size instead of their exact amount.
                </div>
              </div>
            </div>
            
            <!-- Position Threshold Filter Section -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; align-items: start; margin-top: 20px;">
              <div style="background: var(--bg); padding: 20px; border-radius: 12px; border: 1px solid var(--border);">
                <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px;">Position Threshold Filter</div>
                
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                  <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                    <input 
                      type="checkbox" 
                      id="thresholdEnabled" 
                      onchange="toggleThreshold()"
                      style="width: 18px; height: 18px; cursor: pointer;"
                    />
                    <span style="font-size: 14px; color: var(--text);">Enable threshold filter</span>
                  </label>
                </div>
                
                <div style="display: flex; gap: 8px; align-items: center;">
                  <span style="font-size: 13px; color: var(--text-muted);">Min position size:</span>
                  <input 
                    type="number" 
                    id="thresholdPercent" 
                    placeholder="10" 
                    min="0.1"
                    max="100"
                    step="0.1"
                    style="width: 80px; padding: 8px 12px; border: 2px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 14px;"
                  />
                  <span style="font-size: 13px; color: var(--text-muted);">%</span>
                  <button onclick="saveThreshold()" class="btn-primary" style="padding: 8px 16px; white-space: nowrap;">Save</button>
                </div>
                <div id="thresholdError" class="input-error">Invalid threshold</div>
                <div id="thresholdStatus" style="font-size: 12px; margin-top: 12px; padding: 8px 12px; border-radius: 6px; background: var(--surface);"></div>
              </div>
              
              <div style="background: rgba(34, 197, 94, 0.1); padding: 20px; border-radius: 12px; border: 1px solid rgba(34, 197, 94, 0.3);">
                <div style="font-size: 14px; font-weight: 600; color: #22c55e; margin-bottom: 8px;">🎯 Noise Filter</div>
                <div style="font-size: 13px; color: var(--text-muted); line-height: 1.6;">
                  Only copy trades where the position is at least X% of the tracked wallet's USDC balance.
                  <br><br>
                  <strong>Example:</strong> If threshold is 10% and wallet has $1M USDC, only trades ≥ $100K will be copied. Smaller trades (likely arbitrage/noise) are skipped.
                </div>
              </div>
            </div>
          </div>

          <div class="section" style="margin-bottom: 24px;">
            <h2>⚙️ Bot Settings</h2>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px;">
              <div style="background: var(--bg); padding: 20px; border-radius: 12px; border: 1px solid var(--border);">
                <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px;">Scan Frequency (seconds)</div>
                <div style="display: flex; gap: 8px; align-items: center;">
                  <input 
                    type="number" 
                    id="monitoringIntervalInput" 
                    placeholder="5" 
                    min="1"
                    max="300"
                    step="1"
                    style="flex: 1; padding: 10px 14px; border: 2px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 14px; min-width: 100px;"
                  />
                  <button onclick="saveMonitoringInterval()" class="btn-primary" style="padding: 10px 20px; white-space: nowrap;">Save</button>
                </div>
                <div id="monitoringIntervalError" class="input-error">Invalid interval</div>
                <div style="font-size: 12px; color: var(--text-muted); margin-top: 8px; line-height: 1.5;">
                  How often the bot checks for new trades (1-300 seconds)
                </div>
              </div>
            </div>
          </div>

          <div class="section" style="margin-bottom: 24px;">
            <h2>🔐 Security Configuration</h2>
            <div style="padding: 20px; background: rgba(239, 68, 68, 0.1); border: 2px solid rgba(239, 68, 68, 0.3); border-radius: 12px; margin-bottom: 20px;">
              <div style="font-size: 14px; font-weight: 600; color: var(--danger); margin-bottom: 8px;">⚠️ Security Warning</div>
              <div style="font-size: 13px; color: var(--text-muted); line-height: 1.6;">
                The configuration below contains sensitive credentials. Only update these if you understand the security implications.
                These values are stored securely and are required for the bot to function properly.
              </div>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px;">
              <div style="background: var(--bg); padding: 20px; border-radius: 12px; border: 1px solid var(--border);">
                <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px;">Private Key</div>
                <div style="display: flex; gap: 8px; align-items: start; flex-direction: column;">
                  <input 
                    type="password" 
                    id="privateKeyInput" 
                    placeholder="0x..." 
                    style="width: 100%; padding: 10px 14px; border: 2px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 14px; font-family: monospace;"
                  />
                  <button onclick="savePrivateKey()" class="btn-primary" style="width: 100%; padding: 10px 20px;">Save Private Key</button>
                </div>
                <div id="privateKeyError" class="input-error">Invalid private key</div>
                <div style="font-size: 12px; color: var(--text-muted); margin-top: 8px; line-height: 1.5;">
                  Your wallet's private key (starts with 0x, 66 characters)
                </div>
              </div>
              <div style="background: var(--bg); padding: 20px; border-radius: 12px; border: 1px solid var(--border);">
                <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px;">Builder API Key</div>
                <div style="display: flex; gap: 8px; align-items: start; flex-direction: column;">
                  <input 
                    type="text" 
                    id="builderApiKeyInput" 
                    placeholder="Your Builder API Key" 
                    style="width: 100%; padding: 10px 14px; border: 2px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 14px;"
                  />
                  <button onclick="saveBuilderCredentials()" class="btn-primary" style="width: 100%; padding: 10px 20px;">Save Builder Credentials</button>
                </div>
                <div id="builderCredentialsError" class="input-error">Error saving credentials</div>
                <div style="font-size: 12px; color: var(--text-muted); margin-top: 8px; line-height: 1.5;">
                  Get from: <a href="https://polymarket.com/settings?tab=builder" target="_blank" style="color: var(--primary);">Polymarket Settings</a>
                </div>
              </div>
              <div style="background: var(--bg); padding: 20px; border-radius: 12px; border: 1px solid var(--border);">
                <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px;">Builder API Secret</div>
                <input 
                  type="password" 
                  id="builderSecretInput" 
                  placeholder="Your Builder API Secret" 
                  style="width: 100%; padding: 10px 14px; border: 2px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 14px; margin-bottom: 12px;"
                />
              </div>
              <div style="background: var(--bg); padding: 20px; border-radius: 12px; border: 1px solid var(--border);">
                <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px;">Builder API Passphrase</div>
                <input 
                  type="password" 
                  id="builderPassphraseInput" 
                  placeholder="Your Builder API Passphrase" 
                  style="width: 100%; padding: 10px 14px; border: 2px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 14px; margin-bottom: 12px;"
                />
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
            <h2>🔍 Trade Execution Diagnostics</h2>
            <div id="diagnosticsContainer">
              <div style="padding: 20px; background: var(--bg); border-radius: 12px; border: 1px solid var(--border); margin-bottom: 20px;">
                <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px;">Understanding HTTP 400 Errors</div>
                <div style="font-size: 13px; color: var(--text-muted); line-height: 1.6; margin-bottom: 16px;">
                  When you see "HTTP 400 - request was rejected" errors, the CLOB API is rejecting the order. Common causes:
                </div>
                <ul style="font-size: 13px; color: var(--text-muted); line-height: 1.8; margin-left: 20px; margin-bottom: 16px;">
                  <li><strong>Invalid Token ID:</strong> The tokenId may be expired, invalid, or the market may be closed</li>
                  <li><strong>Price Format:</strong> Price must be between 0 and 1, and match the market's tick size</li>
                  <li><strong>Size Issues:</strong> Order size may be too large, too small, or not match minimum requirements</li>
                  <li><strong>Insufficient Balance:</strong> Your wallet may not have enough USDC to cover the order</li>
                  <li><strong>Market Status:</strong> Market may be closed, paused, or in a state that doesn't accept orders</li>
                  <li><strong>Builder Credentials:</strong> Missing or invalid Builder API credentials (though this usually causes 403, not 400)</li>
                </ul>
                <div style="padding: 12px; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; font-size: 12px; color: var(--text-muted);">
                  <strong style="color: var(--info); display: block; margin-bottom: 4px;">💡 Tip:</strong>
                  Check the terminal/console logs for detailed error information. The logs show the exact request parameters and CLOB API response.
                </div>
              </div>
              <div id="failedTradesAnalysis" style="padding: 20px; background: var(--bg); border-radius: 12px; border: 1px solid var(--border);">
                <div style="font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px;">Failed Trades Analysis</div>
                <div class="loading">Loading analysis...</div>
              </div>
            </div>
          </div>

          <div class="section">
            <h2>⚠️ System Issues</h2>
            <div id="issuesContainer">
              <div class="loading">Loading issues...</div>
            </div>
          </div>
        </div>

        <!-- Wallet Details Modal -->
        <div id="walletDetailsModal" class="modal">
          <div class="modal-content">
            <div class="modal-header">
              <h2 id="walletDetailsTitle">Wallet Details</h2>
              <button class="modal-close" onclick="closeWalletDetailsModal()">&times;</button>
            </div>
            <div class="modal-body">
              <div id="walletDetailsContent">
                <div class="loading">Loading wallet details...</div>
              </div>
            </div>
          </div>
        </div>

        <script>
          // State management
          let updateInterval = null;

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
                        
                        const displayName = w.label || w.address;
                        const showAddress = w.label ? \`<div style="font-size: 11px; color: var(--text-muted); font-family: monospace; margin-top: 4px;">\${w.address}</div>\` : '';
                        return \`
                          <div class="wallet-card \${w.active ? '' : 'wallet-inactive'}" style="border-left: 4px solid \${w.active ? 'var(--success)' : 'var(--text-muted)'};">
                            <div style="display: flex; align-items: center; gap: 12px; justify-content: space-between; flex-wrap: wrap;">
                              <div style="flex: 1; min-width: 200px; cursor: pointer;" onclick="openWalletDetails('\${w.address}')">
                                <div style="font-size: 16px; font-weight: 600; color: var(--text);">\${displayName}</div>
                                \${showAddress}
                              </div>
                              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                <span class="wallet-status-badge \${w.active ? 'active' : 'inactive'}">
                                  \${w.active ? '✓ Active' : '○ Inactive'}
                                </span>
                                \${w.autoBumpToMinimum ? '<span style="background: var(--warning); color: #000; padding: 4px 8px; border-radius: 6px; font-size: 10px; font-weight: 600;">⚡ 100% MODE</span>' : ''}
                                <button onclick="event.stopPropagation(); editWalletLabel('\${w.address}', '\${(w.label || '').replace(/'/g, "\\'")}')" class="btn-primary" style="font-size: 11px; padding: 6px 12px; white-space: nowrap;" title="Edit label">✏️ Label</button>
                                <button onclick="event.stopPropagation(); toggleAutoBump('\${w.address}', \${!w.autoBumpToMinimum})" class="btn-primary" style="font-size: 11px; padding: 6px 12px; white-space: nowrap; background: \${w.autoBumpToMinimum ? 'var(--warning)' : 'var(--bg-lighter)'}; color: \${w.autoBumpToMinimum ? '#000' : 'var(--text)'};" title="\${w.autoBumpToMinimum ? 'Disable 100% execution mode' : 'Enable 100% execution mode (auto-bump to minimum)'}">\${w.autoBumpToMinimum ? '⚡ 100%' : '☐ 100%'}</button>
                                <label class="toggle-switch" onclick="event.stopPropagation();">
                                  <input type="checkbox" \${w.active ? 'checked' : ''} onchange="toggleWalletActive('\${w.address}', this.checked)" />
                                  <span class="toggle-slider"></span>
                                </label>
                                <button onclick="event.stopPropagation(); removeWallet('\${w.address}')" class="btn-danger" style="font-size: 12px; padding: 8px 16px;">Remove</button>
                              </div>
                            </div>
                            <div style="cursor: pointer;" onclick="openWalletDetails('\${w.address}')">
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
                      
                      const displayName = w.label || w.address;
                      const showAddress = w.label ? \`<div style="font-size: 11px; color: var(--text-muted); font-family: monospace; margin-top: 4px;">\${w.address}</div>\` : '';
                      return \`
                        <div class="wallet-card \${w.active ? '' : 'wallet-inactive'}" style="border-left: 4px solid \${w.active ? 'var(--success)' : 'var(--text-muted)'};">
                          <div style="display: flex; align-items: center; gap: 12px; justify-content: space-between; flex-wrap: wrap;">
                            <div style="flex: 1; min-width: 200px; cursor: pointer;" onclick="openWalletDetails('\${w.address}')">
                              <div style="font-size: 16px; font-weight: 600; color: var(--text);">\${displayName}</div>
                              \${showAddress}
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                              <span class="wallet-status-badge \${w.active ? 'active' : 'inactive'}">
                                \${w.active ? '✓ Active' : '○ Inactive'}
                              </span>
                              \${w.autoBumpToMinimum ? '<span style="background: var(--warning); color: #000; padding: 4px 8px; border-radius: 6px; font-size: 10px; font-weight: 600;">⚡ 100% MODE</span>' : ''}
                              <button onclick="event.stopPropagation(); editWalletLabel('\${w.address}', '\${(w.label || '').replace(/'/g, "\\'")}')" class="btn-primary" style="font-size: 11px; padding: 6px 12px; white-space: nowrap;" title="Edit label">✏️ Label</button>
                              <button onclick="event.stopPropagation(); toggleAutoBump('\${w.address}', \${!w.autoBumpToMinimum})" class="btn-primary" style="font-size: 11px; padding: 6px 12px; white-space: nowrap; background: \${w.autoBumpToMinimum ? 'var(--warning)' : 'var(--bg-lighter)'}; color: \${w.autoBumpToMinimum ? '#000' : 'var(--text)'};" title="\${w.autoBumpToMinimum ? 'Disable 100% execution mode' : 'Enable 100% execution mode (auto-bump to minimum)'}">\${w.autoBumpToMinimum ? '⚡ 100%' : '☐ 100%'}</button>
                              <label class="toggle-switch" onclick="event.stopPropagation();">
                                <input type="checkbox" \${w.active ? 'checked' : ''} onchange="toggleWalletActive('\${w.address}', this.checked)" />
                                <span class="toggle-slider"></span>
                              </label>
                              <button onclick="event.stopPropagation(); removeWallet('\${w.address}')" class="btn-danger" style="font-size: 12px; padding: 8px 16px;">Remove</button>
                            </div>
                          </div>
                          <div style="cursor: pointer;" onclick="openWalletDetails('\${w.address}')">
                            <div class="wallet-stats">
                              \${balanceHtml}
                              \${changeHtml}
                              <div class="wallet-stat">Added: \${formatDate(w.addedAt)}</div>
                            </div>
                          </div>
                        </div>
                      \`;
                    } catch (e2) {
                      const displayName = w.label || w.address;
                      const showAddress = w.label ? \`<div style="font-size: 11px; color: var(--text-muted); font-family: monospace; margin-top: 4px;">\${w.address}</div>\` : '';
                      return \`
                        <div class="wallet-card \${w.active ? '' : 'wallet-inactive'}" style="border-left: 4px solid \${w.active ? 'var(--success)' : 'var(--text-muted)'};">
                          <div style="display: flex; align-items: center; gap: 12px; justify-content: space-between; flex-wrap: wrap;">
                            <div style="flex: 1; min-width: 200px; cursor: pointer;" onclick="openWalletDetails('\${w.address}')">
                              <div style="font-size: 16px; font-weight: 600; color: var(--text);">\${displayName}</div>
                              \${showAddress}
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                              <span class="wallet-status-badge \${w.active ? 'active' : 'inactive'}">
                                \${w.active ? '✓ Active' : '○ Inactive'}
                              </span>
                              \${w.autoBumpToMinimum ? '<span style="background: var(--warning); color: #000; padding: 4px 8px; border-radius: 6px; font-size: 10px; font-weight: 600;">⚡ 100% MODE</span>' : ''}
                              <button onclick="event.stopPropagation(); editWalletLabel('\${w.address}', '\${(w.label || '').replace(/'/g, "\\'")}')" class="btn-primary" style="font-size: 11px; padding: 6px 12px; white-space: nowrap;" title="Edit label">✏️ Label</button>
                              <button onclick="event.stopPropagation(); toggleAutoBump('\${w.address}', \${!w.autoBumpToMinimum})" class="btn-primary" style="font-size: 11px; padding: 6px 12px; white-space: nowrap; background: \${w.autoBumpToMinimum ? 'var(--warning)' : 'var(--bg-lighter)'}; color: \${w.autoBumpToMinimum ? '#000' : 'var(--text)'};" title="\${w.autoBumpToMinimum ? 'Disable 100% execution mode' : 'Enable 100% execution mode (auto-bump to minimum)'}">\${w.autoBumpToMinimum ? '⚡ 100%' : '☐ 100%'}</button>
                              <label class="toggle-switch" onclick="event.stopPropagation();">
                                <input type="checkbox" \${w.active ? 'checked' : ''} onchange="toggleWalletActive('\${w.address}', this.checked)" />
                                <span class="toggle-slider"></span>
                              </label>
                              <button onclick="event.stopPropagation(); removeWallet('\${w.address}')" class="btn-danger" style="font-size: 12px; padding: 8px 16px;">Remove</button>
                            </div>
                          </div>
                          <div style="cursor: pointer;" onclick="openWalletDetails('\${w.address}')">
                            <div class="wallet-stats">
                              <div class="wallet-stat">Added: \${formatDate(w.addedAt)}</div>
                            </div>
                          </div>
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
              if (!res.ok) {
                throw new Error('HTTP ' + res.status);
              }
              const data = await res.json();
              if (!data.success) {
                throw new Error(data.error || 'Failed to load trades');
              }
              const container = document.getElementById('tradesContainer');
              if (!container) {
                console.error('Trades container not found');
                return;
              }
              
              if (data.trades && data.trades.length > 0) {
                container.innerHTML = \`
                  <table class="table">
                    <thead>
                      <tr>
                        <th style="width: 30px;"></th>
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
                      \${data.trades.map((t, index) => {
                        const walletLabel = t.walletLabel || '';
                        const walletDisplay = walletLabel 
                          ? \`<div style="font-weight: 600; color: var(--text);">\${walletLabel}</div><div style="font-size: 11px; color: var(--text-muted); font-family: monospace; margin-top: 2px;">\${formatAddress(t.walletAddress)}</div>\`
                          : \`<code>\${formatAddress(t.walletAddress)}</code>\`;
                        const marketName = t.marketName || t.marketId;
                        const marketDisplay = t.marketName && t.marketName !== t.marketId
                          ? \`<div style="font-weight: 500; color: var(--text);">\${marketName}</div><div style="font-size: 11px; color: var(--text-muted); font-family: monospace; margin-top: 2px;">\${formatAddress(t.marketId)}</div>\`
                          : \`<code>\${formatAddress(t.marketId)}</code>\`;
                        return \`
                        <tr id="trade-row-\${index}" class="trade-row" onclick="expandTradeDetails(\${index})">
                          <td><span class="expand-indicator">▶</span></td>
                          <td>\${formatDate(t.timestamp)}</td>
                          <td>\${walletDisplay}</td>
                          <td>\${marketDisplay}</td>
                          <td><span class="badge badge-\${t.outcome.toLowerCase()}">\${t.outcome}</span></td>
                          <td>\${parseFloat(t.amount).toFixed(2)}</td>
                          <td>
                            <span class="badge badge-\${(t.status === 'pending' || (!t.success && t.orderId && !t.transactionHash)) ? 'pending' : (t.success ? 'success' : 'danger')}">
                              \${(t.status === 'pending' || (!t.success && t.orderId && !t.transactionHash)) ? '⏳ Pending' : (t.success ? '✅ Success' : '❌ Failed')}
                            </span>
                          </td>
                          <td>\${t.executionTimeMs}ms</td>
                        </tr>
                        <tr id="trade-details-\${index}" class="trade-details-row">
                          <td colspan="8">
                            <div class="trade-details-content">
                              <div class="trade-details-grid">
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Tracked Wallet</span>
                                  <span class="trade-detail-value">
                                    \${t.walletLabel ? \`<div style="font-weight: 600; margin-bottom: 4px;">\${t.walletLabel}</div>\` : ''}
                                    <div style="font-family: monospace; font-size: 12px;">\${t.walletAddress}</div>
                                  </span>
                                </div>
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Market</span>
                                  <span class="trade-detail-value">
                                    \${t.marketName && t.marketName !== t.marketId ? \`<div style="font-weight: 600; margin-bottom: 4px;">\${t.marketName}</div>\` : ''}
                                    <div style="font-family: monospace; font-size: 12px;">\${t.marketId}</div>
                                  </span>
                                </div>
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Outcome</span>
                                  <span class="trade-detail-value">\${t.outcome}</span>
                                </div>
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Amount (shares)</span>
                                  <span class="trade-detail-value">\${t.amount}</span>
                                  <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
                                    (Original detected amount - bot uses configured trade size)
                                  </div>
                                </div>
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Price</span>
                                  <span class="trade-detail-value">$\${parseFloat(t.price || '0').toFixed(4)}</span>
                                </div>
                                \${t.tokenId ? \`
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Token ID</span>
                                  <span class="trade-detail-value" style="font-size: 11px; word-break: break-all;">\${t.tokenId}</span>
                                </div>
                                \` : ''}
                                \${t.executedAmount ? \`
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Executed Amount</span>
                                  <span class="trade-detail-value">\${t.executedAmount} shares</span>
                                  <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
                                    (Configured trade size used)
                                  </div>
                                </div>
                                \` : ''}
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Execution Time</span>
                                  <span class="trade-detail-value">\${t.executionTimeMs}ms</span>
                                </div>
                                \${t.orderId ? \`
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Order ID</span>
                                  <span class="trade-detail-value">\${t.orderId}</span>
                                </div>
                                \` : ''}
                                \${t.transactionHash ? \`
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Transaction Hash</span>
                                  <span class="trade-detail-value">
                                    <a href="https://polygonscan.com/tx/\${t.transactionHash}" target="_blank" rel="noopener">
                                      \${t.transactionHash.substring(0, 20)}...
                                    </a>
                                  </span>
                                </div>
                                \` : ''}
                                \${t.detectedTxHash ? \`
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Original TX (Tracked Wallet)</span>
                                  <span class="trade-detail-value">
                                    <a href="https://polygonscan.com/tx/\${t.detectedTxHash}" target="_blank" rel="noopener">
                                      \${t.detectedTxHash.substring(0, 20)}...
                                    </a>
                                  </span>
                                </div>
                                \` : ''}
                                <div class="trade-detail-item">
                                  <span class="trade-detail-label">Timestamp</span>
                                  <span class="trade-detail-value">\${new Date(t.timestamp).toISOString()}</span>
                                </div>
                              </div>
                              \${(t.status === 'pending' || (!t.success && t.orderId && !t.transactionHash)) ? \`
                              <div style="margin-top: 12px; padding: 12px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; font-size: 12px; color: var(--warning);">
                                <strong style="display: block; margin-bottom: 4px;">⏳ Pending Limit Order</strong>
                                <div style="font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--text-muted);">\${t.error || 'Order placed on order book and waiting to be matched'}</div>
                                <div style="margin-top: 8px; font-size: 11px; color: var(--text-muted);">
                                  This order will execute when matched with a counterparty, or may expire/cancel if not filled.
                                </div>
                              </div>
                              \` : (!t.success && t.error ? \`
                              <div class="trade-error">
                                <div style="margin-bottom: 8px;">
                                  <strong style="display: block; margin-bottom: 4px;">Error Details:</strong>
                                  <div style="font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word;">\${t.error}</div>
                                </div>
                                <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(239, 68, 68, 0.3);">
                                  <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">Common causes for HTTP 400 errors:</div>
                                  <ul style="font-size: 11px; color: var(--text-muted); margin: 4px 0; padding-left: 20px;">
                                    <li>Invalid tokenId or market closed</li>
                                    <li>Price/size format issues</li>
                                    <li>Insufficient balance</li>
                                    <li>Order validation failed</li>
                                    <li>Check terminal logs for detailed CLOB API response</li>
                                  </ul>
                                </div>
                              </div>
                              \` : '')}
                            </div>
                          </td>
                        </tr>
                      \`}).join('')}
                    </tbody>
                  </table>
                  <div style="font-size: 12px; color: var(--text-muted); margin-top: 12px; text-align: center;">
                    Click on a trade row to expand/collapse details
                  </div>
                \`;
              } else {
                container.innerHTML = '<div class="empty-state">No trades yet. Start the bot and wait for activity!</div>';
              }
            } catch (error) {
              console.error('Failed to load trades:', error);
              const container = document.getElementById('tradesContainer');
              if (container) {
                container.innerHTML = '<div class="empty-state">Error loading trades. Please refresh the page.</div>';
              }
            }
          }

          // Expand/collapse trade details (toggle behavior - stays open until manually closed)
          function expandTradeDetails(tradeId) {
            const row = document.getElementById(\`trade-row-\${tradeId}\`);
            const detailsRow = document.getElementById(\`trade-details-\${tradeId}\`);
            
            if (row && detailsRow) {
              const indicator = row.querySelector('.expand-indicator');
              const isExpanded = detailsRow.classList.contains('show');
              
              if (isExpanded) {
                // Collapse
                row.classList.remove('expanded');
                detailsRow.classList.remove('show');
                if (indicator) {
                  indicator.style.transform = 'rotate(0deg)';
                }
              } else {
                // Expand
                row.classList.add('expanded');
                detailsRow.classList.add('show');
                if (indicator) {
                  indicator.style.transform = 'rotate(90deg)';
                }
              }
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

          // Load failed trades diagnostics
          async function loadFailedTradesDiagnostics() {
            try {
              const res = await fetch('/api/trades/failed?limit=20');
              const data = await res.json();
              const container = document.getElementById('failedTradesAnalysis');
              
              if (data.success && data.trades && data.trades.length > 0) {
                const analysis = data.analysis || {};
                const errorTypeCounts = Object.entries(analysis.errorTypes || {})
                  .map(([type, count]) => \`<span style="display: inline-block; padding: 4px 8px; background: var(--surface); border-radius: 6px; margin: 4px; font-size: 12px;"><strong>\${type}:</strong> \${count}</span>\`)
                  .join('');
                
                container.innerHTML = \`
                  <div style="margin-bottom: 16px;">
                    <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">Total Failed Trades: <strong style="color: var(--danger);">\${analysis.totalFailed || 0}</strong></div>
                    <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">Error Types:</div>
                    <div style="margin-bottom: 16px;">\${errorTypeCounts || 'No error type data'}</div>
                  </div>
                  <div style="padding: 12px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 8px; font-size: 12px; color: var(--text-muted);">
                    <strong style="color: var(--danger); display: block; margin-bottom: 4px;">⚠️ Most Common Issues:</strong>
                    <ul style="margin: 8px 0 0 20px; line-height: 1.6;">
                      <li>Check terminal logs for detailed CLOB API error responses</li>
                      <li>Verify your configured trade size is reasonable (not too large)</li>
                      <li>Ensure Builder API credentials are correctly configured</li>
                      <li>Check wallet balance - insufficient funds cause 400 errors</li>
                      <li>Verify tokenIds are valid and markets are still active</li>
                    </ul>
                  </div>
                \`;
              } else {
                container.innerHTML = '<div class="empty-state">✅ No failed trades to analyze. Great job!</div>';
              }
            } catch (error) {
              console.error('Failed to load failed trades diagnostics:', error);
              document.getElementById('failedTradesAnalysis').innerHTML = 
                '<div class="empty-state">Error loading diagnostics</div>';
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

          // Toggle wallet active status
          async function toggleWalletActive(address, active) {
            try {
              const res = await fetch(\`/api/wallets/\${address}/toggle\`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active })
              });
              const data = await res.json();
              if (data.success) {
                await loadWallets();
                await loadPerformance();
              } else {
                alert('Error: ' + data.error);
                // Revert toggle
                const wallets = await (await fetch('/api/wallets')).json();
                if (wallets.success) {
                  const wallet = wallets.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
                  if (wallet) {
                    document.querySelector(\`input[onchange*="'\${address}'"]\`).checked = wallet.active;
                  }
                }
              }
            } catch (error) {
              console.error('Failed to toggle wallet:', error);
              alert('Failed to toggle wallet status');
            }
          }

          // Toggle auto-bump to minimum (100% execution mode)
          async function toggleAutoBump(address, enabled) {
            try {
              const res = await fetch(\`/api/wallets/\${address}/auto-bump\`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
              });
              const data = await res.json();
              if (data.success) {
                await loadWallets();
                // Show confirmation
                const mode = enabled ? 'ENABLED - Orders will auto-increase to meet market minimum' : 'DISABLED - Orders below minimum will be rejected';
                console.log('100% Execution Mode ' + mode);
              } else {
                alert('Error: ' + data.error);
              }
            } catch (error) {
              console.error('Failed to toggle auto-bump:', error);
              alert('Failed to toggle 100% execution mode');
            }
          }

          // Edit wallet label
          async function editWalletLabel(address, currentLabel) {
            const newLabel = prompt('Enter a label for this wallet (leave empty to remove label):', currentLabel || '');
            
            if (newLabel === null) {
              return; // User cancelled
            }

            try {
              const res = await fetch(\`/api/wallets/\${address}/label\`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: newLabel })
              });
              const data = await res.json();
              if (data.success) {
                await loadWallets();
              } else {
                alert('Error: ' + data.error);
              }
            } catch (error) {
              console.error('Failed to update wallet label:', error);
              alert('Failed to update wallet label');
            }
          }

          // Wallet details modal
          let walletDetailsChart = null;
          let currentWalletAddress = null;

          function openWalletDetails(address) {
            currentWalletAddress = address;
            document.getElementById('walletDetailsModal').classList.add('show');
            loadWalletDetails(address);
          }

          function closeWalletDetailsModal() {
            document.getElementById('walletDetailsModal').classList.remove('show');
            if (walletDetailsChart) {
              walletDetailsChart.destroy();
              walletDetailsChart = null;
            }
            currentWalletAddress = null;
          }

          // Close modals when clicking outside
          window.addEventListener('click', (e) => {
            const walletDetailsModal = document.getElementById('walletDetailsModal');
            if (e.target === walletDetailsModal) {
              closeWalletDetailsModal();
            }
          });

          async function loadWalletDetails(address) {
            const content = document.getElementById('walletDetailsContent');
            content.innerHTML = '<div class="loading">Loading wallet details...</div>';

            try {
              const [statsRes, tradesRes, balanceRes] = await Promise.all([
                fetch(\`/api/wallets/\${address}/stats\`),
                fetch(\`/api/wallets/\${address}/trades?limit=50\`),
                fetch(\`/api/wallets/\${address}/balance\`)
              ]);

              const statsData = await statsRes.json();
              const tradesData = await tradesRes.json();
              const balanceData = await balanceRes.json();

              const stats = statsData.success ? statsData : null;
              const trades = tradesData.success ? tradesData.trades : [];
              const balance = balanceData.success ? balanceData : null;

              const shortAddress = address.substring(0, 6) + '...' + address.substring(address.length - 4);

              let html = \`
                <div style="display: grid; gap: 24px;">
                  <div>
                    <h3 style="margin-bottom: 16px; color: var(--text); font-size: 18px;">Wallet Address</h3>
                    <div style="padding: 12px; background: var(--bg); border-radius: 8px; border: 1px solid var(--border); font-family: monospace; font-size: 14px; word-break: break-all;">
                      \${address}
                    </div>
                  </div>

                  <div>
                    <h3 style="margin-bottom: 16px; color: var(--text); font-size: 18px;">Performance Summary</h3>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
                      <div class="metric-card success" style="padding: 16px;">
                        <h3 style="font-size: 12px; margin-bottom: 8px;">Trades Copied</h3>
                        <div style="font-size: 32px; font-weight: 700;">\${stats ? stats.tradesCopied : 0}</div>
                      </div>
                      <div class="metric-card success" style="padding: 16px;">
                        <h3 style="font-size: 12px; margin-bottom: 8px;">Success Rate</h3>
                        <div style="font-size: 32px; font-weight: 700;">\${stats ? stats.successRate.toFixed(1) : '0'}%</div>
                      </div>
                      <div class="metric-card info" style="padding: 16px;">
                        <h3 style="font-size: 12px; margin-bottom: 8px;">Successful</h3>
                        <div style="font-size: 32px; font-weight: 700;">\${stats ? stats.successfulCopies : 0}</div>
                      </div>
                      <div class="metric-card danger" style="padding: 16px;">
                        <h3 style="font-size: 12px; margin-bottom: 8px;">Failed</h3>
                        <div style="font-size: 32px; font-weight: 700;">\${stats ? stats.failedCopies : 0}</div>
                      </div>
                      <div class="metric-card warning" style="padding: 16px;">
                        <h3 style="font-size: 12px; margin-bottom: 8px;">Avg Latency</h3>
                        <div style="font-size: 32px; font-weight: 700;">\${stats ? stats.averageLatencyMs : 0}ms</div>
                      </div>
                      \${balance ? \`
                        <div class="metric-card info" style="padding: 16px;">
                          <h3 style="font-size: 12px; margin-bottom: 8px;">Balance</h3>
                          <div style="font-size: 32px; font-weight: 700;">\${formatBalance(balance.currentBalance)}</div>
                          <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">USDC</div>
                        </div>
                      \` : ''}
                    </div>
                  </div>

                  <div>
                    <h3 style="margin-bottom: 16px; color: var(--text); font-size: 18px;">Recent Trades</h3>
                    \${trades.length > 0 ? \`
                      <div style="overflow-x: auto;">
                        <table class="table">
                          <thead>
                            <tr>
                              <th>Time</th>
                              <th>Market</th>
                              <th>Outcome</th>
                              <th>Price</th>
                              <th>Status</th>
                              <th>Latency</th>
                            </tr>
                          </thead>
                          <tbody>
                            \${trades.slice(0, 20).map(t => \`
                              <tr>
                                <td>\${formatDate(t.timestamp)}</td>
                                <td><code style="font-size: 11px;">\${formatAddress(t.marketId)}</code></td>
                                <td><span class="badge badge-\${t.outcome.toLowerCase()}">\${t.outcome}</span></td>
                                <td>\${parseFloat(t.price).toFixed(4)}</td>
                                <td>
                                  <span class="badge badge-\${(t.status === 'pending' || (!t.success && t.orderId && !t.transactionHash)) ? 'pending' : (t.success ? 'success' : 'danger')}">
                                    \${(t.status === 'pending' || (!t.success && t.orderId && !t.transactionHash)) ? '⏳ Pending' : (t.success ? '✅ Success' : '❌ Failed')}
                                  </span>
                                </td>
                                <td>\${t.executionTimeMs}ms</td>
                              </tr>
                            \`).join('')}
                          </tbody>
                        </table>
                      </div>
                    \` : '<div class="empty-state">No trades from this wallet yet.</div>'}
                  </div>
                </div>
              \`;

              content.innerHTML = html;
              document.getElementById('walletDetailsTitle').textContent = \`📊 Wallet Details: \${shortAddress}\`;
            } catch (error) {
              console.error('Failed to load wallet details:', error);
              content.innerHTML = '<div class="empty-state">Error loading wallet details</div>';
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
                // Display proxy wallet if available (where funds are), otherwise show EOA
                const displayAddress = data.proxyWalletAddress || data.walletAddress;
                
                // Show both addresses if proxy exists
                if (data.proxyWalletAddress && data.proxyWalletAddress !== data.walletAddress) {
                  walletAddressEl.innerHTML = '<div style="display: flex; flex-direction: column; gap: 4px;">' +
                    '<div style="font-weight: 600;">' + displayAddress + '</div>' +
                    '<div style="font-size: 11px; color: var(--text-muted); font-weight: normal;">EOA: ' + data.walletAddress + '</div>' +
                    '</div>';
                } else {
                  walletAddressEl.textContent = displayAddress;
                }
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
              
              const balanceEl = document.getElementById('userBalance');
              const changeEl = document.getElementById('userBalanceChange');
              
              if (data.success) {
                balanceEl.textContent = formatBalance(data.currentBalance) + ' USDC';
                balanceEl.style.color = 'var(--text)';
                
                if (data.balance24hAgo !== null && data.balance24hAgo !== undefined) {
                  const change = data.change24h;
                  const changeText = formatPercent(change);
                  changeEl.textContent = changeText;
                  changeEl.style.color = change >= 0 ? 'var(--success)' : 'var(--danger)';
                } else {
                  changeEl.textContent = 'No history';
                  changeEl.style.color = 'var(--text-muted)';
                }
              } else {
                // Show error but still display balance if available
                if (data.currentBalance !== undefined) {
                  balanceEl.textContent = formatBalance(data.currentBalance) + ' USDC';
                  balanceEl.style.color = 'var(--warning)';
                } else {
                  balanceEl.textContent = 'Error loading';
                  balanceEl.style.color = 'var(--danger)';
                }
                changeEl.textContent = data.error || 'Error';
                changeEl.style.color = 'var(--danger)';
                console.error('Balance API error:', data.error);
              }
            } catch (error) {
              console.error('Failed to load user balance:', error);
              const balanceEl = document.getElementById('userBalance');
              const changeEl = document.getElementById('userBalanceChange');
              balanceEl.textContent = 'Connection error';
              balanceEl.style.color = 'var(--danger)';
              changeEl.textContent = 'Retry...';
              changeEl.style.color = 'var(--text-muted)';
            }
          }

          // Load trade size configuration
          async function loadTradeSize() {
            try {
              const res = await fetch('/api/config/trade-size');
              const data = await res.json();
              if (data.success) {
                const input = document.getElementById('tradeSizeInput');
                // Only update if user is NOT currently editing this field
                if (input && document.activeElement !== input) {
                  input.value = data.tradeSize || '10';
                }
              }
            } catch (error) {
              console.error('Failed to load trade size:', error);
            }
          }

          // Save trade size configuration
          async function saveTradeSize() {
            const input = document.getElementById('tradeSizeInput');
            const errorDiv = document.getElementById('tradeSizeError');
            const tradeSize = input.value.trim();
            
            // Clear previous errors
            input.classList.remove('error');
            errorDiv.classList.remove('show');
            
            if (!tradeSize) {
              input.classList.add('error');
              errorDiv.textContent = 'Trade size is required';
              errorDiv.classList.add('show');
              return;
            }

            const sizeNum = parseFloat(tradeSize);
            if (isNaN(sizeNum) || sizeNum <= 0) {
              input.classList.add('error');
              errorDiv.textContent = 'Trade size must be a positive number';
              errorDiv.classList.add('show');
              return;
            }

            // Note: Trade size is in USD, not shares. The actual share count will be calculated at execution time.
            // A warning about minimum shares will be shown if the calculated shares < 5 at execution time.

            try {
              const res = await fetch('/api/config/trade-size', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tradeSize })
              });
              
              const data = await res.json();
              if (data.success) {
                // Show success feedback
                errorDiv.textContent = '✓ Trade size saved!';
                errorDiv.style.color = 'var(--success)';
                errorDiv.classList.add('show');
                setTimeout(() => {
                  errorDiv.classList.remove('show');
                  errorDiv.style.color = '';
                }, 2000);
              } else {
                input.classList.add('error');
                errorDiv.textContent = data.error || 'Failed to save trade size';
                errorDiv.style.color = '';
                errorDiv.classList.add('show');
              }
            } catch (error) {
              input.classList.add('error');
              errorDiv.textContent = 'Failed to save trade size';
              errorDiv.classList.add('show');
              console.error('Failed to save trade size:', error);
            }
          }

          // Load position threshold configuration
          async function loadPositionThreshold() {
            try {
              const res = await fetch('/api/config/position-threshold');
              const data = await res.json();
              if (data.success) {
                const checkbox = document.getElementById('thresholdEnabled');
                const input = document.getElementById('thresholdPercent');
                const statusEl = document.getElementById('thresholdStatus');
                
                if (checkbox) checkbox.checked = data.enabled;
                // Only update if user is NOT currently editing this field
                if (input && document.activeElement !== input) {
                  input.value = data.percent || 10;
                }
                
                // Update status display
                if (statusEl) {
                  if (data.enabled) {
                    statusEl.innerHTML = '<span style="color: var(--success);">✓ Enabled</span> - Filtering trades below ' + data.percent + '% of wallet balance';
                  } else {
                    statusEl.innerHTML = '<span style="color: var(--text-muted);">○ Disabled</span> - All trades will be copied';
                  }
                }
              }
            } catch (error) {
              console.error('Failed to load position threshold:', error);
            }
          }

          // Toggle position threshold enabled/disabled
          async function toggleThreshold() {
            const checkbox = document.getElementById('thresholdEnabled');
            const input = document.getElementById('thresholdPercent');
            const errorDiv = document.getElementById('thresholdError');
            const statusEl = document.getElementById('thresholdStatus');
            
            const enabled = checkbox.checked;
            const percent = parseFloat(input.value) || 10;
            
            try {
              const res = await fetch('/api/config/position-threshold', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, percent })
              });
              
              const data = await res.json();
              if (data.success) {
                // Update status display
                if (statusEl) {
                  if (enabled) {
                    statusEl.innerHTML = '<span style="color: var(--success);">✓ Enabled</span> - Filtering trades below ' + percent + '% of wallet balance';
                  } else {
                    statusEl.innerHTML = '<span style="color: var(--text-muted);">○ Disabled</span> - All trades will be copied';
                  }
                }
              } else {
                // Revert checkbox on error
                checkbox.checked = !enabled;
                errorDiv.textContent = data.error || 'Failed to toggle threshold';
                errorDiv.classList.add('show');
                setTimeout(() => errorDiv.classList.remove('show'), 3000);
              }
            } catch (error) {
              checkbox.checked = !enabled;
              console.error('Failed to toggle threshold:', error);
            }
          }

          // Save position threshold percentage
          async function saveThreshold() {
            const checkbox = document.getElementById('thresholdEnabled');
            const input = document.getElementById('thresholdPercent');
            const errorDiv = document.getElementById('thresholdError');
            const statusEl = document.getElementById('thresholdStatus');
            
            const enabled = checkbox.checked;
            const percentStr = input.value.trim();
            
            // Clear previous errors
            input.classList.remove('error');
            errorDiv.classList.remove('show');
            
            const percent = parseFloat(percentStr);
            if (isNaN(percent) || percent < 0.1 || percent > 100) {
              input.classList.add('error');
              errorDiv.textContent = 'Threshold must be between 0.1% and 100%';
              errorDiv.classList.add('show');
              return;
            }
            
            try {
              const res = await fetch('/api/config/position-threshold', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, percent })
              });
              
              const data = await res.json();
              if (data.success) {
                errorDiv.textContent = '✓ Threshold saved!';
                errorDiv.style.color = 'var(--success)';
                errorDiv.classList.add('show');
                setTimeout(() => {
                  errorDiv.classList.remove('show');
                  errorDiv.style.color = '';
                }, 2000);
                
                // Update status display
                if (statusEl) {
                  if (enabled) {
                    statusEl.innerHTML = '<span style="color: var(--success);">✓ Enabled</span> - Filtering trades below ' + percent + '% of wallet balance';
                  } else {
                    statusEl.innerHTML = '<span style="color: var(--text-muted);">○ Disabled</span> - All trades will be copied';
                  }
                }
              } else {
                input.classList.add('error');
                errorDiv.textContent = data.error || 'Failed to save threshold';
                errorDiv.style.color = '';
                errorDiv.classList.add('show');
              }
            } catch (error) {
              input.classList.add('error');
              errorDiv.textContent = 'Failed to save threshold';
              errorDiv.classList.add('show');
              console.error('Failed to save threshold:', error);
            }
          }

          // Load monitoring interval
          async function loadMonitoringInterval() {
            try {
              const res = await fetch('/api/config/monitoring-interval');
              const data = await res.json();
              if (data.success) {
                const input = document.getElementById('monitoringIntervalInput');
                // Only update if user is NOT currently editing this field
                if (input && document.activeElement !== input) {
                  input.value = data.intervalSeconds || '5';
                }
              }
            } catch (error) {
              console.error('Failed to load monitoring interval:', error);
            }
          }

          // Save monitoring interval
          async function saveMonitoringInterval() {
            const input = document.getElementById('monitoringIntervalInput');
            const errorDiv = document.getElementById('monitoringIntervalError');
            const intervalSeconds = input.value.trim();
            
            // Clear previous errors
            input.classList.remove('error');
            errorDiv.classList.remove('show');
            
            if (!intervalSeconds) {
              input.classList.add('error');
              errorDiv.textContent = 'Interval is required';
              errorDiv.classList.add('show');
              return;
            }

            const intervalNum = parseFloat(intervalSeconds);
            if (isNaN(intervalNum) || intervalNum < 1) {
              input.classList.add('error');
              errorDiv.textContent = 'Interval must be at least 1 second';
              errorDiv.classList.add('show');
              return;
            }

            if (intervalNum > 300) {
              input.classList.add('error');
              errorDiv.textContent = 'Interval must be at most 300 seconds';
              errorDiv.classList.add('show');
              return;
            }

            try {
              const res = await fetch('/api/config/monitoring-interval', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ intervalSeconds: intervalNum })
              });
              
              const data = await res.json();
              if (data.success) {
                // Show success feedback
                errorDiv.textContent = '✓ Interval saved!';
                errorDiv.style.color = 'var(--success)';
                errorDiv.classList.add('show');
                setTimeout(() => {
                  errorDiv.classList.remove('show');
                  errorDiv.style.color = '';
                }, 2000);
              } else {
                input.classList.add('error');
                errorDiv.textContent = data.error || 'Failed to save interval';
                errorDiv.classList.add('show');
              }
            } catch (error) {
              input.classList.add('error');
              errorDiv.textContent = 'Failed to save interval';
              errorDiv.classList.add('show');
              console.error('Failed to save monitoring interval:', error);
            }
          }

          // Save private key
          async function savePrivateKey() {
            const input = document.getElementById('privateKeyInput');
            const errorDiv = document.getElementById('privateKeyError');
            const privateKey = input.value.trim();
            
            // Clear previous errors
            input.classList.remove('error');
            errorDiv.classList.remove('show');
            
            if (!privateKey) {
              input.classList.add('error');
              errorDiv.textContent = 'Private key is required';
              errorDiv.classList.add('show');
              return;
            }

            // Validate format
            if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
              input.classList.add('error');
              errorDiv.textContent = 'Invalid private key format (must be 0x followed by 64 hex characters)';
              errorDiv.classList.add('show');
              return;
            }

            if (!confirm('⚠️ WARNING: This will update your private key. The bot will need to be restarted for changes to take effect. Continue?')) {
              return;
            }

            try {
              const res = await fetch('/api/config/private-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ privateKey })
              });
              
              const data = await res.json();
              if (data.success) {
                // Show success feedback
                errorDiv.textContent = '✓ Private key saved! Bot restart required.';
                errorDiv.style.color = 'var(--success)';
                errorDiv.classList.add('show');
                input.value = ''; // Clear for security
                setTimeout(() => {
                  errorDiv.classList.remove('show');
                  errorDiv.style.color = '';
                }, 5000);
              } else {
                input.classList.add('error');
                errorDiv.textContent = data.error || 'Failed to save private key';
                errorDiv.classList.add('show');
              }
            } catch (error) {
              input.classList.add('error');
              errorDiv.textContent = 'Failed to save private key';
              errorDiv.classList.add('show');
              console.error('Failed to save private key:', error);
            }
          }

          // Save builder credentials
          async function saveBuilderCredentials() {
            const apiKeyInput = document.getElementById('builderApiKeyInput');
            const secretInput = document.getElementById('builderSecretInput');
            const passphraseInput = document.getElementById('builderPassphraseInput');
            const errorDiv = document.getElementById('builderCredentialsError');
            
            const apiKey = apiKeyInput.value.trim();
            const secret = secretInput.value.trim();
            const passphrase = passphraseInput.value.trim();
            
            // Clear previous errors
            apiKeyInput.classList.remove('error');
            secretInput.classList.remove('error');
            passphraseInput.classList.remove('error');
            errorDiv.classList.remove('show');
            
            if (!apiKey) {
              apiKeyInput.classList.add('error');
              errorDiv.textContent = 'Builder API Key is required';
              errorDiv.classList.add('show');
              return;
            }

            if (!secret) {
              secretInput.classList.add('error');
              errorDiv.textContent = 'Builder API Secret is required';
              errorDiv.classList.add('show');
              return;
            }

            if (!passphrase) {
              passphraseInput.classList.add('error');
              errorDiv.textContent = 'Builder API Passphrase is required';
              errorDiv.classList.add('show');
              return;
            }

            try {
              const res = await fetch('/api/config/builder-credentials', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey, secret, passphrase })
              });
              
              const data = await res.json();
              if (data.success) {
                // Show success feedback
                errorDiv.textContent = '✓ Builder credentials saved!';
                errorDiv.style.color = 'var(--success)';
                errorDiv.classList.add('show');
                // Clear passwords for security
                secretInput.value = '';
                passphraseInput.value = '';
                setTimeout(() => {
                  errorDiv.classList.remove('show');
                  errorDiv.style.color = '';
                }, 3000);
              } else {
                errorDiv.textContent = data.error || 'Failed to save credentials';
                errorDiv.classList.add('show');
              }
            } catch (error) {
              errorDiv.textContent = 'Failed to save credentials';
              errorDiv.classList.add('show');
              console.error('Failed to save builder credentials:', error);
            }
          }

          // Auto-refresh function
          async function refreshAll() {
            // Run all loads in parallel with individual error handling
            // This ensures one failure doesn't block others
            Promise.allSettled([
              loadStatus().catch(e => console.error('loadStatus error:', e)),
              loadWalletConfig().catch(e => console.error('loadWalletConfig error:', e)),
              loadPerformance().catch(e => console.error('loadPerformance error:', e)),
              loadWallets().catch(e => console.error('loadWallets error:', e)),
              loadTrades().catch(e => console.error('loadTrades error:', e)),
              loadIssues().catch(e => console.error('loadIssues error:', e)),
              loadTradeSize().catch(e => console.error('loadTradeSize error:', e)),
              loadPositionThreshold().catch(e => console.error('loadPositionThreshold error:', e)),
              loadMonitoringInterval().catch(e => console.error('loadMonitoringInterval error:', e)),
              loadFailedTradesDiagnostics().catch(e => console.error('loadFailedTradesDiagnostics error:', e))
            ]);
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

            // Trade size input - allow Enter key to save
            const tradeSizeInput = document.getElementById('tradeSizeInput');
            if (tradeSizeInput) {
              tradeSizeInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                  saveTradeSize();
                }
              });
            }

            // Monitoring interval input - allow Enter key to save
            const monitoringIntervalInput = document.getElementById('monitoringIntervalInput');
            if (monitoringIntervalInput) {
              monitoringIntervalInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                  saveMonitoringInterval();
                }
              });
            }

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
    const host = process.env.HOST || '0.0.0.0'; // Listen on all interfaces for Railway/cloud
    const server = app.listen(config.port, host, () => {
      console.log(`\n🚀 Server running on http://${host}:${config.port}`);
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
