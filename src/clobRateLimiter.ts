type PendingRequest = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
};

export interface ClobRateLimiterOptions {
  burstLimit?: number;
  burstWindowMs?: number;
  sustainedLimit?: number;
  sustainedWindowMs?: number;
  maxConcurrentPerTenant?: number;
}

const DEFAULT_OPTIONS: Required<ClobRateLimiterOptions> = {
  burstLimit: 3500,
  burstWindowMs: 10_000,
  sustainedLimit: 36_000,
  sustainedWindowMs: 600_000,
  maxConcurrentPerTenant: 5,
};

export class ClobRateLimiter {
  private readonly options: Required<ClobRateLimiterOptions>;
  private readonly burstTimestamps: number[] = [];
  private readonly sustainedTimestamps: number[] = [];
  private readonly pendingByTenant = new Map<string, PendingRequest[]>();
  private readonly tenantOrder: string[] = [];
  private readonly inFlightByTenant = new Map<string, number>();
  private dispatchTimer: NodeJS.Timeout | null = null;

  constructor(options: ClobRateLimiterOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async acquire(tenantId: string): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const queue = this.pendingByTenant.get(tenantId) ?? [];
      queue.push({ resolve, reject });
      this.pendingByTenant.set(tenantId, queue);
      if (!this.tenantOrder.includes(tenantId)) {
        this.tenantOrder.push(tenantId);
      }
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.dispatchTimer) {
      return;
    }

    const now = Date.now();
    this.pruneTimestamps(now);

    const nextTenant = this.pickNextTenant();
    if (!nextTenant) {
      return;
    }

    if (!this.canGrant(now)) {
      this.scheduleNextDispatch(now);
      return;
    }

    const queue = this.pendingByTenant.get(nextTenant);
    const request = queue?.shift();
    if (!request) {
      this.pendingByTenant.delete(nextTenant);
      this.dispatch();
      return;
    }

    if (queue && queue.length === 0) {
      this.pendingByTenant.delete(nextTenant);
    }

    this.burstTimestamps.push(now);
    this.sustainedTimestamps.push(now);
    this.inFlightByTenant.set(nextTenant, (this.inFlightByTenant.get(nextTenant) ?? 0) + 1);

    request.resolve(() => {
      const nextCount = Math.max(0, (this.inFlightByTenant.get(nextTenant) ?? 1) - 1);
      if (nextCount === 0) {
        this.inFlightByTenant.delete(nextTenant);
      } else {
        this.inFlightByTenant.set(nextTenant, nextCount);
      }
      this.dispatch();
    });

    this.dispatch();
  }

  private pickNextTenant(): string | null {
    if (this.tenantOrder.length === 0) {
      return null;
    }

    for (let i = 0; i < this.tenantOrder.length; i += 1) {
      const tenantId = this.tenantOrder.shift()!;
      const queue = this.pendingByTenant.get(tenantId);
      if (!queue || queue.length === 0) {
        continue;
      }

      this.tenantOrder.push(tenantId);

      const inFlight = this.inFlightByTenant.get(tenantId) ?? 0;
      if (inFlight < this.options.maxConcurrentPerTenant) {
        return tenantId;
      }
    }

    return null;
  }

  private canGrant(now: number): boolean {
    this.pruneTimestamps(now);
    return (
      this.burstTimestamps.length < this.options.burstLimit &&
      this.sustainedTimestamps.length < this.options.sustainedLimit
    );
  }

  private pruneTimestamps(now: number): void {
    while (this.burstTimestamps.length > 0 && now - this.burstTimestamps[0] >= this.options.burstWindowMs) {
      this.burstTimestamps.shift();
    }
    while (this.sustainedTimestamps.length > 0 && now - this.sustainedTimestamps[0] >= this.options.sustainedWindowMs) {
      this.sustainedTimestamps.shift();
    }
  }

  private scheduleNextDispatch(now: number): void {
    const burstWait = this.burstTimestamps.length >= this.options.burstLimit
      ? Math.max(1, this.options.burstWindowMs - (now - this.burstTimestamps[0]))
      : 0;
    const sustainedWait = this.sustainedTimestamps.length >= this.options.sustainedLimit
      ? Math.max(1, this.options.sustainedWindowMs - (now - this.sustainedTimestamps[0]))
      : 0;
    const waitMs = Math.max(1, Math.min(
      burstWait || Number.POSITIVE_INFINITY,
      sustainedWait || Number.POSITIVE_INFINITY,
    ));

    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      this.dispatch();
    }, Number.isFinite(waitMs) ? waitMs : 1);
  }
}

export const clobRateLimiter = new ClobRateLimiter();
