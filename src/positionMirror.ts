import { PolymarketApi } from './polymarketApi.js';
import { PolymarketClobClient } from './clobClient.js';
import { Storage } from './storage.js';
import { Side } from '@polymarket/clob-client';

/**
 * Mirror trade action types
 */
export type MirrorAction = 'BUY' | 'SELL' | 'SKIP';

/**
 * Status of a mirror trade
 */
export type MirrorStatus = 'ready' | 'warning' | 'skipped' | 'executed' | 'failed';

/**
 * Individual trade in the mirror preview
 */
export interface MirrorTrade {
  // Market info
  marketId: string;
  marketTitle: string;
  tokenId: string;
  outcome: string;
  
  // Their position
  theirShares: number;
  theirAvgPrice: number;
  theirAllocationPercent: number;
  
  // Your current position
  yourShares: number;
  yourAllocationPercent: number;
  
  // Trade details
  action: MirrorAction;
  sharesToTrade: number;
  estimatedCost: number;  // Positive for BUY, negative (proceeds) for SELL
  currentPrice: number;
  
  // Status
  status: MirrorStatus;
  warning?: string;
  priceDeviationPercent?: number;
  
  // For execution
  selected: boolean;
  negRisk?: boolean;
}

/**
 * Mirror preview response
 */
export interface MirrorPreview {
  trackedWalletAddress: string;
  trackedWalletLabel?: string;
  
  // Portfolio values
  yourPortfolioValue: number;
  theirPortfolioValue: number;
  
  // Trades breakdown
  trades: MirrorTrade[];
  
  // Summary
  summary: {
    totalBuyTrades: number;
    totalSellTrades: number;
    totalSkipped: number;
    totalWarnings: number;
    estimatedBuyCost: number;
    estimatedSellProceeds: number;
  };
  
  // Settings used
  slippageTolerance: number;
}

/**
 * Mirror execution result
 */
export interface MirrorExecutionResult {
  success: boolean;
  executedTrades: number;
  failedTrades: number;
  results: Array<{
    marketTitle: string;
    action: MirrorAction;
    success: boolean;
    orderId?: string;
    error?: string;
  }>;
  summary?: {
    sellsAttempted: number;
    sellsSucceeded: number;
    buysAttempted: number;
    buysSucceeded: number;
  };
}

/**
 * Position Mirror - Calculates and executes trades to mirror a tracked wallet's positions
 */
export class PositionMirror {
  private polymarketApi: PolymarketApi;
  private clobClient: PolymarketClobClient;
  
  constructor(polymarketApi: PolymarketApi, clobClient: PolymarketClobClient) {
    this.polymarketApi = polymarketApi;
    this.clobClient = clobClient;
  }
  
  /**
   * Calculate mirror preview - what trades are needed to match the tracked wallet
   */
  async calculateMirrorPreview(
    trackedWalletAddress: string,
    slippageTolerancePercent: number = 10
  ): Promise<MirrorPreview> {
    console.log(`[Mirror] Calculating mirror preview for ${trackedWalletAddress.substring(0, 10)}...`);
    
    // Get wallet label if available
    const wallets = await Storage.loadTrackedWallets();
    const trackedWallet = wallets.find(w => w.address.toLowerCase() === trackedWalletAddress.toLowerCase());
    
    // Step 1: Get tracked wallet's positions and portfolio value
    const theirPositions = await this.polymarketApi.getUserPositions(trackedWalletAddress);
    const theirPortfolio = await this.polymarketApi.getPortfolioValue(trackedWalletAddress);
    
    console.log(`[Mirror] Tracked wallet: ${theirPositions.length} positions, $${theirPortfolio.totalValue.toFixed(2)} total`);
    
    // Step 2: Get user's positions and portfolio value
    // CRITICAL: Must use the proxy/funder address, not the EOA!
    // Polymarket stores positions under the proxy wallet, not the signing wallet
    const eoaAddress = this.clobClient.getWalletAddress();
    if (!eoaAddress) {
      throw new Error('User wallet not configured');
    }
    
    // Check for proxy wallet - try funder address first, then resolve via API
    const funderAddress = this.clobClient.getFunderAddress();
    const proxyAddress = funderAddress || await this.polymarketApi.getProxyWalletAddress(eoaAddress);
    const userAddress = proxyAddress || eoaAddress;
    
    console.log(`[Mirror] Your wallet: EOA=${eoaAddress.substring(0, 10)}..., Proxy=${proxyAddress ? proxyAddress.substring(0, 10) + '...' : 'none'}, Using=${userAddress.substring(0, 10)}...`);
    
    const yourPositions = await this.polymarketApi.getUserPositions(userAddress);
    const yourUsdcBalance = await this.clobClient.getUsdcBalance();
    
    // Calculate your portfolio value (USDC + positions)
    let yourPositionsValue = 0;
    for (const pos of yourPositions) {
      const size = parseFloat(pos.size || '0');
      const price = parseFloat(pos.curPrice || '0');
      yourPositionsValue += size * price;
    }
    const yourPortfolioValue = yourUsdcBalance + yourPositionsValue;
    
    console.log(`[Mirror] Your wallet: ${yourPositions.length} positions, $${yourPortfolioValue.toFixed(2)} total`);
    
    // Create lookup map for your positions by tokenId
    const yourPositionMap = new Map<string, any>();
    for (const pos of yourPositions) {
      yourPositionMap.set(pos.asset, pos);
    }
    
    // Create lookup map for their positions by tokenId
    const theirPositionMap = new Map<string, any>();
    for (const pos of theirPositions) {
      theirPositionMap.set(pos.asset, pos);
    }
    
    const trades: MirrorTrade[] = [];
    
    // Step 3: Process their positions - calculate BUY/SELL needed
    for (const theirPos of theirPositions) {
      const trade = await this.calculateTradeForPosition(
        theirPos,
        yourPositionMap.get(theirPos.asset),
        theirPortfolio.totalValue,
        yourPortfolioValue,
        slippageTolerancePercent
      );
      
      if (trade) {
        trades.push(trade);
      }
    }
    
    // Step 4: Check for positions YOU have that THEY don't - these should be SOLD
    for (const yourPos of yourPositions) {
      if (!theirPositionMap.has(yourPos.asset)) {
        const trade = await this.calculateSellToClosePosition(
          yourPos,
          yourPortfolioValue,
          slippageTolerancePercent
        );
        
        if (trade) {
          trades.push(trade);
        }
      }
    }
    
    // Step 5: Calculate summary
    const summary = {
      totalBuyTrades: trades.filter(t => t.action === 'BUY' && t.status !== 'skipped').length,
      totalSellTrades: trades.filter(t => t.action === 'SELL' && t.status !== 'skipped').length,
      totalSkipped: trades.filter(t => t.status === 'skipped').length,
      totalWarnings: trades.filter(t => t.status === 'warning').length,
      estimatedBuyCost: trades.filter(t => t.action === 'BUY').reduce((sum, t) => sum + t.estimatedCost, 0),
      estimatedSellProceeds: Math.abs(trades.filter(t => t.action === 'SELL').reduce((sum, t) => sum + t.estimatedCost, 0))
    };
    
    console.log(`[Mirror] Preview calculated: ${summary.totalBuyTrades} buys, ${summary.totalSellTrades} sells, ${summary.totalSkipped} skipped`);
    
    return {
      trackedWalletAddress,
      trackedWalletLabel: trackedWallet?.label,
      yourPortfolioValue,
      theirPortfolioValue: theirPortfolio.totalValue,
      trades,
      summary,
      slippageTolerance: slippageTolerancePercent
    };
  }
  
  /**
   * Calculate trade needed for a single position
   */
  private async calculateTradeForPosition(
    theirPos: any,
    yourPos: any | undefined,
    theirTotalValue: number,
    yourTotalValue: number,
    slippageTolerance: number
  ): Promise<MirrorTrade | null> {
    const theirShares = parseFloat(theirPos.size || '0');
    const theirAvgPrice = parseFloat(theirPos.avgPrice || '0');
    const currentPrice = parseFloat(theirPos.curPrice || '0');
    const tokenId = theirPos.asset;
    const marketId = theirPos.conditionId;
    const marketTitle = theirPos.title || marketId?.substring(0, 20) || 'Unknown';
    const outcome = theirPos.outcome || 'Unknown';
    const negRisk = theirPos.negativeRisk || false;
    
    // Check if market is resolved (redeemable = true means winner position)
    if (theirPos.redeemable === true) {
      return {
        marketId,
        marketTitle,
        tokenId,
        outcome,
        theirShares,
        theirAvgPrice,
        theirAllocationPercent: 0,
        yourShares: 0,
        yourAllocationPercent: 0,
        action: 'SKIP',
        sharesToTrade: 0,
        estimatedCost: 0,
        currentPrice,
        status: 'skipped',
        warning: 'Market resolved - position is redeemable',
        selected: false,
        negRisk
      };
    }
    
    // Calculate their allocation %
    const theirPositionValue = theirShares * currentPrice;
    const theirAllocationPercent = theirTotalValue > 0 ? (theirPositionValue / theirTotalValue) * 100 : 0;
    
    // Calculate your current position
    const yourShares = yourPos ? parseFloat(yourPos.size || '0') : 0;
    const yourPositionValue = yourShares * currentPrice;
    const yourAllocationPercent = yourTotalValue > 0 ? (yourPositionValue / yourTotalValue) * 100 : 0;
    
    // Calculate target shares to match their allocation %
    const targetValue = (theirAllocationPercent / 100) * yourTotalValue;
    const targetShares = currentPrice > 0 ? targetValue / currentPrice : 0;
    
    // Calculate shares to trade
    const sharesDelta = targetShares - yourShares;
    
    // Determine action
    let action: MirrorAction;
    let sharesToTrade = Math.abs(sharesDelta);
    
    if (Math.abs(sharesDelta) < 0.5) {
      // Delta too small, skip
      return null;
    }
    
    if (sharesDelta > 0) {
      action = 'BUY';
    } else {
      action = 'SELL';
    }
    
    // Calculate estimated cost
    const estimatedCost = action === 'BUY' 
      ? sharesToTrade * currentPrice 
      : -(sharesToTrade * currentPrice);
    
    // Check price deviation from their entry
    const priceDeviation = theirAvgPrice > 0 
      ? Math.abs((currentPrice - theirAvgPrice) / theirAvgPrice) * 100 
      : 0;
    
    // Determine status
    let status: MirrorStatus = 'ready';
    let warning: string | undefined;
    
    // Check minimum order size (typically 5 shares on Polymarket)
    if (sharesToTrade < 5) {
      status = 'skipped';
      warning = 'Below minimum order size (5 shares)';
    } else if (priceDeviation > slippageTolerance) {
      status = 'warning';
      warning = `Price moved ${priceDeviation.toFixed(1)}% from their entry`;
    }
    
    return {
      marketId,
      marketTitle,
      tokenId,
      outcome,
      theirShares,
      theirAvgPrice,
      theirAllocationPercent,
      yourShares,
      yourAllocationPercent,
      action,
      sharesToTrade: parseFloat(sharesToTrade.toFixed(2)),
      estimatedCost: parseFloat(estimatedCost.toFixed(2)),
      currentPrice,
      status,
      warning,
      priceDeviationPercent: parseFloat(priceDeviation.toFixed(1)),
      selected: status === 'ready', // Pre-select ready trades
      negRisk
    };
  }
  
  /**
   * Calculate sell-to-close for a position you have that they don't
   */
  private async calculateSellToClosePosition(
    yourPos: any,
    yourTotalValue: number,
    slippageTolerance: number
  ): Promise<MirrorTrade | null> {
    const yourShares = parseFloat(yourPos.size || '0');
    const currentPrice = parseFloat(yourPos.curPrice || '0');
    const tokenId = yourPos.asset;
    const marketId = yourPos.conditionId;
    const marketTitle = yourPos.title || marketId?.substring(0, 20) || 'Unknown';
    const outcome = yourPos.outcome || 'Unknown';
    const negRisk = yourPos.negativeRisk || false;
    
    if (yourShares < 0.5) {
      return null;
    }
    
    // Check if market is resolved
    if (yourPos.redeemable === true) {
      return {
        marketId,
        marketTitle,
        tokenId,
        outcome,
        theirShares: 0,
        theirAvgPrice: 0,
        theirAllocationPercent: 0,
        yourShares,
        yourAllocationPercent: yourTotalValue > 0 ? ((yourShares * currentPrice) / yourTotalValue) * 100 : 0,
        action: 'SKIP',
        sharesToTrade: 0,
        estimatedCost: 0,
        currentPrice,
        status: 'skipped',
        warning: 'Market resolved - redeem instead of selling',
        selected: false,
        negRisk
      };
    }
    
    const yourPositionValue = yourShares * currentPrice;
    const yourAllocationPercent = yourTotalValue > 0 ? (yourPositionValue / yourTotalValue) * 100 : 0;
    
    // They don't have this position, so sell all
    const estimatedProceeds = -(yourShares * currentPrice);
    
    let status: MirrorStatus = 'ready';
    let warning: string | undefined;
    
    if (yourShares < 5) {
      status = 'skipped';
      warning = 'Below minimum order size (5 shares)';
    }
    
    return {
      marketId,
      marketTitle,
      tokenId,
      outcome,
      theirShares: 0,
      theirAvgPrice: 0,
      theirAllocationPercent: 0,
      yourShares,
      yourAllocationPercent,
      action: 'SELL',
      sharesToTrade: parseFloat(yourShares.toFixed(2)),
      estimatedCost: parseFloat(estimatedProceeds.toFixed(2)),
      currentPrice,
      status,
      warning: warning || 'They don\'t have this position',
      selected: status === 'ready',
      negRisk
    };
  }
  
  /**
   * Execute selected mirror trades
   * CRITICAL: Sells execute FIRST to free up capital for buys
   */
  async executeMirrorTrades(
    trades: MirrorTrade[],
    slippagePercent: number = 2
  ): Promise<MirrorExecutionResult> {
    // Filter to only selected, actionable trades
    const activeTrades = trades.filter(t => 
      t.selected && t.action !== 'SKIP' && t.status !== 'skipped'
    );
    
    console.log(`[Mirror] Executing ${activeTrades.length} mirror trades...`);
    
    // CRITICAL: Sort trades - SELLs first, then BUYs
    // This frees up capital before we try to spend it
    const sortedTrades = [...activeTrades].sort((a, b) => {
      if (a.action === 'SELL' && b.action === 'BUY') return -1;
      if (a.action === 'BUY' && b.action === 'SELL') return 1;
      return 0;
    });
    
    const sellTrades = sortedTrades.filter(t => t.action === 'SELL');
    const buyTrades = sortedTrades.filter(t => t.action === 'BUY');
    
    console.log(`[Mirror] Execution order: ${sellTrades.length} SELLs first, then ${buyTrades.length} BUYs`);
    
    // Pre-execution balance check
    const currentBalance = await this.clobClient.getUsdcBalance();
    const totalSellProceeds = sellTrades.reduce((sum, t) => sum + Math.abs(t.estimatedCost), 0);
    const totalBuyCost = buyTrades.reduce((sum, t) => sum + t.estimatedCost, 0);
    const projectedBalance = currentBalance + totalSellProceeds;
    
    console.log(`[Mirror] Balance check:`);
    console.log(`[Mirror]   Current USDC: $${currentBalance.toFixed(2)}`);
    console.log(`[Mirror]   Expected from SELLs: +$${totalSellProceeds.toFixed(2)}`);
    console.log(`[Mirror]   Projected after SELLs: $${projectedBalance.toFixed(2)}`);
    console.log(`[Mirror]   BUY cost: $${totalBuyCost.toFixed(2)}`);
    console.log(`[Mirror]   Estimated remaining: $${(projectedBalance - totalBuyCost).toFixed(2)}`);
    
    if (projectedBalance < totalBuyCost * 0.95) { // 5% buffer for slippage
      console.warn(`[Mirror] ⚠️ WARNING: May not have enough balance after sells!`);
    }
    
    const results: MirrorExecutionResult['results'] = [];
    let executedCount = 0;
    let failedCount = 0;
    let sellsCompleted = 0;
    let buysCompleted = 0;
    
    // Execute SELLs first
    console.log(`[Mirror] === PHASE 1: Executing ${sellTrades.length} SELL orders ===`);
    for (const trade of sellTrades) {
      const result = await this.executeSingleTrade(trade, slippagePercent);
      results.push(result);
      if (result.success) {
        executedCount++;
        sellsCompleted++;
      } else {
        failedCount++;
      }
    }
    
    console.log(`[Mirror] SELLs complete: ${sellsCompleted}/${sellTrades.length} succeeded`);
    
    // Brief pause between phases to let balance settle
    if (sellTrades.length > 0 && buyTrades.length > 0) {
      console.log(`[Mirror] Waiting 1s for balance to update...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Execute BUYs second
    console.log(`[Mirror] === PHASE 2: Executing ${buyTrades.length} BUY orders ===`);
    for (const trade of buyTrades) {
      const result = await this.executeSingleTrade(trade, slippagePercent);
      results.push(result);
      if (result.success) {
        executedCount++;
        buysCompleted++;
      } else {
        failedCount++;
      }
    }
    
    console.log(`[Mirror] BUYs complete: ${buysCompleted}/${buyTrades.length} succeeded`);
    console.log(`[Mirror] Execution complete: ${executedCount} succeeded, ${failedCount} failed`);
    
    return {
      success: failedCount === 0,
      executedTrades: executedCount,
      failedTrades: failedCount,
      results,
      summary: {
        sellsAttempted: sellTrades.length,
        sellsSucceeded: sellsCompleted,
        buysAttempted: buyTrades.length,
        buysSucceeded: buysCompleted
      }
    };
  }
  
  /**
   * Execute a single trade with proper error handling
   */
  private async executeSingleTrade(
    trade: MirrorTrade,
    slippagePercent: number
  ): Promise<MirrorExecutionResult['results'][0]> {
    console.log(`[Mirror] Executing ${trade.action} ${trade.sharesToTrade} shares of ${trade.marketTitle}...`);
    
    try {
      // Calculate price with slippage
      let price = trade.currentPrice;
      if (trade.action === 'BUY') {
        // Pay slightly more to ensure fill
        price = Math.min(price * (1 + slippagePercent / 100), 0.99);
      } else {
        // Accept slightly less to ensure fill
        price = Math.max(price * (1 - slippagePercent / 100), 0.01);
      }
      price = parseFloat(price.toFixed(2));
      
      // Place order
      const response = await this.clobClient.createAndPostOrder({
        tokenID: trade.tokenId,
        side: trade.action === 'BUY' ? Side.BUY : Side.SELL,
        size: trade.sharesToTrade,
        price: price,
        negRisk: trade.negRisk
      });
      
      const orderId = response?.orderID || response?.orderId || response?.id;
      
      if (orderId) {
        console.log(`[Mirror] ✓ ${trade.action} executed: ${orderId}`);
        return {
          marketTitle: trade.marketTitle,
          action: trade.action,
          success: true,
          orderId: String(orderId)
        };
      } else {
        throw new Error('No order ID returned');
      }
    } catch (error: any) {
      console.error(`[Mirror] ✗ ${trade.action} failed: ${error.message}`);
      return {
        marketTitle: trade.marketTitle,
        action: trade.action,
        success: false,
        error: error.message
      };
    } finally {
      // Small delay between trades to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
