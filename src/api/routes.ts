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
      const balanceData = await balanceTracker.getBalanceWithChange(walletAddress);
      
      res.json({ 
        success: true, 
        ...balanceData
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
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

  // Get bot configuration (trade size, etc.)
  router.get('/config', async (req: Request, res: Response) => {
    try {
      const config = await Storage.loadConfig();
      res.json({ success: true, config });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Update bot configuration
  router.post('/config', async (req: Request, res: Response) => {
    try {
      const { tradeSizeUsd } = req.body;
      
      if (tradeSizeUsd !== undefined) {
        if (typeof tradeSizeUsd !== 'number' || tradeSizeUsd <= 0) {
          return res.status(400).json({ 
            success: false, 
            error: 'Trade size must be a positive number' 
          });
        }
      }

      const currentConfig = await Storage.loadConfig();
      const newConfig = {
        ...currentConfig,
        ...(tradeSizeUsd !== undefined && { tradeSizeUsd })
      };

      await Storage.saveConfig(newConfig);
      res.json({ success: true, config: newConfig, message: 'Configuration updated' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get failed trades
  router.get('/trades/failed', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const trades = performanceTracker.getRecentTrades(limit);
      const failedTrades = trades.filter(t => !t.success);
      res.json({ success: true, trades: failedTrades });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Toggle wallet active status (enable/disable copy trading)
  router.patch('/wallets/:address/toggle', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { active } = req.body; // Optional: explicitly set active status
      
      const wallet = await Storage.toggleWalletActive(address, active);
      
      // Reload wallets in the monitor to reflect the change
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

  // Get wallet-specific trades
  router.get('/wallets/:address/trades', (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const limit = parseInt(req.query.limit as string) || 100;
      const trades = performanceTracker.getWalletTrades(address, limit);
      res.json({ success: true, trades });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get wallet-specific performance data for charting
  router.get('/wallets/:address/performance/data', (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const initialBalance = parseFloat(req.query.initialBalance as string) || 1000;
      const dataPoints = performanceTracker.getWalletPerformanceData(address, initialBalance);
      res.json({ success: true, dataPoints });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get wallet positions (active trades/positions from Polymarket)
  router.get('/wallets/:address/positions', async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const api = copyTrader.getPolymarketApi();
      
      console.log(`[API] Fetching positions for wallet: ${address}`);
      
      // Set a timeout for positions fetch (10 seconds max)
      const positionsPromise = api.getUserPositions(address);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Positions fetch timeout')), 10000)
      );
      
      const rawPositions = await Promise.race([positionsPromise, timeoutPromise]) as any[];
      console.log(`[API] Received ${rawPositions?.length || 0} raw positions for ${address}`);
      
      if (!rawPositions || rawPositions.length === 0) {
        return res.json({ 
          success: true, 
          positions: [],
          count: 0
        });
      }
      
      // Log raw data for debugging
      console.log(`[API] Sample position structure:`, JSON.stringify(rawPositions[0], null, 2));
      
      // Enrich positions with market data and parse correctly
      const enrichedPositions = [];
      const maxValue = 10000; // Only show positions < $10,000
      
      // Limit processing to first 20 positions to speed up loading
      const positionsToProcess = rawPositions.slice(0, 20);
      
      for (const position of positionsToProcess) {
        try {
          // Parse position value - try multiple field names
          let positionValue = 0;
          if (typeof position.position_value === 'number') {
            positionValue = position.position_value;
          } else if (typeof position.value === 'number') {
            positionValue = position.value;
          } else if (typeof position.positionValue === 'number') {
            positionValue = position.positionValue;
          } else if (position.usdValue) {
            positionValue = parseFloat(position.usdValue) || 0;
          } else if (position.size && position.price) {
            // Calculate: size * price
            const size = parseFloat(position.size) || parseFloat(position.quantity) || 0;
            const price = parseFloat(position.price) || parseFloat(position.avg_price) || 0;
            positionValue = size * price;
          }
          
          // Filter out positions >= $10,000
          if (positionValue >= maxValue) {
            console.log(`[API] Skipping position with value $${positionValue.toFixed(2)} (>= $${maxValue})`);
            continue;
          }
          
          // Parse quantity/shares
          let quantity = 0;
          if (typeof position.quantity === 'number') {
            quantity = position.quantity;
          } else if (typeof position.size === 'number') {
            quantity = position.size;
          } else if (typeof position.position === 'number') {
            quantity = position.position;
          } else if (typeof position.shares === 'number') {
            quantity = position.shares;
          } else if (position.quantity) {
            quantity = parseFloat(position.quantity) || 0;
          } else if (position.size) {
            quantity = parseFloat(position.size) || 0;
          }
          
          // Parse price/cost basis
          let avgPrice = 0;
          if (typeof position.avg_price === 'number') {
            avgPrice = position.avg_price;
          } else if (typeof position.price === 'number') {
            avgPrice = position.price;
          } else if (typeof position.cost_basis === 'number') {
            avgPrice = position.cost_basis;
          } else if (position.avg_price) {
            avgPrice = parseFloat(position.avg_price) || 0;
          } else if (position.price) {
            avgPrice = parseFloat(position.price) || 0;
          } else if (quantity > 0 && positionValue > 0) {
            // Calculate average price from value and quantity
            avgPrice = positionValue / quantity;
          }
          
          // Get market ID and outcome
          const marketId = position.market_id || 
                          position.marketId || 
                          position.market?.id ||
                          position.condition_id ||
                          position.conditionId ||
                          (position.token_id ? position.token_id.split('-')[0] : null);
          
          // Determine outcome from token ID or position data
          let outcome = 'Unknown';
          if (position.outcome) {
            outcome = position.outcome.toUpperCase();
          } else if (position.token_id) {
            // Token IDs typically end with -0 (YES) or -1 (NO)
            if (position.token_id.endsWith('-0') || position.token_id.includes('-0-')) {
              outcome = 'YES';
            } else if (position.token_id.endsWith('-1') || position.token_id.includes('-1-')) {
              outcome = 'NO';
            }
          } else if (position.outcomeIndex !== undefined) {
            outcome = position.outcomeIndex === 0 ? 'YES' : 'NO';
          }
          
          // Fetch market information if we have a market ID (skip for now to speed up loading)
          // We'll use whatever market info is already in the position data
          let marketInfo = position.market || position.condition || {};
          
          // Only fetch market info if absolutely necessary and we have time
          // For now, skip external API calls to speed up loading
          // TODO: Could fetch market info in background or cache it
          if (false && marketId && (!marketInfo?.question && !marketInfo?.title)) {
            try {
              const market = await api.getMarket(marketId);
              marketInfo = market || marketInfo;
            } catch (error: any) {
              console.warn(`[API] Failed to fetch market ${marketId}:`, error.message);
              // Use what we have
            }
          }
          
          // Get market title
          const marketTitle = marketInfo.question || 
                             marketInfo.title || 
                             marketInfo.name ||
                             marketInfo.marketQuestion ||
                             `Market ${marketId || 'Unknown'}`;
          
          // Only include position if it has meaningful data
          if (quantity > 0 || positionValue > 0) {
            enrichedPositions.push({
              ...position,
              marketId,
              marketTitle,
              outcome,
              quantity,
              avgPrice,
              positionValue,
              market: marketInfo
            });
          }
        } catch (error: any) {
          console.error(`[API] Error enriching position:`, error.message);
          // Continue with other positions
        }
      }
      
      console.log(`[API] Enriched ${enrichedPositions.length} positions (filtered from ${rawPositions.length})`);
      
      res.json({ 
        success: true, 
        positions: enrichedPositions,
        count: enrichedPositions.length,
        totalRawPositions: rawPositions.length
      });
    } catch (error: any) {
      // Log full error for debugging
      console.error(`[API] Failed to load positions for ${address}:`, {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        statusText: error.response?.statusText
      });
      
      // Return error details to help debug
      res.json({ 
        success: false, 
        positions: [], 
        error: error.message,
        details: error.response?.data || null,
        status: error.response?.status || null
      });
    }
  });

  return router;
}
