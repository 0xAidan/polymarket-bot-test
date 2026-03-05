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
  CTF_EXCHANGE_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  ORDER_FILLED_TOPIC0,
  ORDER_FILLED_DATA_TYPES,
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
    const payload = {
      jsonrpc: '2.0',
      id,
      method: 'eth_subscribe',
      params: [
        'logs',
        {
          address: [
            CTF_EXCHANGE_ADDRESS.toLowerCase(),
            NEG_RISK_CTF_EXCHANGE_ADDRESS.toLowerCase(),
          ],
          topics: [ORDER_FILLED_TOPIC0],
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

      // makerAssetId "0" means the maker is providing USDC (collateral) = BUY
      // Otherwise the maker is providing conditional tokens = SELL
      const makerIsUsdcSide = event.makerAssetId === '0';

      const usdcAmount = makerIsUsdcSide ? makerAmountRaw : takerAmountRaw;
      const tokenAmount = makerIsUsdcSide ? takerAmountRaw : makerAmountRaw;
      const conditionalTokenId = makerIsUsdcSide ? event.takerAssetId : event.makerAssetId;

      const side = makerIsUsdcSide ? 'BUY' : 'SELL';
      const shares = tokenAmount / 1e6;
      const notionalUsd = usdcAmount / 1e6; // USDC has 6 decimals
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
    if (!log.topics || log.topics.length < 4) return null;

    const orderHash = log.topics[1];
    const maker = '0x' + log.topics[2].slice(26);
    const taker = '0x' + log.topics[3].slice(26);

    const decoded = ethers.utils.defaultAbiCoder.decode(ORDER_FILLED_DATA_TYPES, log.data);

    return {
      orderHash,
      maker,
      taker,
      makerAssetId: decoded[0].toString(),
      takerAssetId: decoded[1].toString(),
      makerAmountFilled: decoded[2].toString(),
      takerAmountFilled: decoded[3].toString(),
      fee: decoded[4].toString(),
      blockNumber: parseInt(log.blockNumber, 16),
      transactionHash: log.transactionHash,
      contractAddress: log.address,
    };
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
