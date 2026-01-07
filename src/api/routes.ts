import { Router, Request, Response } from 'express';
import { Storage } from '../storage.js';
import { CopyTrader } from '../copyTrader.js';

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
  router.get('/status', (req: Request, res: Response) => {
    const status = copyTrader.getStatus();
    res.json({ success: true, ...status });
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
  router.get('/wallet', (req: Request, res: Response) => {
    try {
      const walletAddress = copyTrader.getWalletAddress();
      res.json({ 
        success: true, 
        walletAddress: walletAddress || null,
        configured: !!walletAddress
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get user wallet balance with 24h change
  router.get('/wallet/balance', async (req: Request, res: Response) => {
    try {
      const walletAddress = copyTrader.getWalletAddress();
      if (!walletAddress) {
        return res.json({ 
          success: true, 
          currentBalance: 0,
          change24h: 0,
          balance24hAgo: null
        });
      }

      const balanceTracker = copyTrader.getBalanceTracker();
      
      // Ensure balance tracker is initialized
      try {
        // This will initialize if needed
        await balanceTracker.getBalance(walletAddress);
      } catch (initError: any) {
        console.error('Balance tracker initialization error:', initError);
        // Continue anyway - getBalanceWithChange will try to initialize again
      }
      
      const balanceData = await balanceTracker.getBalanceWithChange(walletAddress);
      
      res.json({ 
        success: true, 
        ...balanceData
      });
    } catch (error: any) {
      console.error('Error fetching wallet balance:', error);
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

  return router;
}
