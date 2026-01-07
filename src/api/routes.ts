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
  router.get('/trades', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const trades = performanceTracker.getRecentTrades(limit);
      res.json({ success: true, trades });
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

  // Get trade size configuration
  router.get('/config/trade-size', async (req: Request, res: Response) => {
    try {
      const tradeSize = await Storage.getTradeSize();
      res.json({ success: true, tradeSize });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set trade size configuration
  router.post('/config/trade-size', async (req: Request, res: Response) => {
    try {
      const { tradeSize } = req.body;
      
      if (!tradeSize || typeof tradeSize !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Trade size is required' 
        });
      }

      // Validate that it's a valid number
      const sizeNum = parseFloat(tradeSize);
      if (isNaN(sizeNum) || sizeNum <= 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Trade size must be a positive number' 
        });
      }

      await Storage.setTradeSize(tradeSize);
      res.json({ success: true, message: 'Trade size updated', tradeSize });
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
