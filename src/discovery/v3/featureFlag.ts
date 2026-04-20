export function isDiscoveryV3Enabled(): boolean {
  return process.env.DISCOVERY_V3 === 'true';
}

export function getDuckDBPath(): string {
  return process.env.DUCKDB_PATH || './data/discovery_v3.duckdb';
}
