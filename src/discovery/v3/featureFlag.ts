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
