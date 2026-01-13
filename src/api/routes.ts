import { Router, Request, Response } from 'express';
import { Storage } from '../storage.js';
import { CopyTrader } from '../copyTrader.js';
import { config } from '../config.js';

/**
 * API routes for managing the bot
 */
export function createRoutes(copyTrader: CopyTrader): Router {
  const router = Router();
  const performanceTracker = copyTrader.getPerformanceTracker();

  // Get all tracked wallets
  router.get('/wallets', async (req: Request, res: Response) => {
    try {
      const wallets = await Storage.loadTrackedWallets();
      res.json({ success: true, wallets });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Add a wallet to track
  router.post('/wallets', async (req: Request, res: Response) => {
    try {
      const { address } = req.body;
      
      if (!address || typeof address !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Wallet address is required' 
        });
      }

      // Basic address validation
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid wallet address format' 
        });
      }

      await Storage.addWallet(address);
      
      // Reload wallets in the monitor so the new wallet is tracked immediately
      await copyTrader.reloadWallets();
      
      // Return the updated wallet list so the UI can update immediately
      const wallets = await Storage.loadTrackedWallets();
      const addedWallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
      
      res.json({ 
        success: true, 
        message: 'Wallet added successfully',
        wallet: addedWallet,
        wallets: wallets
      });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Remove a wallet from tracking
  router.delete('/wallets/:address', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      await Storage.removeWallet(address);
      
      // Reload wallets in the monitor to remove the wallet from monitoring
      await copyTrader.reloadWallets();
      
      res.json({ success: true, message: 'Wallet removed successfully' });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Get bot status
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const status = copyTrader.getStatus();
      const wallets = await Storage.getActiveWallets();
      const stats = await performanceTracker.getStats(wallets.length);
      const recentTrades = performanceTracker.getRecentTrades(1);
      const issues = performanceTracker.getIssues(false, 100);
      const unresolvedIssues = issues.filter(i => !i.resolved);
      
      // Get last detected/executed trade
      const lastExecutedTrade = recentTrades.find(t => t.success) || null;
      const lastDetectedTrade = recentTrades.length > 0 ? recentTrades[0] : null;
      
      res.json({ 
        success: true, 
        running: status.running,
        executedTradesCount: status.executedTradesCount,
        websocket: {
          connected: status.websocketStatus.isConnected,
          monitoring: status.websocketStatus.isMonitoring,
          lastConnectionTime: status.websocketStatus.lastConnectionTime,
          trackedWalletsCount: status.websocketStatus.trackedWalletsCount
        },
        polling: {
          active: status.running,
          interval: config.monitoringIntervalMs
        },
        monitoringMethods: {
          primary: status.websocketStatus.isConnected ? 'websocket' : 'polling',
          websocket: status.websocketStatus.isConnected,
          polling: status.running
        },
        wallets: {
          active: wallets.filter(w => w.active).length,
          total: wallets.length,
          addresses: wallets.map(w => ({
            address: w.address,
            active: w.active,
            addedAt: w.addedAt
          }))
        },
        trades: {
          total: stats.totalTrades,
          successful: stats.successfulTrades,
          failed: stats.failedTrades,
          successRate: stats.successRate,
          lastDetected: lastDetectedTrade ? {
            timestamp: lastDetectedTrade.timestamp,
            marketId: lastDetectedTrade.marketId,
            outcome: lastDetectedTrade.outcome,
            walletAddress: lastDetectedTrade.walletAddress
          } : null,
          lastExecuted: lastExecutedTrade ? {
            timestamp: lastExecutedTrade.timestamp,
            marketId: lastExecutedTrade.marketId,
            outcome: lastExecutedTrade.outcome,
            success: lastExecutedTrade.success,
            orderId: lastExecutedTrade.orderId
          } : null
        },
        performance: {
          averageLatencyMs: stats.averageLatencyMs,
          uptimeMs: stats.uptimeMs,
          tradesLast24h: stats.tradesLast24h,
          tradesLastHour: stats.tradesLastHour
        },
        errors: {
          total: unresolvedIssues.length,
          recent: unresolvedIssues.slice(0, 10).map(i => ({
            severity: i.severity,
            category: i.category,
            message: i.message,
            timestamp: i.timestamp
          }))
        }
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get performance statistics
  router.get('/performance', async (req: Request, res: Response) => {
    try {
      const wallets = await Storage.getActiveWallets();
      const stats = await performanceTracker.getStats(wallets.length);
      res.json({ success: true, ...stats });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get recent trades
  router.get('/trades', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      
      // Step 1: Get trades first (core data - always return this even if enrichment fails)
      const trades = performanceTracker.getRecentTrades(limit);
      
      // Step 2: Load wallets for labels (safe, local operation)
      let walletLabelMap = new Map<string, string>();
      try {
        const wallets = await Storage.loadTrackedWallets();
        walletLabelMap = new Map(
          wallets.map(w => [w.address.toLowerCase(), w.label || ''])
        );
      } catch (error: any) {
        // If wallet lookup fails, use empty map (no labels shown)
        console.warn('[API] Failed to load wallet labels for trades:', error.message);
      }
      
      // Step 3: Enrich trades with labels (safe, synchronous)
      trades.forEach(t => {
        (t as any).walletLabel = walletLabelMap.get(t.walletAddress.toLowerCase()) || '';
      });
      
      // Step 4: Enrich trades with market names
      // NOTE: Market name fetching is disabled to prevent blocking
      // For now, we just use marketId - market names can be added later with a better caching strategy
      trades.forEach(t => {
        (t as any).marketName = t.marketId;
      });
      
      // Step 5: Return enriched trades
      res.json({ success: true, trades });
    } catch (error: any) {
      // Even if enrichment fails completely, try to return basic trades
      try {
        const limit = parseInt((req.query.limit as string) || '50');
        const trades = performanceTracker.getRecentTrades(limit);
        // Add empty labels/names if enrichment failed
        trades.forEach(t => {
          (t as any).walletLabel = '';
          (t as any).marketName = t.marketId;
        });
        res.json({ success: true, trades });
      } catch (fallbackError: any) {
        res.status(500).json({ success: false, error: error.message });
      }
    }
  });

  // Get failed trades diagnostics
  router.get('/trades/failed', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const allTrades = performanceTracker.getRecentTrades(limit * 2); // Get more to filter
      const failedTrades = allTrades
        .filter(t => !t.success)
        .slice(0, limit)
        .map(t => ({
          ...t,
          is400Error: t.error?.includes('HTTP 400') || t.error?.includes('HTTP error 400'),
          errorType: t.error?.includes('HTTP 400') ? 'CLOB API Rejection' : 
                     t.error?.includes('HTTP 403') ? 'Cloudflare Block' :
                     t.error?.includes('HTTP 401') ? 'Authentication Failed' :
                     t.error?.includes('HTTP 429') ? 'Rate Limited' :
                     'Other Error'
        }));
      
      // Analyze common patterns
      const analysis = {
        totalFailed: failedTrades.length,
        errorTypes: {} as Record<string, number>,
        commonMarkets: {} as Record<string, number>,
        commonTokenIds: {} as Record<string, number>
      };
      
      failedTrades.forEach(t => {
        analysis.errorTypes[t.errorType] = (analysis.errorTypes[t.errorType] || 0) + 1;
        analysis.commonMarkets[t.marketId] = (analysis.commonMarkets[t.marketId] || 0) + 1;
        if (t.tokenId) {
          analysis.commonTokenIds[t.tokenId] = (analysis.commonTokenIds[t.tokenId] || 0) + 1;
        }
      });
      
      res.json({ 
        success: true, 
        trades: failedTrades,
        analysis
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get wallet-specific stats
  router.get('/wallets/:address/stats', (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const stats = performanceTracker.getWalletStats(address);
      res.json({ success: true, ...stats });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get system issues
  router.get('/issues', (req: Request, res: Response) => {
    try {
      const resolved = req.query.resolved === 'true';
      const limit = parseInt(req.query.limit as string) || 50;
      const issues = performanceTracker.getIssues(resolved, limit);
      res.json({ success: true, issues });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Resolve an issue
  router.post('/issues/:id/resolve', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await performanceTracker.resolveIssue(id);
      res.json({ success: true, message: 'Issue resolved' });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Start the bot
  router.post('/start', async (req: Request, res: Response) => {
    try {
      await copyTrader.start();
      res.json({ success: true, message: 'Bot started' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Stop the bot
  router.post('/stop', (req: Request, res: Response) => {
    try {
      copyTrader.stop();
      res.json({ success: true, message: 'Bot stopped' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get performance data for charting
  router.get('/performance/data', (req: Request, res: Response) => {
    try {
      const initialBalance = parseFloat(req.query.initialBalance as string) || 1000;
      const dataPoints = performanceTracker.getPerformanceData(initialBalance);
      res.json({ success: true, dataPoints });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get wallet configuration (address used for executing trades)
  router.get('/wallet', async (req: Request, res: Response) => {
    try {
      const eoaAddress = copyTrader.getWalletAddress();
      const proxyWalletAddress = eoaAddress ? await copyTrader.getProxyWalletAddress() : null;
      
      res.json({ 
        success: true, 
        walletAddress: eoaAddress || null,
        proxyWalletAddress: proxyWalletAddress,
        configured: !!eoaAddress
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get user wallet balance with 24h change
  router.get('/wallet/balance', async (req: Request, res: Response) => {
    try {
      const eoaAddress = copyTrader.getWalletAddress();
      console.log(`[API] /wallet/balance requested. EOA address: ${eoaAddress || 'NOT SET'}`);
      
      if (!eoaAddress) {
        console.log('[API] No wallet address configured, returning 0 balance');
        return res.json({ 
          success: true, 
          currentBalance: 0,
          change24h: 0,
          balance24hAgo: null,
          walletAddress: null,
          proxyWalletAddress: null
        });
      }

      // Get proxy wallet address (where funds are actually held on Polymarket)
      console.log(`[API] Fetching proxy wallet address for EOA: ${eoaAddress}...`);
      const proxyWalletAddress = await copyTrader.getProxyWalletAddress();
      const balanceAddress = proxyWalletAddress || eoaAddress; // Use proxy if available, otherwise use EOA
      
      console.log(`[API] ===== Balance Check Info =====`);
      console.log(`[API] EOA Address: ${eoaAddress}`);
      console.log(`[API] Proxy Wallet: ${proxyWalletAddress || 'NOT FOUND'}`);
      console.log(`[API] Will check balance for: ${balanceAddress}`);
      console.log(`[API] ==============================`);

      const balanceTracker = copyTrader.getBalanceTracker();
      
      // Ensure balance tracker is initialized
      try {
        // This will initialize if needed
        await balanceTracker.getBalance(balanceAddress);
      } catch (initError: any) {
        console.error('[API] Balance tracker initialization error:', initError);
        // Continue anyway - getBalanceWithChange will try to initialize again
      }
      
      console.log(`[API] Fetching balance for wallet: ${balanceAddress}`);
      const balanceData = await balanceTracker.getBalanceWithChange(balanceAddress);
      console.log(`[API] Balance fetched: ${balanceData.currentBalance} USDC`);
      
      res.json({ 
        success: true, 
        ...balanceData,
        walletAddress: eoaAddress, // Return EOA for display
        proxyWalletAddress: proxyWalletAddress, // Return proxy for reference
        balanceCheckedFor: balanceAddress // Show which address we checked
      });
    } catch (error: any) {
      console.error('[API] Error fetching wallet balance:', error);
      console.error('[API] Error stack:', error.stack);
      // Return error but still provide a response so UI can show error state
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to fetch balance',
        currentBalance: 0,
        change24h: 0,
        balance24hAgo: null
      });
    }
  });

  // Get user wallet balance history for charting
  router.get('/wallet/balance-history', async (req: Request, res: Response) => {
    try {
      const eoaAddress = copyTrader.getWalletAddress();
      
      if (!eoaAddress) {
        return res.json({ 
          success: true, 
          dataPoints: [],
          walletAddress: null
        });
      }

      // Get proxy wallet address (where funds are actually held on Polymarket)
      const proxyWalletAddress = await copyTrader.getProxyWalletAddress();
      const balanceAddress = proxyWalletAddress || eoaAddress;

      const balanceTracker = copyTrader.getBalanceTracker();
      const history = balanceTracker.getBalanceHistory(balanceAddress);
      
      // Also get current balance to add as latest point
      let currentBalance = 0;
      try {
        currentBalance = await balanceTracker.getBalance(balanceAddress);
      } catch (e) {
        // Use last known balance if we can't fetch current
        if (history.length > 0) {
          currentBalance = history[history.length - 1].balance;
        }
      }
      
      // Add current balance as the latest data point if history exists
      const dataPoints = history.map(h => ({
        timestamp: h.timestamp.toISOString(),
        balance: h.balance
      }));
      
      // Add current point if different from last
      if (dataPoints.length === 0 || 
          new Date(dataPoints[dataPoints.length - 1].timestamp).getTime() < Date.now() - 60000) {
        dataPoints.push({
          timestamp: new Date().toISOString(),
          balance: currentBalance
        });
      }
      
      res.json({ 
        success: true, 
        dataPoints,
        walletAddress: eoaAddress,
        proxyWalletAddress,
        currentBalance
      });
    } catch (error: any) {
      console.error('[API] Error fetching balance history:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to fetch balance history',
        dataPoints: []
      });
    }
  });

  // Get tracked wallet balance with 24h change
  router.get('/wallets/:address/balance', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const balanceTracker = copyTrader.getBalanceTracker();
      const balanceData = await balanceTracker.getBalanceWithChange(address);
      
      res.json({ 
        success: true, 
        ...balanceData
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Toggle wallet active status (enable/disable copy trading)
  router.patch('/wallets/:address/toggle', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { active } = req.body;
      
      const wallet = await Storage.toggleWalletActive(address, active);
      await copyTrader.reloadWallets();
      
      res.json({ 
        success: true, 
        message: wallet.active ? 'Wallet copy trading enabled' : 'Wallet copy trading disabled',
        wallet 
      });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Update wallet label
  router.patch('/wallets/:address/label', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { label } = req.body;
      
      if (typeof label !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Label must be a string' 
        });
      }

      const wallet = await Storage.updateWalletLabel(address, label);
      
      res.json({ 
        success: true, 
        message: 'Wallet label updated',
        wallet 
      });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Toggle wallet autoBumpToMinimum setting (high-value wallet mode)
  // When enabled, orders will automatically increase to meet market minimum size for 100% success rate
  router.patch('/wallets/:address/auto-bump', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { enabled } = req.body;
      
      const wallet = await Storage.toggleAutoBumpToMinimum(address, enabled);
      await copyTrader.reloadWallets();
      
      res.json({ 
        success: true, 
        message: wallet.autoBumpToMinimum 
          ? 'Auto-bump to minimum ENABLED - This wallet will auto-increase order sizes to meet market minimum for 100% success rate' 
          : 'Auto-bump to minimum DISABLED - Orders below market minimum will be rejected',
        wallet 
      });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Get wallet positions
  router.get('/wallets/:address/positions', async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const api = copyTrader.getPolymarketApi();
      const positions = await api.getUserPositions(address);
      res.json({ success: true, positions: positions || [] });
    } catch (error: any) {
      console.error(`Failed to load positions for ${address}:`, error.message);
      res.json({ success: true, positions: [], error: error.message });
    }
  });

  // Get wallet-specific trades
  router.get('/wallets/:address/trades', (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const limit = parseInt(req.query.limit as string) || 100;
      const allTrades = performanceTracker.getRecentTrades(limit);
      const walletTrades = allTrades.filter(t => 
        t.walletAddress.toLowerCase() === address.toLowerCase()
      );
      res.json({ success: true, trades: walletTrades });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get trade size configuration (in USDC)
  router.get('/config/trade-size', async (req: Request, res: Response) => {
    try {
      const tradeSize = await Storage.getTradeSize();
      res.json({ success: true, tradeSize, unit: 'USDC' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set trade size configuration (in USDC)
  router.post('/config/trade-size', async (req: Request, res: Response) => {
    try {
      const { tradeSize } = req.body;
      
      if (!tradeSize || typeof tradeSize !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Trade size is required (in USDC)' 
        });
      }

      // Validate that it's a valid number
      // Note: tradeSize is in USD, not shares. Share count will be calculated at execution time.
      const sizeNum = parseFloat(tradeSize);
      if (isNaN(sizeNum) || sizeNum <= 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Trade size must be a positive number (in USDC)' 
        });
      }

      await Storage.setTradeSize(tradeSize);
      res.json({ success: true, message: 'Trade size updated', tradeSize, unit: 'USDC' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get monitoring interval configuration
  router.get('/config/monitoring-interval', async (req: Request, res: Response) => {
    try {
      const intervalMs = await Storage.getMonitoringInterval();
      res.json({ success: true, intervalMs, intervalSeconds: intervalMs / 1000 });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set monitoring interval configuration
  router.post('/config/monitoring-interval', async (req: Request, res: Response) => {
    try {
      const { intervalSeconds } = req.body;
      
      if (intervalSeconds === undefined || intervalSeconds === null) {
        return res.status(400).json({ 
          success: false, 
          error: 'Interval in seconds is required' 
        });
      }

      const intervalNum = parseFloat(intervalSeconds);
      if (isNaN(intervalNum) || intervalNum < 1) {
        return res.status(400).json({ 
          success: false, 
          error: 'Interval must be at least 1 second' 
        });
      }

      if (intervalNum > 300) {
        return res.status(400).json({ 
          success: false, 
          error: 'Interval must be at most 300 seconds (5 minutes)' 
        });
      }

      const intervalMs = Math.round(intervalNum * 1000);
      
      // Update in storage
      await Storage.setMonitoringInterval(intervalMs);
      
      // Update in running bot if active
      try {
        await copyTrader.updateMonitoringInterval(intervalMs);
      } catch (error: any) {
        // Bot might not be running, that's okay
        console.log('[API] Bot not running, interval will apply on next start');
      }
      
      res.json({ 
        success: true, 
        message: 'Monitoring interval updated', 
        intervalMs, 
        intervalSeconds: intervalNum 
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get current configuration status (without exposing sensitive values)
  router.get('/config/status', async (req: Request, res: Response) => {
    try {
      res.json({
        success: true,
        configured: {
          privateKey: !!config.privateKey,
          builderApiKey: !!config.polymarketBuilderApiKey,
          builderSecret: !!config.polymarketBuilderSecret,
          builderPassphrase: !!config.polymarketBuilderPassphrase
        },
        monitoringInterval: config.monitoringIntervalMs
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Update private key (WARNING: This writes to .env file)
  router.post('/config/private-key', async (req: Request, res: Response) => {
    try {
      const { privateKey } = req.body;
      
      if (!privateKey || typeof privateKey !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Private key is required' 
        });
      }

      // Validate private key format
      if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid private key format (must be 0x followed by 64 hex characters)' 
        });
      }

      // Update .env file
      const fs = await import('fs/promises');
      const path = await import('path');
      const envPath = path.join(process.cwd(), '.env');
      
      let envContent = '';
      try {
        envContent = await fs.readFile(envPath, 'utf-8');
      } catch {
        // .env doesn't exist, create it
        envContent = '';
      }

      // Update or add PRIVATE_KEY
      const lines = envContent.split('\n');
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('PRIVATE_KEY=')) {
          lines[i] = `PRIVATE_KEY=${privateKey}`;
          found = true;
          break;
        }
      }
      if (!found) {
        lines.push(`PRIVATE_KEY=${privateKey}`);
      }

      await fs.writeFile(envPath, lines.join('\n'));
      
      // Update in-memory config
      config.privateKey = privateKey;
      
      res.json({ success: true, message: 'Private key updated. Bot restart required.' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Update builder API credentials (WARNING: This writes to .env file)
  router.post('/config/builder-credentials', async (req: Request, res: Response) => {
    try {
      const { apiKey, secret, passphrase } = req.body;
      
      if (!apiKey || typeof apiKey !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Builder API Key is required' 
        });
      }

      if (!secret || typeof secret !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Builder API Secret is required' 
        });
      }

      if (!passphrase || typeof passphrase !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Builder API Passphrase is required' 
        });
      }

      // Update .env file
      const fs = await import('fs/promises');
      const path = await import('path');
      const envPath = path.join(process.cwd(), '.env');
      
      let envContent = '';
      try {
        envContent = await fs.readFile(envPath, 'utf-8');
      } catch {
        // .env doesn't exist, create it
        envContent = '';
      }

      // Update or add Builder credentials
      const lines = envContent.split('\n');
      const updates = {
        'POLYMARKET_BUILDER_API_KEY': apiKey,
        'POLYMARKET_BUILDER_SECRET': secret,
        'POLYMARKET_BUILDER_PASSPHRASE': passphrase
      };

      for (const [key, value] of Object.entries(updates)) {
        let found = false;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith(`${key}=`)) {
            lines[i] = `${key}=${value}`;
            found = true;
            break;
          }
        }
        if (!found) {
          lines.push(`${key}=${value}`);
        }
      }

      await fs.writeFile(envPath, lines.join('\n'));
      
      // Update in-memory config
      config.polymarketBuilderApiKey = apiKey;
      config.polymarketBuilderSecret = secret;
      config.polymarketBuilderPassphrase = passphrase;
      
      res.json({ success: true, message: 'Builder credentials updated. Bot restart recommended.' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test endpoint to diagnose CLOB API connectivity and Cloudflare blocking
  router.get('/test/clob-connectivity', async (req: Request, res: Response) => {
    try {
      const axios = (await import('axios')).default;
      const results: any = {
        timestamp: new Date().toISOString(),
        tests: []
      };
      
      // Test 1: Simple unauthenticated request to CLOB API (tick-size endpoint)
      const clobUrl = config.polymarketClobApiUrl || 'https://clob.polymarket.com';
      try {
        const tickSizeResponse = await axios.get(`${clobUrl}/tick-size`, { 
          timeout: 10000,
          validateStatus: () => true // Don't throw on any status code
        });
        results.tests.push({
          name: 'CLOB tick-size endpoint (unauthenticated)',
          url: `${clobUrl}/tick-size`,
          status: tickSizeResponse.status,
          statusText: tickSizeResponse.statusText,
          isCloudflareBlock: typeof tickSizeResponse.data === 'string' && tickSizeResponse.data.includes('Cloudflare'),
          success: tickSizeResponse.status === 200
        });
      } catch (e: any) {
        results.tests.push({
          name: 'CLOB tick-size endpoint (unauthenticated)',
          error: e.message,
          success: false
        });
      }

      // Test 2: Check if we can reach the CLOB server endpoint at all
      try {
        const serverTimeResponse = await axios.get(`${clobUrl}/time`, { 
          timeout: 10000,
          validateStatus: () => true
        });
        results.tests.push({
          name: 'CLOB time endpoint',
          url: `${clobUrl}/time`,
          status: serverTimeResponse.status,
          statusText: serverTimeResponse.statusText,
          data: serverTimeResponse.status === 200 ? serverTimeResponse.data : 'N/A',
          isCloudflareBlock: typeof serverTimeResponse.data === 'string' && serverTimeResponse.data.includes('Cloudflare'),
          success: serverTimeResponse.status === 200
        });
      } catch (e: any) {
        results.tests.push({
          name: 'CLOB time endpoint',
          error: e.message,
          success: false
        });
      }

      // Test 3: Check Builder credentials presence
      results.builderCredentials = {
        apiKeyPresent: !!config.polymarketBuilderApiKey,
        apiKeyLength: config.polymarketBuilderApiKey?.length || 0,
        secretPresent: !!config.polymarketBuilderSecret,
        secretLength: config.polymarketBuilderSecret?.length || 0,
        passphrasePresent: !!config.polymarketBuilderPassphrase,
        passphraseLength: config.polymarketBuilderPassphrase?.length || 0
      };

      // Test 4: Check signature type configuration
      results.signatureType = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0', 10);
      results.funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || 'Not set (using EOA)';

      // Summary
      const allTestsPassed = results.tests.every((t: any) => t.success);
      const anyCloudflareBlocks = results.tests.some((t: any) => t.isCloudflareBlock);
      
      results.summary = {
        allTestsPassed,
        anyCloudflareBlocks,
        diagnosis: anyCloudflareBlocks 
          ? 'CLOUDFLARE BLOCKING DETECTED - Your server IP is blocked by Polymarket. Try running locally or using a different server.'
          : allTestsPassed 
            ? 'CLOB API is accessible - issue may be with Builder credentials or signature type'
            : 'CLOB API unreachable - network or configuration issue'
      };

      res.json({ success: true, ...results });
    } catch (error: any) {
      res.status(500).json({ 
        success: false, 
        error: error.message,
        stack: error.stack
      });
    }
  });

  // Test endpoint to check balance for any address (for debugging)
  router.get('/test/balance/:address', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      console.log(`[API] Test balance check for: ${address}`);
      
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid address format' 
        });
      }

      const balanceTracker = copyTrader.getBalanceTracker();
      const balanceData = await balanceTracker.getBalanceWithChange(address);
      
      res.json({ 
        success: true, 
        ...balanceData,
        address: address
      });
    } catch (error: any) {
      console.error('[API] Test balance error:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message || 'Failed to fetch balance'
      });
    }
  });

  return router;
}
