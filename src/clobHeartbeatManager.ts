/**
 * Keeps CLOB trading sessions alive while copy trading is running.
 *
 * Polymarket cancels all open resting orders if POST /v1/heartbeats is not
 * received within ~10 seconds. Copy trades use GTC limit orders that may rest
 * on the book briefly, so we ping every active CLOB client on an interval.
 */
import { PolymarketClobClient } from './clobClient.js';
import { createComponentLogger } from './logger.js';
import { getCachedClobClients } from './clobClientFactory.js';

const log = createComponentLogger('ClobHeartbeat');

/** 7s — safely under Polymarket's ~10s session timeout. */
const HEARTBEAT_INTERVAL_MS = 7_000;

const extraClients = new Set<PolymarketClobClient>();
let interval: NodeJS.Timeout | null = null;

export const registerClobClientForHeartbeat = (client: PolymarketClobClient): void => {
  extraClients.add(client);
};

export const unregisterClobClientForHeartbeat = (client: PolymarketClobClient): void => {
  extraClients.delete(client);
};

const collectClients = (): PolymarketClobClient[] => {
  const seen = new Set<PolymarketClobClient>();
  for (const client of getCachedClobClients()) {
    seen.add(client);
  }
  for (const client of extraClients) {
    seen.add(client);
  }
  return [...seen];
};

const tick = async (): Promise<void> => {
  const clients = collectClients();
  if (clients.length === 0) {
    return;
  }

  await Promise.all(
    clients.map(async (client) => {
      try {
        await client.postHeartbeat();
      } catch (err: any) {
        log.warn(
          { err: err?.message ?? String(err) },
          'CLOB heartbeat failed — resting orders may be cancelled if this persists',
        );
      }
    }),
  );
};

export const startClobHeartbeatManager = (): void => {
  if (interval) {
    return;
  }
  log.info(`Starting CLOB heartbeat manager (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
  void tick();
  interval = setInterval(() => {
    void tick();
  }, HEARTBEAT_INTERVAL_MS);
};

export const stopClobHeartbeatManager = (): void => {
  if (!interval) {
    return;
  }
  clearInterval(interval);
  interval = null;
  log.info('Stopped CLOB heartbeat manager');
};
