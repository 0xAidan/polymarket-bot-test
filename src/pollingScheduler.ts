/**
 * pollingScheduler.ts
 *
 * Promise-pool based wallet monitor scheduler.
 *
 * Key improvements over serial setInterval:
 *   - All wallets polled concurrently (up to MAX_CONCURRENT)
 *   - Per-wallet error counter with exponential backoff (max 5 min)
 *   - One slow wallet cannot delay detection of a trade from another wallet
 *   - Graceful shutdown via AbortSignal
 */
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('PollingScheduler');

export interface PollingStats {
  totalCycles: number;
  totalErrors: number;
  lastCycleDurationMs: number;
  walletErrorCounts: Record<string, number>;
}

export type WalletPollFn = (walletAddress: string) => Promise<void>;
export type ActiveWalletsFn = () => string[];

const DEFAULT_MAX_CONCURRENT = 5;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000; // 5 minutes

function backoffMs(errorCount: number): number {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, errorCount - 1), MAX_BACKOFF_MS);
}

export class PollingScheduler {
  private running = false;
  private abortController: AbortController | null = null;
  private readonly walletErrors = new Map<string, number>();
  private readonly walletNextAllowed = new Map<string, number>();
  private readonly stats: PollingStats = {
    totalCycles: 0,
    totalErrors: 0,
    lastCycleDurationMs: 0,
    walletErrorCounts: {},
  };

  constructor(
    private readonly intervalMs: number,
    private readonly getActiveWallets: ActiveWalletsFn,
    private readonly pollWallet: WalletPollFn,
    private readonly maxConcurrent: number = parseInt(
      process.env.MONITOR_CONCURRENCY ?? String(DEFAULT_MAX_CONCURRENT),
      10
    ),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.scheduleNextCycle(this.abortController.signal);
    log.info({ intervalMs: this.intervalMs, maxConcurrent: this.maxConcurrent }, 'PollingScheduler started');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    log.info('PollingScheduler stopped');
  }

  getStats(): PollingStats {
    return {
      ...this.stats,
      walletErrorCounts: Object.fromEntries(this.walletErrors),
    };
  }

  private scheduleNextCycle(signal: AbortSignal): void {
    const timer = setTimeout(async () => {
      if (signal.aborted) return;
      await this.runCycle(signal);
      if (!signal.aborted) {
        this.scheduleNextCycle(signal);
      }
    }, this.intervalMs);
    // Allow process to exit even if timer is pending
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }
  }

  private async runCycle(signal: AbortSignal): Promise<void> {
    const wallets = this.getActiveWallets();
    if (wallets.length === 0) return;

    const now = Date.now();
    const eligible = wallets.filter(
      addr => (this.walletNextAllowed.get(addr) ?? 0) <= now
    );
    if (eligible.length === 0) return;

    const cycleStart = Date.now();
    this.stats.totalCycles++;

    // Promise pool: at most maxConcurrent in-flight
    const queue = [...eligible];
    const inFlight = new Set<Promise<void>>();

    const next = async (): Promise<void> => {
      const addr = queue.shift();
      if (!addr || signal.aborted) return;

      const p = (async () => {
        try {
          await this.pollWallet(addr);
          this.walletErrors.delete(addr);
          this.walletNextAllowed.delete(addr);
        } catch (err: any) {
          const errCount = (this.walletErrors.get(addr) ?? 0) + 1;
          this.walletErrors.set(addr, errCount);
          this.stats.totalErrors++;
          const delay = backoffMs(errCount);
          this.walletNextAllowed.set(addr, Date.now() + delay);
          log.warn(
            { addr, errCount, backoffMs: delay, err: err?.message },
            'Wallet poll error — backing off'
          );
        }
      })();

      inFlight.add(p);
      p.finally(() => {
        inFlight.delete(p);
      });

      // Kick off the next job when capacity frees up
      if (queue.length > 0 && inFlight.size < this.maxConcurrent) {
        next().catch(() => {});
      }
    };

    // Seed up to maxConcurrent workers
    const seedCount = Math.min(this.maxConcurrent, eligible.length);
    for (let i = 0; i < seedCount; i++) {
      next().catch(() => {});
    }

    // Wait for all in-flight to settle
    while (inFlight.size > 0) {
      await Promise.race(inFlight);
    }

    this.stats.lastCycleDurationMs = Date.now() - cycleStart;

    if (eligible.length > 0) {
      log.debug(
        { walletCount: eligible.length, durationMs: this.stats.lastCycleDurationMs },
        'Poll cycle complete'
      );
    }
  }
}
