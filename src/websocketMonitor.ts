import WebSocket from 'ws';
import { PolymarketApi } from './polymarketApi.js';
import { DetectedTrade } from './types.js';
import { Storage } from './storage.js';

/**
 * WebSocket-based monitor for real-time Polymarket trade detection
 * Connects to Polymarket's WebSocket API for instant trade notifications
 */
export class WebSocketMonitor {
  private api: PolymarketApi;
  private ws: WebSocket | null = null;
  private isMonitoring = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000; // Start with 5 seconds
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private trackedWallets = new Set<string>(); // Track wallet addresses (proxy wallets)
  private eoaToProxyMap = new Map<string, string>(); // Map EOA -> Proxy wallet
  private isConnected = false;
  private lastConnectionTime: Date | null = null;

  constructor() {
    this.api = new PolymarketApi();
  }

  /**
   * Initialize the WebSocket monitor
   */
  async initialize(): Promise<void> {
    await this.api.initialize();
    console.log('[WebSocket] Monitor initialized');
  }

  /**
   * Start monitoring tracked wallets via WebSocket
   */
  async startMonitoring(
    onTradeDetected: (trade: DetectedTrade) => void
  ): Promise<void> {
    if (this.isMonitoring) {
      console.log('[WebSocket] Already monitoring');
      return;
    }

    this.isMonitoring = true;
    console.log('[WebSocket] Starting real-time trade monitoring...');

    // Load tracked wallets and map to proxy wallets
    await this.loadTrackedWallets();

    // Connect to WebSocket
    await this.connect(onTradeDetected);
  }

  /**
   * Load tracked wallets and resolve proxy wallet addresses
   */
  private async loadTrackedWallets(): Promise<void> {
    const wallets = await Storage.getActiveWallets();
    this.trackedWallets.clear();
    this.eoaToProxyMap.clear();

    console.log(`[WebSocket] Loading ${wallets.length} tracked wallet(s)...`);

    for (const wallet of wallets) {
      try {
        const eoaAddress = wallet.address.toLowerCase();
        
        // Get proxy wallet address
        let proxyAddress: string | null = null;
        try {
          proxyAddress = await this.api.getProxyWalletAddress(eoaAddress);
          if (proxyAddress) {
            const normalizedProxy = proxyAddress.toLowerCase();
            this.trackedWallets.add(normalizedProxy);
            this.eoaToProxyMap.set(eoaAddress, normalizedProxy);
            console.log(`[WebSocket] Tracking proxy wallet ${normalizedProxy.substring(0, 8)}... (EOA: ${eoaAddress.substring(0, 8)}...)`);
          } else {
            // Use EOA directly if no proxy found
            this.trackedWallets.add(eoaAddress);
            console.log(`[WebSocket] Tracking EOA directly ${eoaAddress.substring(0, 8)}... (no proxy found)`);
          }
        } catch (error: any) {
          console.warn(`[WebSocket] Failed to get proxy wallet for ${eoaAddress.substring(0, 8)}..., using EOA directly:`, error.message);
          this.trackedWallets.add(eoaAddress);
        }
      } catch (error: any) {
        console.error(`[WebSocket] Error loading wallet ${wallet.address}:`, error.message);
      }
    }

    console.log(`[WebSocket] Monitoring ${this.trackedWallets.size} wallet(s) for trades`);
  }

  /**
   * Connect to Polymarket WebSocket
   * Based on Polymarket's WebSocket API at wss://ws-subscriptions-clob.polymarket.com
   */
  private async connect(
    onTradeDetected: (trade: DetectedTrade) => void
  ): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      // Polymarket WebSocket endpoint for CLOB subscriptions
      const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com';
      console.log(`[WebSocket] Connecting to ${wsUrl}...`);

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[WebSocket] ✅ Connected successfully');
        this.isConnected = true;
        this.lastConnectionTime = new Date();
        this.reconnectAttempts = 0;
        this.reconnectDelay = 5000; // Reset reconnect delay

        // Start ping interval to keep connection alive (every 30 seconds)
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 30000);

        // Subscribe to trades for tracked wallets
        this.subscribeToTrades();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message, onTradeDetected);
        } catch (error: any) {
          console.error('[WebSocket] Error parsing message:', error.message);
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('[WebSocket] ❌ Connection error:', error.message);
        this.isConnected = false;
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`[WebSocket] ⚠️ Connection closed (code: ${code}, reason: ${reason.toString()})`);
        this.isConnected = false;
        
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }

        // Attempt to reconnect if we're still supposed to be monitoring
        if (this.isMonitoring && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect(onTradeDetected);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('[WebSocket] ❌ Max reconnection attempts reached. WebSocket monitoring disabled.');
          console.error('[WebSocket] ℹ️ Falling back to polling-based monitoring');
        }
      });

      this.ws.on('pong', () => {
        // Connection is alive
      });

    } catch (error: any) {
      console.error('[WebSocket] ❌ Failed to create WebSocket connection:', error.message);
      this.isConnected = false;
      
      if (this.isMonitoring) {
        this.scheduleReconnect(onTradeDetected);
      }
    }
  }

  /**
   * Subscribe to trade events for tracked wallets
   */
  private subscribeToTrades(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Subscribe to trade events for each tracked wallet
    // Polymarket WebSocket uses JSON-RPC style subscriptions
    for (const walletAddress of this.trackedWallets) {
      try {
        // Subscribe to user trades
        // Format: { "method": "subscribe", "params": { "channel": "trades", "user": "0x..." } }
        const subscribeMessage = {
          method: 'subscribe',
          params: {
            channel: 'trades',
            user: walletAddress
          }
        };

        this.ws.send(JSON.stringify(subscribeMessage));
        console.log(`[WebSocket] 📡 Subscribed to trades for ${walletAddress.substring(0, 8)}...`);
      } catch (error: any) {
        console.error(`[WebSocket] Error subscribing to ${walletAddress}:`, error.message);
      }
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private async handleMessage(
    message: any,
    onTradeDetected: (trade: DetectedTrade) => void
  ): Promise<void> {
    try {
      // Handle different message types
      if (message.event === 'trade' || message.type === 'trade') {
        // Trade event received
        await this.processTradeEvent(message, onTradeDetected);
      } else if (message.method === 'subscription' || message.channel === 'trades') {
        // Subscription confirmation or trade data
        if (message.params && message.params.data) {
          await this.processTradeEvent(message.params.data, onTradeDetected);
        } else {
          await this.processTradeEvent(message, onTradeDetected);
        }
      } else if (message.id) {
        // Response to a subscription request
        if (message.result) {
          console.log('[WebSocket] ✅ Subscription confirmed:', message.result);
        }
      } else {
        // Unknown message format - try to parse as trade anyway
        if (message.maker || message.taker || message.token_id) {
          await this.processTradeEvent(message, onTradeDetected);
        }
      }
    } catch (error: any) {
      console.error('[WebSocket] Error handling message:', error.message);
    }
  }

  /**
   * Process a trade event and convert it to DetectedTrade
   */
  private async processTradeEvent(
    tradeEvent: any,
    onTradeDetected: (trade: DetectedTrade) => void
  ): Promise<void> {
    try {
      // Extract trade information
      const maker = (tradeEvent.maker || '').toLowerCase();
      const taker = (tradeEvent.taker || '').toLowerCase();
      const tokenId = tradeEvent.token_id || tradeEvent.tokenId;
      const size = tradeEvent.size || tradeEvent.quantity || '0';
      const price = tradeEvent.price || tradeEvent.fill_price || '0';
      const side = tradeEvent.side || 'buy';
      const timestamp = tradeEvent.timestamp || tradeEvent.created_at || Date.now();

      // Determine which wallet made this trade (maker or taker)
      let walletAddress: string | null = null;
      let isFromTrackedWallet = false;

      // Check if maker is one of our tracked wallets
      if (this.trackedWallets.has(maker)) {
        walletAddress = maker;
        isFromTrackedWallet = true;
      }
      // Check if taker is one of our tracked wallets
      else if (this.trackedWallets.has(taker)) {
        walletAddress = taker;
        isFromTrackedWallet = true;
      }

      // If not found in tracked wallets, skip this trade
      if (!isFromTrackedWallet || !walletAddress) {
        return;
      }

      // Map proxy wallet back to EOA if possible
      let eoaAddress = walletAddress;
      for (const [eoa, proxy] of this.eoaToProxyMap.entries()) {
        if (proxy.toLowerCase() === walletAddress.toLowerCase()) {
          eoaAddress = eoa;
          break;
        }
      }

      console.log(`\n🔔 [WebSocket] TRADE DETECTED in real-time!`);
      console.log(`   Wallet: ${eoaAddress.substring(0, 8)}... (proxy: ${walletAddress.substring(0, 8)}...)`);
      console.log(`   Token ID: ${tokenId}`);
      console.log(`   Side: ${side.toUpperCase()}`);
      console.log(`   Size: ${size}`);
      console.log(`   Price: ${price}`);

      // Get market information to determine marketId and outcome
      let marketId: string | null = null;
      let outcome: 'YES' | 'NO' = 'YES';

      try {
        // Try to extract market ID from token ID
        // Polymarket token IDs are often in format: conditionId-outcomeIndex
        if (tokenId) {
          const parts = tokenId.split('-');
          if (parts.length >= 2) {
            marketId = parts.slice(0, -1).join('-');
            // Outcome is typically determined by the last part
            const outcomePart = parts[parts.length - 1];
            if (outcomePart === '1' || outcomePart.toLowerCase() === 'no') {
              outcome = 'NO';
            }
          } else {
            marketId = tokenId;
          }
        }

        // If we still don't have marketId, try to fetch it from the API
        if (!marketId || marketId === 'unknown') {
          // Try to get market info from token ID
          try {
            const market = await this.api.getMarket(tokenId);
            marketId = market.id || market.questionId || market.conditionId || tokenId;
            
            // Determine outcome from market structure
            if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
              const yesTokenId = market.clobTokenIds[0];
              const noTokenId = market.clobTokenIds[1];
              if (tokenId === noTokenId || tokenId === market.noTokenId) {
                outcome = 'NO';
              }
            }
          } catch (marketError: any) {
            console.warn(`[WebSocket] Could not fetch market info for ${tokenId}:`, marketError.message);
            // Use token ID as fallback
            marketId = tokenId;
          }
        }

        if (!marketId || marketId === 'unknown') {
          console.warn(`[WebSocket] ⚠️ Could not determine marketId for trade, skipping`);
          return;
        }

        // Validate price and size
        const priceNum = parseFloat(price || '0');
        const sizeNum = parseFloat(size || '0');

        if (!price || price === '0' || isNaN(priceNum) || priceNum <= 0 || priceNum > 1) {
          console.warn(`[WebSocket] ⚠️ Invalid price (${price}), skipping trade`);
          return;
        }

        if (!size || size === '0' || isNaN(sizeNum) || sizeNum <= 0) {
          console.warn(`[WebSocket] ⚠️ Invalid size (${size}), skipping trade`);
          return;
        }

        // Determine side (BUY/SELL)
        const tradeSide: 'BUY' | 'SELL' = side.toLowerCase() === 'sell' ? 'SELL' : 'BUY';

        // Create DetectedTrade
        const detectedTrade: DetectedTrade = {
          walletAddress: eoaAddress,
          marketId,
          outcome,
          amount: size.toString(),
          price: price.toString(),
          side: tradeSide,
          timestamp: new Date(timestamp),
          transactionHash: tradeEvent.tx_hash || tradeEvent.transaction_hash || tradeEvent.id || `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        };

        console.log(`[WebSocket] ✓ Valid trade detected: ${detectedTrade.side} ${detectedTrade.amount} @ ${detectedTrade.price} on ${detectedTrade.marketId} (${detectedTrade.outcome})`);
        
        // Trigger callback
        onTradeDetected(detectedTrade);

      } catch (error: any) {
        console.error('[WebSocket] Error processing trade event:', error.message);
      }
    } catch (error: any) {
      console.error('[WebSocket] Error in processTradeEvent:', error.message);
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(
    onTradeDetected: (trade: DetectedTrade) => void
  ): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 60000); // Max 60 seconds

    console.log(`[WebSocket] ⏳ Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect(onTradeDetected).catch(error => {
        console.error('[WebSocket] Reconnection failed:', error.message);
      });
    }, delay);
  }

  /**
   * Reload tracked wallets (called when wallets are added/removed)
   */
  async reloadWallets(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }

    console.log('[WebSocket] Reloading tracked wallets...');
    await this.loadTrackedWallets();

    // Re-subscribe if connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.subscribeToTrades();
    }
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    console.log('[WebSocket] Stopping WebSocket monitoring...');
    this.isMonitoring = false;
    this.isConnected = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    console.log('[WebSocket] WebSocket monitoring stopped');
  }

  /**
   * Get connection status
   */
  getStatus(): {
    isConnected: boolean;
    isMonitoring: boolean;
    lastConnectionTime: Date | null;
    trackedWalletsCount: number;
  } {
    return {
      isConnected: this.isConnected,
      isMonitoring: this.isMonitoring,
      lastConnectionTime: this.lastConnectionTime,
      trackedWalletsCount: this.trackedWallets.size
    };
  }

  /**
   * Get Polymarket API instance
   */
  getApi(): PolymarketApi {
    return this.api;
  }
}
