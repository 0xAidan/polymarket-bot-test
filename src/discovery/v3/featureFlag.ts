export function isDiscoveryV3Enabled(): boolean {
  return process.env.DISCOVERY_V3 === 'true';
}

/** CLOB V2 on-chain cutover — Goldsky subgraph 0.0.1 uses V1 OrderFilled shape. */
export const CLOB_V2_CUTOVER_MS = Date.parse('2026-04-28T00:00:00.000Z');

/**
 * Goldsky orderbook-subgraph/0.0.1 indexes V1-shaped OrderFilled events.
 * After the Apr 2026 V2 cutover, disable by default unless explicitly re-enabled.
 */
export function isDiscoveryV3GoldskyEnabled(): boolean {
  if (process.env.DISCOVERY_V3_GOLDSKY_ENABLED === 'true') {
    return true;
  }
  if (process.env.DISCOVERY_V3_GOLDSKY_ENABLED === 'false') {
    return false;
  }
  return Date.now() < CLOB_V2_CUTOVER_MS;
}

export function getDuckDBPath(): string {
  return process.env.DUCKDB_PATH || './data/discovery_v3.duckdb';
}

/** Hourly Polygon eth_getLogs forward-fill (default on when v3 enabled). */
export function isDiscoveryV3RpcPollEnabled(): boolean {
  if (process.env.DISCOVERY_V3_RPC_POLL_ENABLED === 'false') return false;
  if (process.env.DISCOVERY_V3_RPC_POLL_ENABLED === 'true') return true;
  return isDiscoveryV3Enabled();
}

export function getRpcPollIntervalMs(): number {
  const raw = Number(process.env.DISCOVERY_V3_RPC_POLL_INTERVAL_MS ?? 3_600_000);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 3_600_000;
}

export function getRpcPollBlockChunk(): number {
  const raw = Number(process.env.DISCOVERY_V3_RPC_BLOCK_CHUNK ?? 2_000);
  return Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : 2_000;
}

export function getRpcPollOverlapBlocks(): number {
  const raw = Number(process.env.DISCOVERY_V3_RPC_OVERLAP_BLOCKS ?? 100);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 100;
}

export function getRpcPollInitialLookbackBlocks(): number {
  const raw = Number(process.env.DISCOVERY_V3_RPC_INITIAL_LOOKBACK_BLOCKS ?? 1_800);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1_800;
}
