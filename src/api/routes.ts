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
      res.json({ success: true, message: 'Wallet added successfully' });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Remove a wallet from tracking
  router.delete('/wallets/:address', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      await Storage.removeWallet(address);
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

  return router;
}
