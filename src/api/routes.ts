import { Router, Request, Response } from 'express';
import { Storage } from '../storage.js';
import { CopyTrader } from '../copyTrader.js';
import { config } from '../config.js';
import { MirrorTrade } from '../positionMirror.js';
import { parseNullableBooleanInput } from '../utils/booleanParsing.js';
import { PositionLifecycleManager } from '../positionLifecycle.js';
import { ArbScanner } from '../arbScanner.js';
import { EntityManager } from '../entityManager.js';
import { HedgeCalculator } from '../hedgeCalculator.js';
import { LadderExitManager } from '../ladderExitManager.js';
import { SmartStopLossManager } from '../smartStopLoss.js';
import { PriceMonitor } from '../priceMonitor.js';
import { getAllPlatformStatuses, getAdapter, getConfiguredAdapters } from '../platform/platformRegistry.js';
import { CrossPlatformExecutor } from '../crossPlatformExecutor.js';
import { CrossPlatformPnlTracker } from '../crossPlatformPnl.js';
import {
  initWalletManager,
  addTradingWallet,
  removeTradingWallet,
  toggleTradingWallet,
  updateTradingWalletLabel,
  getTradingWallets,
  getTradingWallet,
  getActiveTradingWallets,
  addCopyAssignment,
  removeCopyAssignment,
  getCopyAssignments,
  unlockWallets,
  isWalletUnlocked,
  listStoredWalletIds,
  updateWalletBuilderCredentials,
} from '../walletManager.js';

/**
 * API routes for managing the bot
 */
export function createRoutes(copyTrader: CopyTrader): Router {
  const router = Router();
  const performanceTracker = copyTrader.getPerformanceTracker();
  const lifecycleManager = new PositionLifecycleManager();
  const arbScanner = new ArbScanner();
  const entityManager = new EntityManager();
  entityManager.init().catch(err => console.error('[Routes] EntityManager init failed:', err.message));
  const hedgeCalculator = new HedgeCalculator();
  const crossPlatformExecutor = new CrossPlatformExecutor();
  crossPlatformExecutor.init().catch(err => console.error('[Routes] CrossPlatformExecutor init failed:', err.message));
  const pnlTracker = new CrossPlatformPnlTracker();
  pnlTracker.init().catch(err => console.error('[Routes] PnlTracker init failed:', err.message));

  // Ladder exits + stop-loss
  const ladderManager = new LadderExitManager();
  ladderManager.init().catch(err => console.error('[Routes] LadderExit init failed:', err.message));
  const stopLossManager = new SmartStopLossManager();
  stopLossManager.init().catch(err => console.error('[Routes] StopLoss init failed:', err.message));
  const priceMonitor = new PriceMonitor(ladderManager, stopLossManager);

  // Auto-start price monitor if there are active ladders or stop-loss orders
  const autoStartPriceMonitor = () => {
    const hasActiveLadders = ladderManager.getLadders(true).length > 0;
    const hasActiveStopLosses = stopLossManager.getOrders(true).length > 0;
    if ((hasActiveLadders || hasActiveStopLosses) && !priceMonitor.getStatus().isRunning) {
      console.log(`[Routes] Auto-starting PriceMonitor (${ladderManager.getLadders(true).length} ladders, ${stopLossManager.getOrders(true).length} stop-losses)`);
      priceMonitor.start();
    }
  };

  // Delay auto-start slightly to let init() complete
  setTimeout(autoStartPriceMonitor, 2000);

  // Wire up ladder trigger events — execute real trades when in live mode
  priceMonitor.on('ladder-trigger', async (data: any) => {
    const ladderConfig = ladderManager.getConfig();
    console.log(`[LadderExit] Step triggered: ${data.ladder.marketTitle} step ${data.stepIndex + 1}, ${data.sharesToSell.toFixed(2)} shares @ $${data.currentPrice?.toFixed(4)}`);

    if (!ladderConfig.liveMode) {
      console.log(`[LadderExit] PAPER MODE — logging only, no real trade executed`);
      ladderManager.markStepExecuted(data.ladder.id, data.stepIndex, data.currentPrice, data.sharesToSell);
      return;
    }

    // Live mode: execute real SELL order
    try {
      const tradeExecutor = copyTrader.getTradeExecutor();
      const order = {
        marketId: data.ladder.conditionId || data.ladder.tokenId,
        outcome: (data.ladder.outcome || 'YES') as 'YES' | 'NO',
        amount: data.sharesToSell.toFixed(2),
        price: data.currentPrice.toFixed(4),
        side: 'SELL' as const,
        tokenId: data.ladder.tokenId,
        negRisk: false,
      };

      console.log(`[LadderExit] LIVE MODE — executing SELL: ${order.amount} shares of ${data.ladder.marketTitle} @ $${order.price}`);
      const result = await tradeExecutor.executeTrade(order);

      if (result.success) {
        console.log(`[LadderExit] SELL executed successfully (order: ${result.orderId})`);
        ladderManager.markStepExecuted(data.ladder.id, data.stepIndex, data.currentPrice, data.sharesToSell);
      } else {
        console.error(`[LadderExit] SELL failed: ${result.error} — step NOT marked executed, will retry next tick`);
      }
    } catch (err: any) {
      console.error(`[LadderExit] SELL execution error: ${err.message} — step NOT marked executed, will retry next tick`);
    }
  });
  priceMonitor.on('stoploss-trigger', (data: any) => {
    console.log(`[PriceMonitor] Stop-loss sell: ${data.order.marketTitle} ${data.order.outcome}, ${data.order.shares} shares`);
  });

  // ============================================================================
  // PLATFORM STATUS
  // ============================================================================

  router.get('/platforms', (req: Request, res: Response) => {
    res.json({ success: true, platforms: getAllPlatformStatuses() });
  });

  router.get('/platforms/:platform/balance', async (req: Request, res: Response) => {
    try {
      const adapter = getAdapter(req.params.platform as any);
      const balance = await adapter.getBalance();
      res.json({ success: true, platform: req.params.platform, balance });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.get('/platforms/:platform/positions/:identifier', async (req: Request, res: Response) => {
    try {
      const adapter = getAdapter(req.params.platform as any);
      const positions = await adapter.getPositions(req.params.identifier);
      res.json({ success: true, platform: req.params.platform, positions });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

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
      
      // Also add to Dome WebSocket subscription if available
      const domeWs = copyTrader.getDomeWsMonitor();
      if (domeWs) {
        await domeWs.addWallet(address);
      }
      
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
      
      // Also remove from Dome WebSocket subscription if available
      const domeWsRemove = copyTrader.getDomeWsMonitor();
      if (domeWsRemove) {
        await domeWsRemove.removeWallet(address);
      }
      
      // Reload wallets in the monitor to remove the wallet from monitoring
      await copyTrader.reloadWallets();
      
      res.json({ success: true, message: 'Wallet removed successfully' });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Dome API status
  router.get('/dome/status', (req: Request, res: Response) => {
    const status = copyTrader.getStatus();
    const domeWs = status.domeWs;
    res.json({
      success: true,
      configured: !!config.domeApiKey,
      monitoringMode: status.monitoringMode,
      websocket: domeWs ? {
        connected: domeWs.connected,
        subscriptionId: domeWs.subscriptionId,
        trackedWallets: domeWs.trackedWallets,
      } : null,
    });
  });

  // ============================================================================
  // MULTI-WALLET MANAGEMENT
  // ============================================================================

  // Unlock wallets with master password
  router.post('/wallets/unlock', async (req: Request, res: Response) => {
    try {
      const { masterPassword } = req.body;
      if (!masterPassword) {
        return res.status(400).json({ success: false, error: 'masterPassword is required' });
      }
      const result = await unlockWallets(masterPassword);
      res.json({ success: true, ...result });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Check wallet lock status
  router.get('/wallets/lock-status', async (req: Request, res: Response) => {
    const storedIds = await listStoredWalletIds();
    res.json({
      success: true,
      unlocked: isWalletUnlocked(),
      storedWalletCount: storedIds.length,
      storedWalletIds: storedIds,
    });
  });

  // Get all trading wallets
  router.get('/trading-wallets', (req: Request, res: Response) => {
    res.json({ success: true, wallets: getTradingWallets() });
  });

  // Add a trading wallet (with optional Builder API credentials)
  router.post('/trading-wallets', async (req: Request, res: Response) => {
    try {
      const { id, label, privateKey, masterPassword, apiKey, apiSecret, apiPassphrase } = req.body;
      if (!id || !label || !privateKey || !masterPassword) {
        return res.status(400).json({
          success: false,
          error: 'id, label, privateKey, and masterPassword are required'
        });
      }

      // Build Builder credentials object if any credential fields are provided
      const hasBuilderCreds = apiKey && apiSecret && apiPassphrase;
      const builderCreds = hasBuilderCreds
        ? { apiKey, apiSecret, apiPassphrase }
        : undefined;

      const wallet = await addTradingWallet(id, label, privateKey, masterPassword, builderCreds);
      res.json({ success: true, wallet });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Update Builder API credentials for an existing trading wallet
  router.patch('/trading-wallets/:id/credentials', async (req: Request, res: Response) => {
    try {
      const { apiKey, apiSecret, apiPassphrase, masterPassword } = req.body;
      if (!apiKey || !apiSecret || !apiPassphrase || !masterPassword) {
        return res.status(400).json({
          success: false,
          error: 'apiKey, apiSecret, apiPassphrase, and masterPassword are required'
        });
      }
      const wallet = await updateWalletBuilderCredentials(
        req.params.id,
        { apiKey, apiSecret, apiPassphrase },
        masterPassword
      );
      res.json({ success: true, wallet });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Remove a trading wallet
  router.delete('/trading-wallets/:id', async (req: Request, res: Response) => {
    try {
      await removeTradingWallet(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Toggle trading wallet active state
  router.patch('/trading-wallets/:id/toggle', async (req: Request, res: Response) => {
    try {
      const { active } = req.body;
      const wallet = await toggleTradingWallet(req.params.id, active);
      res.json({ success: true, wallet });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Update trading wallet label
  router.patch('/trading-wallets/:id/label', async (req: Request, res: Response) => {
    try {
      const { label } = req.body;
      if (!label) return res.status(400).json({ success: false, error: 'label is required' });
      const wallet = await updateTradingWalletLabel(req.params.id, label);
      res.json({ success: true, wallet });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Get positions for a trading wallet (by wallet ID)
  router.get('/trading-wallets/:id/positions', async (req: Request, res: Response) => {
    try {
      const wallet = getTradingWallet(req.params.id);
      if (!wallet) {
        return res.status(404).json({ success: false, error: `Trading wallet "${req.params.id}" not found` });
      }
      const api = copyTrader.getPolymarketApi();
      const positions = await api.getUserPositions(wallet.address);
      res.json({ success: true, walletId: wallet.id, walletLabel: wallet.label, positions: positions || [] });
    } catch (error: any) {
      console.error(`Failed to load positions for trading wallet ${req.params.id}:`, error.message);
      res.json({ success: true, positions: [], error: error.message });
    }
  });

  // Get copy assignments
  router.get('/copy-assignments', (req: Request, res: Response) => {
    res.json({ success: true, assignments: getCopyAssignments() });
  });

  // Add copy assignment
  router.post('/copy-assignments', async (req: Request, res: Response) => {
    try {
      const { trackedWalletAddress, tradingWalletId, useOwnConfig } = req.body;
      if (!trackedWalletAddress || !tradingWalletId) {
        return res.status(400).json({
          success: false,
          error: 'trackedWalletAddress and tradingWalletId are required'
        });
      }
      const assignment = await addCopyAssignment(trackedWalletAddress, tradingWalletId, useOwnConfig ?? false);
      res.json({ success: true, assignment });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Remove copy assignment
  router.delete('/copy-assignments', async (req: Request, res: Response) => {
    try {
      const { trackedWalletAddress, tradingWalletId } = req.body;
      if (!trackedWalletAddress || !tradingWalletId) {
        return res.status(400).json({
          success: false,
          error: 'trackedWalletAddress and tradingWalletId are required'
        });
      }
      await removeCopyAssignment(trackedWalletAddress, tradingWalletId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ============================================================================
  // POSITION LIFECYCLE (Auto-Redeem / Auto-Merge)
  // ============================================================================

  // Get lifecycle status
  router.get('/lifecycle/status', (req: Request, res: Response) => {
    res.json({ success: true, ...lifecycleManager.getStatus() });
  });

  // Update lifecycle config
  router.post('/lifecycle/config', async (req: Request, res: Response) => {
    try {
      await lifecycleManager.updateConfig(req.body);
      res.json({ success: true, config: lifecycleManager.getStatus().config });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Start lifecycle manager
  router.post('/lifecycle/start', async (req: Request, res: Response) => {
    try {
      await lifecycleManager.start();
      res.json({ success: true, status: lifecycleManager.getStatus() });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Stop lifecycle manager
  router.post('/lifecycle/stop', (req: Request, res: Response) => {
    lifecycleManager.stop();
    res.json({ success: true });
  });

  // Get redeemable positions
  router.get('/lifecycle/redeemable', async (req: Request, res: Response) => {
    try {
      const positions = await lifecycleManager.getRedeemablePositions();
      res.json({ success: true, positions });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Manually trigger check and process
  router.post('/lifecycle/check', async (req: Request, res: Response) => {
    try {
      const results = await lifecycleManager.checkAndProcess();
      res.json({ success: true, results });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Redeem all eligible positions manually
  router.post('/lifecycle/redeem-all', async (req: Request, res: Response) => {
    try {
      const results = await lifecycleManager.redeemAll();
      const succeeded = results.filter(r => r.success).length;
      const totalRecovered = results.filter(r => r.success).reduce((s, r) => s + r.amountRecovered, 0);
      res.json({
        success: true,
        results,
        summary: { total: results.length, succeeded, totalRecovered },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============================================================================
  // ARBITRAGE SCANNER
  // ============================================================================

  // Get arb scanner status
  router.get('/arb/status', (req: Request, res: Response) => {
    res.json({ success: true, ...arbScanner.getStatus() });
  });

  // Get current opportunities
  router.get('/arb/opportunities', (req: Request, res: Response) => {
    res.json({ success: true, opportunities: arbScanner.getOpportunities() });
  });

  // Get matched markets
  router.get('/arb/matched-markets', (req: Request, res: Response) => {
    res.json({ success: true, markets: arbScanner.getMatchedMarkets() });
  });

  // Update arb scanner config
  router.post('/arb/config', async (req: Request, res: Response) => {
    try {
      await arbScanner.updateConfig(req.body);
      res.json({ success: true, config: arbScanner.getStatus().config });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Start arb scanner
  router.post('/arb/start', async (req: Request, res: Response) => {
    try {
      await arbScanner.start();
      res.json({ success: true, status: arbScanner.getStatus() });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Stop arb scanner
  router.post('/arb/stop', (req: Request, res: Response) => {
    arbScanner.stop();
    res.json({ success: true });
  });

  // Trigger manual scan
  router.post('/arb/scan', async (req: Request, res: Response) => {
    try {
      const opportunities = await arbScanner.scan();
      res.json({ success: true, opportunities });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============================================================================
  // ENTITY LINKING + HEDGE DETECTION
  // ============================================================================

  // Get entity manager status
  router.get('/entities/status', (req: Request, res: Response) => {
    res.json({ success: true, ...entityManager.getStatus() });
  });

  // Get all entities
  router.get('/entities', (req: Request, res: Response) => {
    res.json({ success: true, entities: entityManager.getEntities() });
  });

  // Create entity
  router.post('/entities', async (req: Request, res: Response) => {
    try {
      const { id, label, walletAddresses, notes } = req.body;
      if (!id || !label || !walletAddresses || !Array.isArray(walletAddresses)) {
        return res.status(400).json({ success: false, error: 'id, label, and walletAddresses[] are required' });
      }
      const entity = await entityManager.createEntity(id, label, walletAddresses, notes);
      res.json({ success: true, entity });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Remove entity
  router.delete('/entities/:id', async (req: Request, res: Response) => {
    try {
      await entityManager.removeEntity(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Add wallet to entity
  router.post('/entities/:id/wallets', async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress) return res.status(400).json({ success: false, error: 'walletAddress is required' });
      const entity = await entityManager.addWalletToEntity(req.params.id, walletAddress);
      res.json({ success: true, entity });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Remove wallet from entity
  router.delete('/entities/:id/wallets/:address', async (req: Request, res: Response) => {
    try {
      const entity = await entityManager.removeWalletFromEntity(req.params.id, req.params.address);
      res.json({ success: true, entity });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Analyze hedges across all entities
  router.post('/entities/analyze-hedges', async (req: Request, res: Response) => {
    try {
      const hedges = await entityManager.analyzeHedges();
      res.json({ success: true, hedges, count: hedges.length });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get detected hedges
  router.get('/entities/hedges', (req: Request, res: Response) => {
    res.json({ success: true, hedges: entityManager.getHedges() });
  });

  // Find which entity a wallet belongs to
  router.get('/entities/lookup/:address', (req: Request, res: Response) => {
    const entity = entityManager.findEntityForWallet(req.params.address);
    res.json({ success: true, entity: entity || null });
  });

  // ============================================================================
  // PLATFORM WALLETS (entity-level cross-platform wallet management)
  // ============================================================================

  router.post('/entities/:id/platform-wallet', async (req: Request, res: Response) => {
    try {
      const { platform, identifier, label } = req.body;
      if (!platform || !identifier) {
        return res.status(400).json({ success: false, error: 'platform and identifier required' });
      }
      const entity = await entityManager.addPlatformWallet(req.params.id, { platform, identifier, label });
      res.json({ success: true, entity });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.delete('/entities/:id/platform-wallet/:platform/:identifier', async (req: Request, res: Response) => {
    try {
      const entity = await entityManager.removePlatformWallet(
        req.params.id,
        req.params.platform as any,
        req.params.identifier
      );
      res.json({ success: true, entity });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Cross-platform hedge detection
  router.post('/entities/cross-platform-hedges', async (req: Request, res: Response) => {
    try {
      const hedges = await entityManager.detectCrossPlatformHedges();
      res.json({ success: true, hedges, count: hedges.length });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/entities/cross-platform-hedges', (req: Request, res: Response) => {
    res.json({ success: true, hedges: entityManager.getCrossPlatformHedges() });
  });

  // ============================================================================
  // CROSS-PLATFORM EXECUTOR (one-click arb + hedge execution)
  // ============================================================================

  router.get('/executor/status', (req: Request, res: Response) => {
    res.json({ success: true, ...crossPlatformExecutor.getStatus() });
  });

  router.get('/executor/history', (req: Request, res: Response) => {
    res.json({ success: true, history: crossPlatformExecutor.getHistory() });
  });

  router.get('/executor/config', (req: Request, res: Response) => {
    res.json({ success: true, config: crossPlatformExecutor.getConfig() });
  });

  router.post('/executor/config', async (req: Request, res: Response) => {
    try {
      const config = await crossPlatformExecutor.updateConfig(req.body);
      res.json({ success: true, config });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Execute an arbitrage pair trade
  router.post('/executor/arb', async (req: Request, res: Response) => {
    try {
      const result = await crossPlatformExecutor.executeArbPair(req.body);
      res.json({ success: true, result });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Execute a hedge on a specific platform
  router.post('/executor/hedge', async (req: Request, res: Response) => {
    try {
      const { platform, marketId, side, action, size, price } = req.body;
      if (!platform || !marketId || !side || !action || !size || !price) {
        return res.status(400).json({ success: false, error: 'Missing required fields: platform, marketId, side, action, size, price' });
      }
      const result = await crossPlatformExecutor.executeHedge({ platform, marketId, side, action, size, price });
      res.json({ success: true, result });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============================================================================
  // CROSS-PLATFORM P&L + SMART ROUTING
  // ============================================================================

  router.get('/pnl/status', (req: Request, res: Response) => {
    res.json({ success: true, ...pnlTracker.getStatus() });
  });

  router.post('/pnl/calculate', async (req: Request, res: Response) => {
    try {
      const { walletsByPlatform } = req.body;
      if (!walletsByPlatform) {
        return res.status(400).json({ success: false, error: 'walletsByPlatform required (e.g. {"polymarket": ["0x..."], "kalshi": ["acct1"]})' });
      }
      const result = await pnlTracker.calculatePnl(walletsByPlatform);
      res.json({ success: true, pnl: result });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/pnl/history', (req: Request, res: Response) => {
    res.json({ success: true, history: pnlTracker.getPnlHistory() });
  });

  router.post('/smart-route', async (req: Request, res: Response) => {
    try {
      const { side, action, matchedMarket } = req.body;
      if (!side || !action || !matchedMarket) {
        return res.status(400).json({ success: false, error: 'side, action, and matchedMarket required' });
      }
      const route = await pnlTracker.smartRoute({ side, action, matchedMarket });
      res.json({ success: true, route });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/matched-markets', (req: Request, res: Response) => {
    res.json({ success: true, markets: pnlTracker.getMatchedMarkets() });
  });

  // ============================================================================
  // HEDGE CALCULATOR + RECOMMENDATIONS
  // ============================================================================

  // Get hedge calculator status
  router.get('/hedge/status', (req: Request, res: Response) => {
    res.json({ success: true, ...hedgeCalculator.getStatus() });
  });

  // Get current recommendations
  router.get('/hedge/recommendations', (req: Request, res: Response) => {
    res.json({ success: true, recommendations: hedgeCalculator.getRecommendations() });
  });

  // Generate hedge recommendations from current hedges
  router.post('/hedge/generate', async (req: Request, res: Response) => {
    try {
      const hedges = entityManager.getHedges();
      const arbOpps = arbScanner.getOpportunities();

      const hedgeRecs = hedgeCalculator.generateHedgeRecommendations(hedges);
      const arbRecs = hedgeCalculator.generateArbRecommendations(arbOpps);
      const allRecs = [...hedgeRecs, ...arbRecs];

      res.json({
        success: true,
        recommendations: allRecs,
        hedgeCount: hedgeRecs.length,
        arbCount: arbRecs.length,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Execute a recommendation (one-click)
  router.post('/hedge/execute/:id', async (req: Request, res: Response) => {
    try {
      const rec = hedgeCalculator.getRecommendations().find(r => r.id === req.params.id);
      if (!rec) return res.status(404).json({ success: false, error: 'Recommendation not found' });

      const result = await hedgeCalculator.executeRecommendation(rec);
      res.json({ success: true, result });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Update hedge config
  router.post('/hedge/config', (req: Request, res: Response) => {
    try {
      hedgeCalculator.updateConfig(req.body);
      res.json({ success: true, config: hedgeCalculator.getConfig() });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Get execution history
  router.get('/hedge/history', (req: Request, res: Response) => {
    res.json({ success: true, history: hedgeCalculator.getExecutionHistory() });
  });

  // ============================================================================
  // LADDER EXIT
  // ============================================================================

  router.get('/ladder/status', (req: Request, res: Response) => {
    res.json({ success: true, ...ladderManager.getStatus() });
  });

  router.get('/ladder/all', (req: Request, res: Response) => {
    const activeOnly = req.query.active === 'true';
    res.json({ success: true, ladders: ladderManager.getLadders(activeOnly) });
  });

  router.post('/ladder/create', (req: Request, res: Response) => {
    try {
      const { tokenId, conditionId, marketTitle, outcome, entryPrice, totalShares, steps } = req.body;
      if (!tokenId || !entryPrice || !totalShares) {
        return res.status(400).json({ success: false, error: 'tokenId, entryPrice, totalShares required' });
      }
      const ladder = ladderManager.createLadder(
        tokenId, conditionId || '', marketTitle || '', outcome || 'YES',
        parseFloat(entryPrice), parseFloat(totalShares), steps
      );

      // Auto-start price monitor if not already running
      if (!priceMonitor.getStatus().isRunning) {
        console.log('[Routes] Auto-starting PriceMonitor after ladder creation');
        priceMonitor.start();
      }

      res.json({ success: true, ladder });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/ladder/cancel/:id', (req: Request, res: Response) => {
    ladderManager.cancelLadder(req.params.id);
    res.json({ success: true });
  });

  router.post('/ladder/config', async (req: Request, res: Response) => {
    try {
      await ladderManager.updateConfig(req.body);
      res.json({ success: true, config: ladderManager.getConfig() });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ============================================================================
  // SMART STOP-LOSS
  // ============================================================================

  router.get('/stoploss/status', (req: Request, res: Response) => {
    res.json({ success: true, ...stopLossManager.getStatus() });
  });

  router.get('/stoploss/orders', (req: Request, res: Response) => {
    const activeOnly = req.query.active === 'true';
    res.json({ success: true, orders: stopLossManager.getOrders(activeOnly) });
  });

  router.post('/stoploss/create', (req: Request, res: Response) => {
    try {
      const { tokenId, conditionId, marketTitle, outcome, entryPrice, shares, initialStopPrice, trailingPercent, profitLockThreshold } = req.body;
      if (!tokenId || !entryPrice || !shares) {
        return res.status(400).json({ success: false, error: 'tokenId, entryPrice, shares required' });
      }
      const order = stopLossManager.createStopLoss(
        tokenId, conditionId || '', marketTitle || '', outcome || 'YES',
        parseFloat(entryPrice), parseFloat(shares),
        { initialStopPrice: initialStopPrice ? parseFloat(initialStopPrice) : undefined,
          trailingPercent: trailingPercent ? parseFloat(trailingPercent) : undefined,
          profitLockThreshold: profitLockThreshold ? parseFloat(profitLockThreshold) : undefined }
      );

      // Auto-start price monitor if not already running
      if (!priceMonitor.getStatus().isRunning) {
        console.log('[Routes] Auto-starting PriceMonitor after stop-loss creation');
        priceMonitor.start();
      }

      res.json({ success: true, order });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/stoploss/cancel/:id', (req: Request, res: Response) => {
    stopLossManager.cancelStopLoss(req.params.id);
    res.json({ success: true });
  });

  router.post('/stoploss/config', async (req: Request, res: Response) => {
    try {
      await stopLossManager.updateConfig(req.body);
      res.json({ success: true, config: stopLossManager.getConfig() });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ============================================================================
  // PRICE MONITOR
  // ============================================================================

  router.get('/pricemonitor/status', (req: Request, res: Response) => {
    res.json({ success: true, ...priceMonitor.getStatus() });
  });

  router.post('/pricemonitor/start', (req: Request, res: Response) => {
    priceMonitor.start();
    res.json({ success: true, message: 'Price monitor started' });
  });

  router.post('/pricemonitor/stop', (req: Request, res: Response) => {
    priceMonitor.stop();
    res.json({ success: true, message: 'Price monitor stopped' });
  });

  router.post('/pricemonitor/config', (req: Request, res: Response) => {
    try {
      priceMonitor.updateConfig(req.body);
      res.json({ success: true, status: priceMonitor.getStatus() });
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
          connected: status.domeWs?.connected ?? false,
          trackedWallets: status.domeWs?.trackedWallets ?? 0
        },
        polling: {
          active: status.running,
          interval: config.monitoringIntervalMs
        },
        monitoringMode: status.monitoringMode,
        domeWs: status.domeWs,
        monitoringMethods: {
          primary: status.monitoringMode === 'websocket' ? 'dome-websocket' : 'polling',
          domeWebsocket: status.domeWs?.connected ?? false,
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
      
      // Step 2: Load wallets for labels and tags (safe, local operation)
      let walletLabelMap = new Map<string, string>();
      let walletTagsMap = new Map<string, string[]>();
      try {
        const wallets = await Storage.loadTrackedWallets();
        walletLabelMap = new Map(
          wallets.map(w => [w.address.toLowerCase(), w.label || ''])
        );
        walletTagsMap = new Map(
          wallets.map(w => [w.address.toLowerCase(), w.tags || []])
        );
      } catch (error: any) {
        // If wallet lookup fails, use empty maps (no labels/tags shown)
        console.warn('[API] Failed to load wallet labels for trades:', error.message);
      }
      
      // Step 3: Enrich trades with labels and tags (safe, synchronous)
      trades.forEach(t => {
        (t as any).walletLabel = walletLabelMap.get(t.walletAddress.toLowerCase()) || '';
        (t as any).walletTags = walletTagsMap.get(t.walletAddress.toLowerCase()) || [];
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
  // Uses CLOB API directly - this is what the builder credentials are for
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
          walletAddress: null
        });
      }

      // Get balance directly from CLOB API - this is what builder credentials are for
      let currentBalance = 0;
      
      try {
        const clobClient = copyTrader.getClobClient();
        currentBalance = await clobClient.getUsdcBalance();
        console.log(`[API] ✓ CLOB API balance: $${currentBalance.toFixed(2)} USDC`);
      } catch (clobError: any) {
        console.error(`[API] CLOB balance failed:`, clobError.message);
        // Log full error for debugging
        console.error(`[API] Full error:`, clobError);
      }
      
      console.log(`[API] Final balance: $${currentBalance.toFixed(2)}`)
      
      res.json({ 
        success: true, 
        currentBalance,
        change24h: 0,
        balance24hAgo: null,
        walletAddress: eoaAddress
      });
    } catch (error: any) {
      console.error('[API] Error fetching wallet balance:', error);
      console.error('[API] Error stack:', error.stack);
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

  // Get tracked wallet's full Polymarket portfolio value
  // Includes: on-chain USDC balance (from proxy wallet) + positions value
  router.get('/wallets/:address/balance', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const polymarketApi = copyTrader.getPolymarketApi();
      const balanceTracker = copyTrader.getBalanceTracker();
      
      console.log(`[API] Fetching tracked wallet portfolio for: ${address}`);
      
      // Get full portfolio value (USDC + positions)
      const portfolioData = await polymarketApi.getPortfolioValue(address, balanceTracker);
      
      console.log(`[API] Tracked wallet ${address.substring(0, 8)}... portfolio: $${portfolioData.totalValue.toFixed(2)}`);
      console.log(`[API]   USDC: $${portfolioData.usdcBalance.toFixed(2)}`);
      console.log(`[API]   Positions: $${portfolioData.positionsValue.toFixed(2)} (${portfolioData.positionCount} positions)`);
      
      res.json({ 
        success: true, 
        currentBalance: portfolioData.totalValue,
        usdcBalance: portfolioData.usdcBalance,
        positionsValue: portfolioData.positionsValue,
        positionCount: portfolioData.positionCount,
        walletAddress: address,
        proxyWallet: portfolioData.proxyWallet,
        source: 'usdc_plus_positions'
      });
    } catch (error: any) {
      console.error(`[API] Error fetching tracked wallet balance:`, error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message,
        currentBalance: 0
      });
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


  // Update wallet tags (category labels)
  router.patch('/wallets/:address/tags', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { tags } = req.body;

      if (!Array.isArray(tags)) {
        return res.status(400).json({
          success: false,
          error: 'tags must be an array of strings'
        });
      }

      const wallet = await Storage.updateWalletTags(address, tags);

      res.json({
        success: true,
        message: 'Wallet tags updated',
        wallet
      });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Update per-wallet trade configuration (ALL settings are per-wallet)
  // Accepts all filter settings - pass null to clear a value (use default)
  router.patch('/wallets/:address/trade-config', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const {
        // Trade sizing
        tradeSizingMode, fixedTradeSize, thresholdEnabled, thresholdPercent,
        // Trade side filter
        tradeSideFilter,
        // Advanced filters
        noRepeatEnabled, noRepeatPeriodHours,
        priceLimitsMin, priceLimitsMax,
        rateLimitEnabled, rateLimitPerHour, rateLimitPerDay,
        valueFilterEnabled, valueFilterMin, valueFilterMax,
        slippagePercent
      } = req.body;
      
      // Validate tradeSizingMode
      if (tradeSizingMode !== undefined && tradeSizingMode !== null) {
        if (tradeSizingMode !== 'fixed' && tradeSizingMode !== 'proportional') {
          return res.status(400).json({ 
            success: false, 
            error: 'tradeSizingMode must be "fixed", "proportional", or null' 
          });
        }
      }
      
      // Validate fixedTradeSize
      if (fixedTradeSize !== undefined && fixedTradeSize !== null) {
        const sizeNum = parseFloat(fixedTradeSize);
        if (isNaN(sizeNum) || sizeNum <= 0) {
          return res.status(400).json({ 
            success: false, 
            error: 'fixedTradeSize must be a positive number (USDC amount)' 
          });
        }
      }
      
      // Validate thresholdPercent
      if (thresholdPercent !== undefined && thresholdPercent !== null) {
        const percentNum = parseFloat(thresholdPercent);
        if (isNaN(percentNum) || percentNum < 0.1 || percentNum > 100) {
          return res.status(400).json({ 
            success: false, 
            error: 'thresholdPercent must be between 0.1 and 100' 
          });
        }
      }
      
      // Validate tradeSideFilter
      if (tradeSideFilter !== undefined && tradeSideFilter !== null) {
        if (!['all', 'buy_only', 'sell_only'].includes(tradeSideFilter)) {
          return res.status(400).json({ 
            success: false, 
            error: 'tradeSideFilter must be "all", "buy_only", or "sell_only"' 
          });
        }
      }
      
      // Validate noRepeatPeriodHours (0 = forever, or 1-168 hours)
      if (noRepeatPeriodHours !== undefined && noRepeatPeriodHours !== null) {
        const hours = parseInt(noRepeatPeriodHours);
        const validPeriods = [0, 1, 6, 12, 24, 48, 168]; // 0 = forever
        if (isNaN(hours) || !validPeriods.includes(hours)) {
          return res.status(400).json({ 
            success: false, 
            error: `noRepeatPeriodHours must be one of: ${validPeriods.join(', ')} (0 = forever)` 
          });
        }
      }
      
      // Validate price limits
      if (priceLimitsMin !== undefined && priceLimitsMin !== null) {
        const min = parseFloat(priceLimitsMin);
        if (isNaN(min) || min < 0.01 || min > 0.98) {
          return res.status(400).json({ 
            success: false, 
            error: 'priceLimitsMin must be between 0.01 and 0.98' 
          });
        }
      }
      if (priceLimitsMax !== undefined && priceLimitsMax !== null) {
        const max = parseFloat(priceLimitsMax);
        if (isNaN(max) || max < 0.02 || max > 0.99) {
          return res.status(400).json({ 
            success: false, 
            error: 'priceLimitsMax must be between 0.02 and 0.99' 
          });
        }
      }
      
      // Validate rate limits
      if (rateLimitPerHour !== undefined && rateLimitPerHour !== null) {
        const hour = parseInt(rateLimitPerHour);
        if (isNaN(hour) || hour < 1 || hour > 100) {
          return res.status(400).json({ 
            success: false, 
            error: 'rateLimitPerHour must be between 1 and 100' 
          });
        }
      }
      if (rateLimitPerDay !== undefined && rateLimitPerDay !== null) {
        const day = parseInt(rateLimitPerDay);
        if (isNaN(day) || day < 1 || day > 500) {
          return res.status(400).json({ 
            success: false, 
            error: 'rateLimitPerDay must be between 1 and 500' 
          });
        }
      }
      
      // Validate slippage
      if (slippagePercent !== undefined && slippagePercent !== null) {
        const slip = parseFloat(slippagePercent);
        if (isNaN(slip) || slip < 0.5 || slip > 10) {
          return res.status(400).json({ 
            success: false, 
            error: 'slippagePercent must be between 0.5 and 10' 
          });
        }
      }
      
      // Helper to convert value: undefined=don't change, null=clear, value=set
      const parseNum = (v: any) => v !== null && v !== undefined ? parseFloat(v) : (v === null ? null : undefined);
      const parseInt2 = (v: any) => v !== null && v !== undefined ? parseInt(v) : (v === null ? null : undefined);
      const parseBool = (v: any): boolean | null | undefined => parseNullableBooleanInput(v);
      
      const wallet = await Storage.updateWalletTradeConfig(address, {
        // Trade sizing
        tradeSizingMode: tradeSizingMode,
        fixedTradeSize: parseNum(fixedTradeSize),
        thresholdEnabled: parseBool(thresholdEnabled),
        thresholdPercent: parseNum(thresholdPercent),
        // Trade side filter
        tradeSideFilter: tradeSideFilter,
        // Advanced filters
        noRepeatEnabled: parseBool(noRepeatEnabled),
        noRepeatPeriodHours: parseInt2(noRepeatPeriodHours),
        priceLimitsMin: parseNum(priceLimitsMin),
        priceLimitsMax: parseNum(priceLimitsMax),
        rateLimitEnabled: parseBool(rateLimitEnabled),
        rateLimitPerHour: parseInt2(rateLimitPerHour),
        rateLimitPerDay: parseInt2(rateLimitPerDay),
        valueFilterEnabled: parseBool(valueFilterEnabled),
        valueFilterMin: parseNum(valueFilterMin),
        valueFilterMax: parseNum(valueFilterMax),
        slippagePercent: parseNum(slippagePercent)
      });
      
      await copyTrader.reloadWallets();
      
      res.json({ 
        success: true, 
        message: 'Wallet configuration updated',
        wallet 
      });
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Clear per-wallet trade configuration (revert to global defaults)
  router.delete('/wallets/:address/trade-config', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      
      const wallet = await Storage.clearWalletTradeConfig(address);
      await copyTrader.reloadWallets();
      
      res.json({ 
        success: true, 
        message: 'Wallet trade config cleared - using global defaults (copy all trades at global size)',
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

  // ============================================================================
  // MIRROR POSITIONS ENDPOINTS
  // Allows one-click portfolio sync with a tracked wallet
  // ============================================================================

  // Get mirror preview - calculates what trades are needed to match a tracked wallet's positions
  router.post('/wallets/:address/mirror-preview', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const { slippageTolerance } = req.body;
      
      // Validate wallet is being tracked
      const wallets = await Storage.loadTrackedWallets();
      const wallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
      
      if (!wallet) {
        return res.status(404).json({ 
          success: false, 
          error: 'Wallet not found in tracked wallets' 
        });
      }
      
      // Get the position mirror and calculate preview
      const positionMirror = copyTrader.getPositionMirror();
      const tolerance = slippageTolerance !== undefined ? parseFloat(slippageTolerance) : 10;
      
      if (isNaN(tolerance) || tolerance < 0 || tolerance > 100) {
        return res.status(400).json({ 
          success: false, 
          error: 'slippageTolerance must be a number between 0 and 100' 
        });
      }
      
      const preview = await positionMirror.calculateMirrorPreview(address, tolerance);
      
      res.json({ 
        success: true,
        ...preview
      });
    } catch (error: any) {
      console.error('[API] Mirror preview error:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });

  // Execute mirror trades - executes the selected trades from the preview
  router.post('/wallets/:address/mirror-execute', async (req: Request, res: Response) => {
    console.log(`[API] Mirror execute request received for ${req.params.address}`);
    console.log(`[API] Request body keys:`, Object.keys(req.body || {}));
    
    try {
      const { address } = req.params;
      const { trades, slippagePercent } = req.body;
      
      console.log(`[API] trades is array: ${Array.isArray(trades)}, count: ${trades?.length || 0}`);
      
      if (!trades || !Array.isArray(trades)) {
        console.log(`[API] Invalid trades param`);
        return res.status(400).json({ 
          success: false, 
          error: 'trades array is required' 
        });
      }
      
      // Filter to only selected trades
      const selectedTrades = trades.filter((t: MirrorTrade) => t.selected && t.action !== 'SKIP');
      
      if (selectedTrades.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'No trades selected for execution' 
        });
      }
      
      // Validate slippage
      const slippage = slippagePercent !== undefined ? parseFloat(slippagePercent) : 2;
      if (isNaN(slippage) || slippage < 0.5 || slippage > 10) {
        return res.status(400).json({ 
          success: false, 
          error: 'slippagePercent must be between 0.5 and 10' 
        });
      }
      
      // Execute the trades
      const positionMirror = copyTrader.getPositionMirror();
      const result = await positionMirror.executeMirrorTrades(selectedTrades, slippage);
      
      res.json(result);
    } catch (error: any) {
      console.error('[API] Mirror execute error:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
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

  // Get position threshold configuration
  // @deprecated - Use per-wallet trade config instead (PATCH /api/wallets/:address/trade-config)
  // This global threshold is no longer used - filters are now per-wallet only
  router.get('/config/position-threshold', async (req: Request, res: Response) => {
    try {
      const threshold = await Storage.getPositionThreshold();
      res.json({ 
        success: true, 
        ...threshold,
        deprecated: true,
        message: 'This endpoint is deprecated. Use per-wallet trade config instead (PATCH /api/wallets/:address/trade-config). Global threshold is no longer applied.'
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set position threshold configuration
  // @deprecated - Use per-wallet trade config instead (PATCH /api/wallets/:address/trade-config)
  // This global threshold is no longer used - filters are now per-wallet only
  router.post('/config/position-threshold', async (req: Request, res: Response) => {
    try {
      const { enabled, percent } = req.body;
      
      // Validate enabled is boolean
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ 
          success: false, 
          error: 'enabled must be a boolean' 
        });
      }

      // Validate percent is a number between 0.1 and 100
      const percentNum = parseFloat(percent);
      if (isNaN(percentNum) || percentNum < 0.1 || percentNum > 100) {
        return res.status(400).json({ 
          success: false, 
          error: 'percent must be a number between 0.1 and 100' 
        });
      }

      await Storage.setPositionThreshold(enabled, percentNum);
      res.json({ 
        success: true, 
        message: 'WARNING: This setting is deprecated and no longer applied. Use per-wallet trade config instead.',
        deprecated: true,
        enabled,
        percent: percentNum
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get USDC usage stop-loss configuration
  // When enabled, stops taking new trades when X% of USDC is committed to open positions
  router.get('/config/usage-stop-loss', async (req: Request, res: Response) => {
    try {
      const stopLoss = await Storage.getUsageStopLoss();
      res.json({ success: true, ...stopLoss });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set USDC usage stop-loss configuration
  // When enabled, stops taking new trades when X% of USDC is committed to open positions
  router.post('/config/usage-stop-loss', async (req: Request, res: Response) => {
    try {
      const { enabled, maxCommitmentPercent } = req.body;
      
      // Validate enabled is boolean
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ 
          success: false, 
          error: 'enabled must be a boolean' 
        });
      }

      // Validate maxCommitmentPercent is a number between 1 and 99
      const percentNum = parseFloat(maxCommitmentPercent);
      if (isNaN(percentNum) || percentNum < 1 || percentNum > 99) {
        return res.status(400).json({ 
          success: false, 
          error: 'maxCommitmentPercent must be a number between 1 and 99' 
        });
      }

      await Storage.setUsageStopLoss(enabled, percentNum);
      res.json({ 
        success: true, 
        message: enabled 
          ? `Stop-loss enabled: Will stop taking new trades when ${percentNum}% of USDC is committed to open positions` 
          : 'Stop-loss disabled',
        enabled,
        maxCommitmentPercent: percentNum
      });
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
      
      // Reinitialize all components with the new private key
      console.log('[API] Reinitializing bot with new private key...');
      const result = await copyTrader.reinitializeCredentials();
      
      if (result.success) {
        res.json({ 
          success: true, 
          message: 'Private key updated and bot reinitialized',
          walletAddress: result.walletAddress
        });
      } else {
        res.json({ 
          success: true, 
          message: 'Private key saved but reinitialization failed: ' + result.error,
          requiresRestart: true
        });
      }
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
      
      // Reinitialize all components with the new builder credentials
      console.log('[API] Reinitializing bot with new builder credentials...');
      const result = await copyTrader.reinitializeCredentials();
      
      if (result.success) {
        res.json({ 
          success: true, 
          message: 'Builder credentials updated and bot reinitialized',
          walletAddress: result.walletAddress
        });
      } else {
        res.json({ 
          success: true, 
          message: 'Builder credentials saved but reinitialization failed: ' + result.error,
          requiresRestart: true
        });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Save Kalshi API credentials (WARNING: This writes to .env file)
  router.post('/config/kalshi', async (req: Request, res: Response) => {
    try {
      const { apiKeyId, privateKeyPem } = req.body;

      if (!apiKeyId || typeof apiKeyId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Kalshi API Key ID is required'
        });
      }

      if (!privateKeyPem || typeof privateKeyPem !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Kalshi Private Key PEM is required'
        });
      }

      const fs = await import('fs/promises');
      const path = await import('path');
      const envPath = path.join(process.cwd(), '.env');

      let envContent = '';
      try {
        envContent = await fs.readFile(envPath, 'utf-8');
      } catch {
        envContent = '';
      }

      const lines = envContent.split('\n');
      const updates: Record<string, string> = {
        'KALSHI_API_KEY_ID': apiKeyId,
        'KALSHI_PRIVATE_KEY_PEM': privateKeyPem
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

      // Update environment variables in memory
      process.env.KALSHI_API_KEY_ID = apiKeyId;
      process.env.KALSHI_PRIVATE_KEY_PEM = privateKeyPem;

      res.json({
        success: true,
        message: 'Kalshi credentials saved. Platform will be available on next restart or adapter refresh.'
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get proxy wallet (funder) address configuration
  router.get('/config/proxy-wallet', async (req: Request, res: Response) => {
    try {
      const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || '';
      const eoaAddress = copyTrader.getWalletAddress();
      
      res.json({ 
        success: true, 
        proxyWalletAddress: funderAddress,
        eoaAddress: eoaAddress,
        configured: !!funderAddress
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Update proxy wallet (funder) address (WARNING: This writes to .env file)
  // The proxy wallet is where Polymarket holds your USDC
  router.post('/config/proxy-wallet', async (req: Request, res: Response) => {
    try {
      const { proxyWalletAddress } = req.body;
      
      if (!proxyWalletAddress || typeof proxyWalletAddress !== 'string') {
        return res.status(400).json({ 
          success: false, 
          error: 'Proxy wallet address is required' 
        });
      }

      // Validate address format (0x followed by 40 hex chars)
      const trimmedAddress = proxyWalletAddress.trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(trimmedAddress)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid address format (must be 0x followed by 40 hex characters)' 
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

      // Update or add POLYMARKET_FUNDER_ADDRESS
      const lines = envContent.split('\n');
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('POLYMARKET_FUNDER_ADDRESS=')) {
          lines[i] = `POLYMARKET_FUNDER_ADDRESS=${trimmedAddress}`;
          found = true;
          break;
        }
      }
      if (!found) {
        lines.push(`POLYMARKET_FUNDER_ADDRESS=${trimmedAddress}`);
      }

      await fs.writeFile(envPath, lines.join('\n'));
      
      // Update environment variable in memory
      process.env.POLYMARKET_FUNDER_ADDRESS = trimmedAddress;
      
      // Reinitialize to pick up the new proxy wallet
      console.log('[API] Reinitializing bot with new proxy wallet address...');
      const result = await copyTrader.reinitializeCredentials();
      
      if (result.success) {
        res.json({ 
          success: true, 
          message: 'Proxy wallet address saved and bot reinitialized',
          proxyWalletAddress: trimmedAddress
        });
      } else {
        res.json({ 
          success: true, 
          message: 'Proxy wallet address saved. Balance should update on next refresh.',
          proxyWalletAddress: trimmedAddress
        });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============================================================================
  // ADVANCED TRADE FILTER CONFIGURATION ENDPOINTS
  // ============================================================================

  // Get no-repeat-trades configuration
  router.get('/config/no-repeat-trades', async (req: Request, res: Response) => {
    try {
      const config = await Storage.getNoRepeatTrades();
      res.json({ success: true, ...config });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set no-repeat-trades configuration
  router.post('/config/no-repeat-trades', async (req: Request, res: Response) => {
    try {
      const { enabled, blockPeriodHours } = req.body;
      
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ 
          success: false, 
          error: 'enabled must be a boolean' 
        });
      }

      const periodNum = parseInt(blockPeriodHours);
      const validPeriods = [1, 6, 12, 24, 48, 168]; // 1h, 6h, 12h, 24h, 48h, 7 days
      if (isNaN(periodNum) || !validPeriods.includes(periodNum)) {
        return res.status(400).json({ 
          success: false, 
          error: `blockPeriodHours must be one of: ${validPeriods.join(', ')}` 
        });
      }

      await Storage.setNoRepeatTrades(enabled, periodNum);
      
      // Cleanup expired positions when enabling or changing period
      if (enabled) {
        await Storage.cleanupExpiredPositions(periodNum);
      }
      
      res.json({ 
        success: true, 
        message: enabled 
          ? `No-repeat-trades enabled: Will block repeat trades in same market+side for ${periodNum} hours` 
          : 'No-repeat-trades disabled',
        enabled,
        blockPeriodHours: periodNum
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get no-repeat-trades history (blocked positions)
  router.get('/config/no-repeat-trades/history', async (req: Request, res: Response) => {
    try {
      const positions = await Storage.getExecutedPositions();
      const config = await Storage.getNoRepeatTrades();
      const blockPeriodMs = config.blockPeriodHours * 60 * 60 * 1000;
      const cutoffTime = Date.now() - blockPeriodMs;
      
      // Mark which positions are currently blocking
      const positionsWithStatus = positions.map(p => ({
        ...p,
        isBlocking: p.timestamp > cutoffTime,
        expiresAt: new Date(p.timestamp + blockPeriodMs).toISOString(),
        age: Math.round((Date.now() - p.timestamp) / (60 * 60 * 1000)) + ' hours'
      }));
      
      res.json({ 
        success: true, 
        positions: positionsWithStatus,
        totalPositions: positions.length,
        activeBlocks: positionsWithStatus.filter(p => p.isBlocking).length
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Clear no-repeat-trades history
  router.delete('/config/no-repeat-trades/history', async (req: Request, res: Response) => {
    try {
      await Storage.clearExecutedPositions();
      res.json({ 
        success: true, 
        message: 'No-repeat-trades history cleared. All markets are now unblocked.' 
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get price limits configuration
  router.get('/config/price-limits', async (req: Request, res: Response) => {
    try {
      const limits = await Storage.getPriceLimits();
      res.json({ success: true, ...limits });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set price limits configuration
  router.post('/config/price-limits', async (req: Request, res: Response) => {
    try {
      const { minPrice, maxPrice } = req.body;
      
      const minNum = parseFloat(minPrice);
      const maxNum = parseFloat(maxPrice);
      
      if (isNaN(minNum) || minNum < 0.01 || minNum > 0.98) {
        return res.status(400).json({ 
          success: false, 
          error: 'minPrice must be between 0.01 and 0.98' 
        });
      }
      
      if (isNaN(maxNum) || maxNum < 0.02 || maxNum > 0.99) {
        return res.status(400).json({ 
          success: false, 
          error: 'maxPrice must be between 0.02 and 0.99' 
        });
      }
      
      if (minNum >= maxNum) {
        return res.status(400).json({ 
          success: false, 
          error: 'minPrice must be less than maxPrice' 
        });
      }

      await Storage.setPriceLimits(minNum, maxNum);
      res.json({ 
        success: true, 
        message: `Price limits updated: Only copy trades between $${minNum.toFixed(2)} and $${maxNum.toFixed(2)}`,
        minPrice: minNum,
        maxPrice: maxNum
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get slippage configuration
  router.get('/config/slippage', async (req: Request, res: Response) => {
    try {
      const slippagePercent = await Storage.getSlippagePercent();
      res.json({ success: true, slippagePercent });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set slippage configuration
  router.post('/config/slippage', async (req: Request, res: Response) => {
    try {
      const { slippagePercent } = req.body;
      
      const percentNum = parseFloat(slippagePercent);
      if (isNaN(percentNum) || percentNum < 0.5 || percentNum > 10) {
        return res.status(400).json({ 
          success: false, 
          error: 'slippagePercent must be between 0.5 and 10' 
        });
      }

      await Storage.setSlippagePercent(percentNum);
      res.json({ 
        success: true, 
        message: `Slippage updated to ${percentNum}%`,
        slippagePercent: percentNum
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get global trade side filter configuration
  router.get('/config/trade-side-filter', async (req: Request, res: Response) => {
    try {
      const tradeSideFilter = await Storage.getTradeSideFilter();
      res.json({ success: true, tradeSideFilter });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set global trade side filter configuration
  router.post('/config/trade-side-filter', async (req: Request, res: Response) => {
    try {
      const { tradeSideFilter } = req.body;
      
      if (!['all', 'buy_only', 'sell_only'].includes(tradeSideFilter)) {
        return res.status(400).json({ 
          success: false, 
          error: 'tradeSideFilter must be "all", "buy_only", or "sell_only"' 
        });
      }

      await Storage.setTradeSideFilter(tradeSideFilter);
      
      const filterLabel = tradeSideFilter === 'buy_only' ? 'BUY trades only' : 
                          tradeSideFilter === 'sell_only' ? 'SELL trades only' : 'All trades (BUY and SELL)';
      
      res.json({ 
        success: true, 
        message: `Trade side filter set to: ${filterLabel}`,
        tradeSideFilter
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get rate limiting configuration
  router.get('/config/rate-limiting', async (req: Request, res: Response) => {
    try {
      const rateLimiting = await Storage.getRateLimiting();
      res.json({ success: true, ...rateLimiting });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set rate limiting configuration
  router.post('/config/rate-limiting', async (req: Request, res: Response) => {
    try {
      const { enabled, maxTradesPerHour, maxTradesPerDay } = req.body;
      
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ 
          success: false, 
          error: 'enabled must be a boolean' 
        });
      }

      const hourNum = parseInt(maxTradesPerHour);
      if (isNaN(hourNum) || hourNum < 1 || hourNum > 100) {
        return res.status(400).json({ 
          success: false, 
          error: 'maxTradesPerHour must be between 1 and 100' 
        });
      }

      const dayNum = parseInt(maxTradesPerDay);
      if (isNaN(dayNum) || dayNum < 1 || dayNum > 500) {
        return res.status(400).json({ 
          success: false, 
          error: 'maxTradesPerDay must be between 1 and 500' 
        });
      }

      if (hourNum > dayNum) {
        return res.status(400).json({ 
          success: false, 
          error: 'maxTradesPerHour cannot exceed maxTradesPerDay' 
        });
      }

      await Storage.setRateLimiting(enabled, hourNum, dayNum);
      res.json({ 
        success: true, 
        message: enabled 
          ? `Rate limiting enabled: Max ${hourNum} trades/hour, ${dayNum} trades/day` 
          : 'Rate limiting disabled',
        enabled,
        maxTradesPerHour: hourNum,
        maxTradesPerDay: dayNum
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get rate limiting status (current counts) - per-wallet
  // Optional query param: ?wallet=0x... to get specific wallet's status
  router.get('/config/rate-limiting/status', async (req: Request, res: Response) => {
    try {
      const walletAddress = req.query.wallet as string | undefined;
      
      if (walletAddress) {
        // Get specific wallet's rate limit status
        const walletRateState = copyTrader.getRateLimitStatus(walletAddress);
        const wallet = await Storage.getWallet(walletAddress);
        
        // Use wallet's rate limit settings or defaults
        const maxPerHour = wallet?.rateLimitPerHour ?? 10;
        const maxPerDay = wallet?.rateLimitPerDay ?? 50;
        const enabled = wallet?.rateLimitEnabled ?? false;
        
        // walletRateState is a single RateLimitState when address is provided
        const state = walletRateState as { tradesThisHour: number; tradesThisDay: number };
        
        res.json({ 
          success: true,
          wallet: walletAddress,
          enabled,
          config: { maxPerHour, maxPerDay },
          current: state,
          remainingThisHour: enabled ? Math.max(0, maxPerHour - state.tradesThisHour) : null,
          remainingThisDay: enabled ? Math.max(0, maxPerDay - state.tradesThisDay) : null
        });
      } else {
        // Get all wallets' rate limit status
        const allStates = copyTrader.getRateLimitStatus();
        const wallets = await Storage.loadTrackedWallets();
        
        // Convert Map to object for JSON response
        const perWalletStatus: Record<string, any> = {};
        
        if (allStates instanceof Map) {
          for (const [addr, state] of allStates) {
            const wallet = wallets.find(w => w.address.toLowerCase() === addr);
            perWalletStatus[addr] = {
              enabled: wallet?.rateLimitEnabled ?? false,
              config: {
                maxPerHour: wallet?.rateLimitPerHour ?? 10,
                maxPerDay: wallet?.rateLimitPerDay ?? 50
              },
              current: state
            };
          }
        }
        
        res.json({ 
          success: true,
          perWallet: perWalletStatus,
          walletsWithRateLimiting: wallets.filter(w => w.rateLimitEnabled).length
        });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get trade value filters configuration
  router.get('/config/trade-value-filters', async (req: Request, res: Response) => {
    try {
      const filters = await Storage.getTradeValueFilters();
      res.json({ success: true, ...filters });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set trade value filters configuration
  router.post('/config/trade-value-filters', async (req: Request, res: Response) => {
    try {
      const { enabled, minTradeValueUSD, maxTradeValueUSD } = req.body;
      
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ 
          success: false, 
          error: 'enabled must be a boolean' 
        });
      }

      let minVal: number | null = null;
      let maxVal: number | null = null;

      if (minTradeValueUSD !== null && minTradeValueUSD !== undefined) {
        minVal = parseFloat(minTradeValueUSD);
        if (isNaN(minVal) || minVal < 0) {
          return res.status(400).json({ 
            success: false, 
            error: 'minTradeValueUSD must be a non-negative number or null' 
          });
        }
      }

      if (maxTradeValueUSD !== null && maxTradeValueUSD !== undefined) {
        maxVal = parseFloat(maxTradeValueUSD);
        if (isNaN(maxVal) || maxVal < 0) {
          return res.status(400).json({ 
            success: false, 
            error: 'maxTradeValueUSD must be a non-negative number or null' 
          });
        }
      }

      if (minVal !== null && maxVal !== null && minVal >= maxVal) {
        return res.status(400).json({ 
          success: false, 
          error: 'minTradeValueUSD must be less than maxTradeValueUSD' 
        });
      }

      await Storage.setTradeValueFilters(enabled, minVal, maxVal);
      
      let message = enabled ? 'Trade value filters enabled: ' : 'Trade value filters disabled';
      if (enabled) {
        const parts = [];
        if (minVal !== null) parts.push(`min $${minVal}`);
        if (maxVal !== null) parts.push(`max $${maxVal}`);
        message += parts.length > 0 ? parts.join(', ') : 'no limits set';
      }
      
      res.json({ 
        success: true, 
        message,
        enabled,
        minTradeValueUSD: minVal,
        maxTradeValueUSD: maxVal
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get all configuration in one call (for UI)
  router.get('/config/all', async (req: Request, res: Response) => {
    try {
      const [
        tradeSize,
        noRepeatTrades,
        priceLimits,
        slippagePercent,
        tradeSideFilter,
        rateLimiting,
        tradeValueFilters,
        usageStopLoss,
        monitoringInterval
      ] = await Promise.all([
        Storage.getTradeSize(),
        Storage.getNoRepeatTrades(),
        Storage.getPriceLimits(),
        Storage.getSlippagePercent(),
        Storage.getTradeSideFilter(),
        Storage.getRateLimiting(),
        Storage.getTradeValueFilters(),
        Storage.getUsageStopLoss(),
        Storage.getMonitoringInterval()
      ]);

      res.json({ 
        success: true,
        config: {
          tradeSize,
          noRepeatTrades,
          priceLimits,
          slippagePercent,
          tradeSideFilter,
          rateLimiting,
          tradeValueFilters,
          usageStopLoss,
          monitoringIntervalMs: monitoringInterval
        }
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Validate configuration and detect conflicts
  router.get('/config/validate', async (req: Request, res: Response) => {
    try {
      const [
        noRepeatTrades,
        priceLimits,
        rateLimiting,
        tradeValueFilters,
        usageStopLoss,
        wallets
      ] = await Promise.all([
        Storage.getNoRepeatTrades(),
        Storage.getPriceLimits(),
        Storage.getRateLimiting(),
        Storage.getTradeValueFilters(),
        Storage.getUsageStopLoss(),
        Storage.loadTrackedWallets()
      ]);

      const conflicts: Array<{
        type: 'warning' | 'error';
        code: string;
        message: string;
        affectedSettings: string[];
        suggestion?: string;
      }> = [];

      // Runtime safety: if stop-loss is currently active, copy trading is blocked by design.
      const stopLossStatus = await copyTrader.getUsageStopLossStatus();
      if (stopLossStatus.enabled && stopLossStatus.active) {
        conflicts.push({
          type: 'warning',
          code: 'STOP_LOSS_CURRENTLY_BLOCKING',
          message: `Stop-loss is currently blocking new trades (${stopLossStatus.commitmentPercent?.toFixed(2)}% committed >= ${stopLossStatus.maxCommitmentPercent}%).`,
          affectedSettings: ['usageStopLoss'],
          suggestion: 'Disable stop-loss or raise maxCommitmentPercent if you want new trades to execute'
        });
      }

      // Check for narrow price range
      const priceRange = priceLimits.maxPrice - priceLimits.minPrice;
      if (priceRange < 0.10) {
        conflicts.push({
          type: 'warning',
          code: 'NARROW_PRICE_RANGE',
          message: `Price range is very narrow (${(priceRange * 100).toFixed(0)}¢). This may skip many valid trades.`,
          affectedSettings: ['priceLimits'],
          suggestion: 'Consider widening the price range to at least 0.10'
        });
      }

      // Check for very low rate limits
      if (rateLimiting.enabled && rateLimiting.maxTradesPerHour < 3) {
        conflicts.push({
          type: 'warning',
          code: 'LOW_RATE_LIMIT',
          message: `Rate limit is very low (${rateLimiting.maxTradesPerHour}/hour). You may miss important trades.`,
          affectedSettings: ['rateLimiting'],
          suggestion: 'Consider allowing at least 5 trades per hour'
        });
      }

      // Check for stop-loss blocking most trades
      if (usageStopLoss.enabled && usageStopLoss.maxCommitmentPercent < 10) {
        conflicts.push({
          type: 'warning',
          code: 'AGGRESSIVE_STOP_LOSS',
          message: `Stop-loss is set very low (${usageStopLoss.maxCommitmentPercent}%). This may block most trades.`,
          affectedSettings: ['usageStopLoss'],
          suggestion: 'Consider setting stop-loss to at least 20%'
        });
      }

      // Check for trade value filter conflicts
      if (tradeValueFilters.enabled) {
        if (tradeValueFilters.minTradeValueUSD !== null && 
            tradeValueFilters.maxTradeValueUSD !== null &&
            tradeValueFilters.minTradeValueUSD >= tradeValueFilters.maxTradeValueUSD) {
          conflicts.push({
            type: 'error',
            code: 'INVALID_VALUE_FILTER',
            message: 'Minimum trade value is greater than or equal to maximum trade value.',
            affectedSettings: ['tradeValueFilters'],
            suggestion: 'Set minimum value lower than maximum value'
          });
        }
      }

      // Check for short no-repeat block period
      if (noRepeatTrades.enabled && noRepeatTrades.blockPeriodHours < 6) {
        conflicts.push({
          type: 'warning',
          code: 'SHORT_BLOCK_PERIOD',
          message: `No-repeat block period is short (${noRepeatTrades.blockPeriodHours}h). Repeated trades may still occur.`,
          affectedSettings: ['noRepeatTrades'],
          suggestion: 'Consider blocking for at least 24 hours'
        });
      }

      // Check for per-wallet threshold conflicts
      const walletsWithThresholdButNoFixedMode = wallets.filter(
        w => w.thresholdEnabled && w.tradeSizingMode !== 'fixed'
      );
      if (walletsWithThresholdButNoFixedMode.length > 0) {
        conflicts.push({
          type: 'warning',
          code: 'THRESHOLD_WITHOUT_FIXED_MODE',
          message: `${walletsWithThresholdButNoFixedMode.length} wallet(s) have threshold enabled but aren't in 'fixed' sizing mode. Threshold will be ignored.`,
          affectedSettings: ['perWalletConfig'],
          suggestion: 'Set tradeSizingMode to "fixed" for wallets where you want threshold filtering'
        });
      }

      res.json({ 
        success: true,
        valid: conflicts.filter(c => c.type === 'error').length === 0,
        conflicts,
        errorCount: conflicts.filter(c => c.type === 'error').length,
        warningCount: conflicts.filter(c => c.type === 'warning').length,
        runtime: {
          stopLoss: stopLossStatus
        }
      });
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
      
      const clobUrl = config.polymarketClobApiUrl || 'https://clob.polymarket.com';
      
      // Test 1: CLOB time endpoint - reliable connectivity check
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

      // Test 2: Check Builder credentials presence
      results.builderCredentials = {
        apiKeyPresent: !!config.polymarketBuilderApiKey,
        apiKeyLength: config.polymarketBuilderApiKey?.length || 0,
        secretPresent: !!config.polymarketBuilderSecret,
        secretLength: config.polymarketBuilderSecret?.length || 0,
        passphrasePresent: !!config.polymarketBuilderPassphrase,
        passphraseLength: config.polymarketBuilderPassphrase?.length || 0
      };

      // Test 3: Check signature type configuration
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
            ? 'CLOB API is accessible - credentials configured correctly'
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
