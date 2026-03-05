/**
 * Trade Ingestion
 *
 * Unified intake for trades from both the chain listener and the API poller.
 * Deduplicates by transactionHash, triggers enrichment, persists to SQLite,
 * and emits events for downstream consumers (signal engine in Phase 3b).
 */

import { EventEmitter } from 'events';
import { DiscoveredTrade } from './types.js';
import {
  insertTradeBatch,
  upsertWallet,
  tradeExistsByHash,
  tradeExistsByEventKey,
  getWalletStats,
  refreshWalletStats,
  aggregateWalletPnL,
} from './statsStore.js';
import { enrichTrade, resolveWalletPseudonym } from './tradeEnricher.js';
import { getDatabase } from '../database.js';
import { updatePosition } from './positionTracker.js';
import { evaluateTradeSignals } from './signalEngine.js';
import { computeScoresAndHeat } from './walletScorer.js';

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

  resetState(): void {
    this.pendingBatch = [];
    this.dedupSet.clear();
    this.dedupQueue = [];
  }

  /**
   * Submit a trade for ingestion. Returns true if the trade is new
   * (not a duplicate), false if it was already seen.
   */
  async ingest(trade: DiscoveredTrade): Promise<boolean> {
    if (!this.running) return false;
    const dedupKey = trade.eventKey || trade.txHash;

    // Level 1 dedup: in-memory set (fast)
    if (this.dedupSet.has(dedupKey)) return false;

    // Level 2 dedup: DB check (catches restarts)
    if ((trade.eventKey && tradeExistsByEventKey(trade.eventKey)) || tradeExistsByHash(trade.txHash)) {
      this.addToDedup(dedupKey);
      return false;
    }

    this.addToDedup(dedupKey);

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
        for (const address of getTradeParticipantAddresses(t)) {
          if (!walletsSeen.has(address)) {
            walletsSeen.add(address);
            upsertWallet(address, t.detectedAt);
          }
        }
      }

      try {
        const skippedForPosition: Record<string, number> = {
          missingConditionId: 0,
          missingAssetId: 0,
          invalidSide: 0,
          invalidPrice: 0,
          invalidSize: 0,
        };
        for (const t of batch) {
          for (const trackedTrade of buildPositionTrackingTrades(t)) {
            const skipReason = this.getPositionSkipReason(trackedTrade);
            if (!skipReason) {
              updatePosition(trackedTrade);
            } else {
              skippedForPosition[skipReason]++;
            }
          }
        }

        const totalSkipped = Object.values(skippedForPosition).reduce((sum, count) => sum + count, 0);
        if (totalSkipped > 0) {
          console.log(
            `[Ingestion] Position updates skipped=${totalSkipped} ` +
            `(missingConditionId=${skippedForPosition.missingConditionId}, ` +
            `missingAssetId=${skippedForPosition.missingAssetId}, ` +
            `invalidSide=${skippedForPosition.invalidSide}, ` +
            `invalidPrice=${skippedForPosition.invalidPrice}, ` +
            `invalidSize=${skippedForPosition.invalidSize})`
          );
        }
      } catch (err) {
        console.error('[Ingestion] Position tracking error:', err);
      }

      try {
        aggregateWalletPnL();
        refreshWalletStats([...walletsSeen]);
        computeScoresAndHeat();

        for (const t of batch) {
          for (const signalTrade of buildSignalEvaluationTrades(t)) {
            const walletStats = getWalletStats(signalTrade.maker);
            if (walletStats) {
              evaluateTradeSignals(signalTrade, walletStats);
            }
          }
        }
      } catch (err) {
        console.error('[Ingestion] Signal evaluation error:', err);
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
    const updatePseudonym = (address: string, pseudo: string) => {
      try {
        const db = getDatabase();
        db.prepare('UPDATE discovery_wallets SET pseudonym = ? WHERE address = ? AND pseudonym IS NULL')
          .run(pseudo, address);
      } catch { /* best-effort */ }
    };

    resolveWalletPseudonym(maker).then((pseudo) => {
      if (pseudo) updatePseudonym(maker, pseudo);
    }).catch(() => {});

    if (taker) {
      resolveWalletPseudonym(taker).then((pseudo) => {
        if (pseudo) updatePseudonym(taker, pseudo);
      }).catch(() => {});
    }
  }

  private getPositionSkipReason(
    trade: Pick<DiscoveredTrade, 'conditionId' | 'assetId' | 'side' | 'price' | 'size'>
  ): 'missingConditionId' | 'missingAssetId' | 'invalidSide' | 'invalidPrice' | 'invalidSize' | null {
    if (!trade.conditionId) return 'missingConditionId';
    if (!trade.assetId) return 'missingAssetId';
    if (trade.side !== 'BUY' && trade.side !== 'SELL') return 'invalidSide';
    if (!Number.isFinite(trade.price) || (trade.price as number) <= 0) return 'invalidPrice';
    if (!Number.isFinite(trade.size) || trade.size <= 0) return 'invalidSize';
    return null;
  }
}

export const getTradeParticipantAddresses = (
  trade: Pick<DiscoveredTrade, 'maker' | 'taker'>
): string[] => {
  const maker = String(trade.maker || '').trim().toLowerCase();
  return maker ? [maker] : [];
};

export const buildSignalEvaluationTrades = (trade: DiscoveredTrade): DiscoveredTrade[] => {
  return [trade];
};

export const buildPositionTrackingTrades = (trade: DiscoveredTrade): DiscoveredTrade[] => {
  return [trade];
};
