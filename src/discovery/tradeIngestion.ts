/**
 * Trade Ingestion
 *
 * Unified intake for trades from both the chain listener and the API poller.
 * Deduplicates by transactionHash, triggers enrichment, persists to SQLite,
 * and emits events for downstream consumers (signal engine in Phase 3b).
 */

import { EventEmitter } from 'events';
import { DiscoveredTrade } from './types.js';
import { insertTradeBatch, upsertWallet, tradeExistsByHash } from './statsStore.js';
import { enrichTrade, resolveWalletPseudonym } from './tradeEnricher.js';

const DEDUP_SET_MAX = 50_000;
const BATCH_FLUSH_INTERVAL_MS = 2_000;

export class TradeIngestion extends EventEmitter {
  private dedupSet = new Set<string>();
  private dedupQueue: string[] = []; // FIFO for eviction
  private pendingBatch: DiscoveredTrade[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.flushTimer = setInterval(() => this.flush(), BATCH_FLUSH_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /**
   * Submit a trade for ingestion. Returns true if the trade is new
   * (not a duplicate), false if it was already seen.
   */
  async ingest(trade: DiscoveredTrade): Promise<boolean> {
    if (!this.running) return false;

    // Level 1 dedup: in-memory set (fast)
    if (this.dedupSet.has(trade.txHash)) return false;

    // Level 2 dedup: DB check (catches restarts)
    if (tradeExistsByHash(trade.txHash)) {
      this.addToDedup(trade.txHash);
      return false;
    }

    this.addToDedup(trade.txHash);

    // Enrich (non-blocking, best-effort)
    const enriched = await enrichTrade(trade);

    this.pendingBatch.push(enriched);

    // Resolve pseudonyms in background (don't block ingestion)
    this.resolveWalletsAsync(enriched.maker, enriched.taker);

    this.emit('newTrade', enriched);
    return true;
  }

  /**
   * Submit multiple trades at once (e.g. from API polling batch).
   */
  async ingestBatch(trades: DiscoveredTrade[]): Promise<number> {
    let newCount = 0;
    for (const trade of trades) {
      const isNew = await this.ingest(trade);
      if (isNew) newCount++;
    }
    return newCount;
  }

  private flush(): void {
    if (this.pendingBatch.length === 0) return;

    const batch = this.pendingBatch.splice(0);
    try {
      const inserted = insertTradeBatch(batch);

      // Upsert wallet records for all unique addresses
      const walletsSeen = new Set<string>();
      for (const t of batch) {
        if (!walletsSeen.has(t.maker)) {
          walletsSeen.add(t.maker);
          upsertWallet(t.maker, t.detectedAt);
        }
        if (!walletsSeen.has(t.taker)) {
          walletsSeen.add(t.taker);
          upsertWallet(t.taker, t.detectedAt);
        }
      }

      if (inserted > 0) {
        this.emit('flushed', { inserted, total: batch.length });
      }
    } catch (err) {
      console.error('[Ingestion] Batch insert failed:', err);
      this.emit('error', err);
    }
  }

  private addToDedup(hash: string): void {
    this.dedupSet.add(hash);
    this.dedupQueue.push(hash);

    // Evict oldest entries when over limit
    while (this.dedupSet.size > DEDUP_SET_MAX) {
      const oldest = this.dedupQueue.shift();
      if (oldest) this.dedupSet.delete(oldest);
    }
  }

  private resolveWalletsAsync(maker: string, taker: string): void {
    resolveWalletPseudonym(maker).then((pseudo) => {
      if (pseudo) {
        try {
          const { getDatabase } = require('../database.js');
          const db = getDatabase();
          db.prepare('UPDATE discovery_wallets SET pseudonym = ? WHERE address = ? AND pseudonym IS NULL')
            .run(pseudo, maker);
        } catch { /* best-effort */ }
      }
    }).catch(() => {});

    resolveWalletPseudonym(taker).then((pseudo) => {
      if (pseudo) {
        try {
          const { getDatabase } = require('../database.js');
          const db = getDatabase();
          db.prepare('UPDATE discovery_wallets SET pseudonym = ? WHERE address = ? AND pseudonym IS NULL')
            .run(pseudo, taker);
        } catch { /* best-effort */ }
      }
    }).catch(() => {});
  }
}
