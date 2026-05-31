/**
 * Chain Listener
 *
 * Real-time on-chain event monitor using Alchemy WebSocket. Subscribes to
 * OrderFilled events on both CTF Exchange and NegRisk CTF Exchange contracts
 * via eth_subscribe. Parses maker/taker/amounts from log data using ethers.
 *
 * Detection latency: 2-3 seconds.
 * Auto-reconnects with exponential backoff on disconnect.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import {
  ALL_EXCHANGE_ADDRESSES,
  ORDER_FILLED_TOPIC0_V1,
  ORDER_FILLED_TOPIC0_V2,
  ORDER_FILLED_TOPIC0_ALL,
  ORDER_FILLED_DATA_TYPES_V1,
  ORDER_FILLED_DATA_TYPES_V2,
  DiscoveredTrade,
  OrderFilledEvent,
} from './types.js';
import { TradeIngestion } from './tradeIngestion.js';

const INITIAL_RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

export class ChainListener extends EventEmitter {
  private ws: WebSocket | null = null;
  private ingestion: TradeIngestion;
  private alchemyWsUrl: string;
  private running = false;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptionId: string | null = null;
  private reconnectCount = 0;
  private lastEventAt?: number;
  private rpcId = 1;

  constructor(ingestion: TradeIngestion, alchemyWsUrl: string) {
    super();
    this.ingestion = ingestion;
    this.alchemyWsUrl = alchemyWsUrl;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.alchemyWsUrl) {
      console.log('[ChainListener] No Alchemy WS URL configured, skipping');
      return;
    }
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.cleanup();
    console.log('[ChainListener] Stopped');
  }

  getStatus(): { connected: boolean; lastEventAt?: number; reconnectCount: number } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      lastEventAt: this.lastEventAt,
      reconnectCount: this.reconnectCount,
    };
  }

  updateUrl(url: string): void {
    this.alchemyWsUrl = url;
  }

  private connect(): void {
    if (!this.running || !this.alchemyWsUrl) return;
    this.cleanup();

    console.log('[ChainListener] Connecting to Alchemy WebSocket...');

    try {
      this.ws = new WebSocket(this.alchemyWsUrl);

      this.ws.on('open', () => {
        console.log('[ChainListener] Connected');
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this.emit('connected');
        this.subscribe();
        this.startPing();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          console.error('[ChainListener] Failed to parse message:', err);
        }
      });

      this.ws.on('close', () => {
        console.log('[ChainListener] Disconnected');
        this.subscriptionId = null;
        this.emit('disconnected');
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error('[ChainListener] WebSocket error:', err.message);
        this.emit('error', err);
      });
    } catch (err: any) {
      console.error('[ChainListener] Failed to create WebSocket:', err.message);
      this.scheduleReconnect();
    }
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const id = this.rpcId++;
    // Subscribe to BOTH V1 and V2 OrderFilled topic0s on ALL four exchange
    // addresses. The nested-array topics syntax is a logical OR per JSON-RPC
    // eth_subscribe filter spec — V1 contracts emit V1 topic0, V2 contracts
    // emit V2 topic0, and we want every fill regardless of source.
    const payload = {
      jsonrpc: '2.0',
      id,
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: ALL_EXCHANGE_ADDRESSES.map((a) => a.toLowerCase()),
          topics: [ORDER_FILLED_TOPIC0_ALL],
        },
      ],
    };

    this.ws.send(JSON.stringify(payload));
  }

  private handleMessage(msg: any): void {
    // Subscription confirmation
    if (msg.id && msg.result && typeof msg.result === 'string') {
      this.subscriptionId = msg.result;
      console.log(`[ChainListener] Subscribed to OrderFilled events (sub: ${this.subscriptionId})`);
      return;
    }

    // Subscription event
    if (msg.method === 'eth_subscription' && msg.params?.result) {
      const log = msg.params.result;
      this.handleLog(log);
      return;
    }
  }

  private handleLog(log: any): void {
    try {
      const event = this.parseOrderFilledLog(log);
      if (!event) return;

      this.lastEventAt = Date.now();

      const makerAmountRaw = parseFloat(event.makerAmountFilled);
      const takerAmountRaw = parseFloat(event.takerAmountFilled);

      // Normalize to (side, conditionalTokenId, usdcAmount, tokenAmount).
      // V1 and V2 events carry the same information in different shapes:
      //   V1: makerAssetId == "0" → maker is providing collateral (BUY)
      //   V2: explicit `side` flag (0 = BUY, 1 = SELL) + single `tokenId`
      let side: 'BUY' | 'SELL';
      let conditionalTokenId: string;
      let usdcAmount: number;
      let tokenAmount: number;

      if (event.version === 'v2') {
        // V2: maker pays in pUSD on BUY, in conditional tokens on SELL.
        // makerAmountFilled is always the maker-side amount, taker the inverse.
        const isBuy = event.side === 0;
        side = isBuy ? 'BUY' : 'SELL';
        conditionalTokenId = event.tokenId ?? '0';
        usdcAmount = isBuy ? makerAmountRaw : takerAmountRaw;
        tokenAmount = isBuy ? takerAmountRaw : makerAmountRaw;
      } else {
        const makerIsUsdcSide = event.makerAssetId === '0';
        side = makerIsUsdcSide ? 'BUY' : 'SELL';
        conditionalTokenId = (makerIsUsdcSide ? event.takerAssetId : event.makerAssetId) ?? '0';
        usdcAmount = makerIsUsdcSide ? makerAmountRaw : takerAmountRaw;
        tokenAmount = makerIsUsdcSide ? takerAmountRaw : makerAmountRaw;
      }

      const shares = tokenAmount / 1e6;
      const notionalUsd = usdcAmount / 1e6; // USDC/pUSD both 6 decimals
      const price = tokenAmount > 0 ? usdcAmount / tokenAmount : undefined;
      const logSuffix = log.logIndex || log.transactionIndex || '0';
      const eventKey = `${event.transactionHash}:${logSuffix}`;

      const trade: DiscoveredTrade = {
        txHash: eventKey,
        eventKey,
        maker: event.maker.toLowerCase(),
        taker: event.taker.toLowerCase(),
        assetId: conditionalTokenId,
        side,
        size: shares,
        price,
        notionalUsd,
        fee: parseFloat(event.fee) / 1e6,
        source: 'chain',
        detectedAt: Date.now(),
        blockNumber: event.blockNumber,
      };

      this.ingestion.ingest(trade).catch((err) => {
        console.error('[ChainListener] Ingestion error:', err);
      });

      this.emit('trade', trade);
    } catch (err) {
      console.error('[ChainListener] Failed to parse log:', err);
    }
  }

  private parseOrderFilledLog(log: any): OrderFilledEvent | null {
    return parseOrderFilledLog(log);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    this.reconnectCount++;
    console.log(`[ChainListener] Reconnecting in ${this.reconnectDelay / 1000}s (attempt ${this.reconnectCount})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private cleanup(): void {
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.subscriptionId = null;
  }
}

/**
 * Decode a raw eth_getLogs / eth_subscription log into a normalized
 * OrderFilledEvent. Pure function, exported for unit testing. Returns null
 * for logs whose topic0 doesn't match either V1 or V2 OrderFilled.
 */
export function parseOrderFilledLog(log: any): OrderFilledEvent | null {
  if (!log.topics || log.topics.length < 4) return null;

  const topic0 = (log.topics[0] || '').toLowerCase();
  const orderHash = log.topics[1];
  const maker = '0x' + log.topics[2].slice(26);
  const taker = '0x' + log.topics[3].slice(26);

  const baseFields = {
    orderHash,
    maker,
    taker,
    blockNumber: parseInt(log.blockNumber, 16),
    transactionHash: log.transactionHash,
    contractAddress: log.address,
  };

  if (topic0 === ORDER_FILLED_TOPIC0_V2.toLowerCase()) {
    const decoded = ethers.utils.defaultAbiCoder.decode(ORDER_FILLED_DATA_TYPES_V2, log.data);
    const sideRaw = Number(decoded[0]);
    const side: 0 | 1 = sideRaw === 0 ? 0 : 1;
    return {
      version: 'v2',
      ...baseFields,
      side,
      tokenId: decoded[1].toString(),
      makerAmountFilled: decoded[2].toString(),
      takerAmountFilled: decoded[3].toString(),
      fee: decoded[4].toString(),
      builder: decoded[5],
      metadata: decoded[6],
    };
  }

  if (topic0 === ORDER_FILLED_TOPIC0_V1.toLowerCase()) {
    const decoded = ethers.utils.defaultAbiCoder.decode(ORDER_FILLED_DATA_TYPES_V1, log.data);
    return {
      version: 'v1',
      ...baseFields,
      makerAssetId: decoded[0].toString(),
      takerAssetId: decoded[1].toString(),
      makerAmountFilled: decoded[2].toString(),
      takerAmountFilled: decoded[3].toString(),
      fee: decoded[4].toString(),
    };
  }

  // Unknown topic0 — drop silently rather than crash; a stray subscription
  // hit on an event we don't model is a non-fatal upstream provider quirk.
  return null;
}
