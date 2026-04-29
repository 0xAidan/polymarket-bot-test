/**
 * Promotion gate for discovery v3.
 *
 * This script intentionally separates:
 * - hard integrity failures (must block promotion)
 * - coverage-aware API deltas (warnings, not blockers for known source gaps)
 */
import Database from 'better-sqlite3';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { validateWalletAgainstDataApi } from '../../src/discovery/v3/dataApiValidator.js';

interface DuckCount {
  c: number;
}

interface SnapshotWalletRow {
  proxy_wallet: string;
  volume_total: number;
  trade_count: number;
}

const getSqlitePath = (): string => {
  const dataDir = process.env.DATA_DIR || './data';
  return `${dataDir}/copytrade.db`;
};

async function main(): Promise<void> {
  const duck = openDuckDB(getDuckDBPath());
  const sqlite = new Database(getSqlitePath(), { readonly: true });
  const failures: string[] = [];

  try {
    const [dupeGroups] = await duck.query<DuckCount>(
      `SELECT COUNT(*)::BIGINT AS c
       FROM (
         SELECT tx_hash, log_index, COUNT(*) AS cnt
         FROM discovery_activity_v3
         GROUP BY 1,2
         HAVING COUNT(*) > 1
       ) t`
    );
    if (Number(dupeGroups?.c ?? 0) > 0) {
      failures.push(`duplicate (tx_hash,log_index) groups detected: ${dupeGroups.c}`);
    }

    const [badWalletRows] = await duck.query<DuckCount>(
      `SELECT COUNT(*)::BIGINT AS c
       FROM discovery_activity_v3
       WHERE proxy_wallet = 'duckdb'`
    );
    if (Number(badWalletRows?.c ?? 0) > 0) {
      failures.push(`corruption sentinel rows (proxy_wallet='duckdb'): ${badWalletRows.c}`);
    }

    const [snapshotRows] = await duck.query<DuckCount>(
      'SELECT COUNT(*)::BIGINT AS c FROM discovery_feature_snapshots_v3'
    );
    if (Number(snapshotRows?.c ?? 0) === 0) {
      failures.push('snapshot table is empty: discovery_feature_snapshots_v3');
    }

    const tiers = sqlite
      .prepare('SELECT tier, COUNT(*) AS c FROM discovery_wallet_scores_v3 GROUP BY tier')
      .all() as Array<{ tier: string; c: number }>;
    const tierMap = new Map(tiers.map((row) => [row.tier, Number(row.c)]));
    for (const required of ['alpha', 'whale', 'specialist']) {
      if (!tierMap.has(required) || Number(tierMap.get(required)) <= 0) {
        failures.push(`missing or empty tier in sqlite read model: ${required}`);
      }
    }

    const walletSample = await duck.query<SnapshotWalletRow>(
      `WITH latest AS (
         SELECT * FROM (
           SELECT *,
                  ROW_NUMBER() OVER (PARTITION BY proxy_wallet ORDER BY snapshot_day DESC) AS rn
           FROM discovery_feature_snapshots_v3
         ) t WHERE rn = 1
       )
       SELECT proxy_wallet, volume_total, trade_count
       FROM latest
       ORDER BY volume_total DESC
       LIMIT 5`
    );

    let coverageWarnings = 0;
    for (const wallet of walletSample) {
      const result = await validateWalletAgainstDataApi(wallet.proxy_wallet, {
        trade_count: Number(wallet.trade_count),
        volume_total: Number(wallet.volume_total),
      });
      if (!result.ok) {
        coverageWarnings++;
      }
      const status = result.ok ? 'OK' : 'WARN';
      const capped = result.apiFullyPaginated === false ? ' [api-capped]' : '';
      console.log(
        `[06-gate] ${wallet.proxy_wallet} ${status}${capped} ${result.reason ?? ''}`
      );
    }

    console.log('[06-gate] integrity summary', {
      dupeGroups: Number(dupeGroups?.c ?? 0),
      badWalletRows: Number(badWalletRows?.c ?? 0),
      snapshotRows: Number(snapshotRows?.c ?? 0),
      tiers: Object.fromEntries(tierMap.entries()),
      coverageWarnings,
    });

    if (failures.length > 0) {
      console.error('[06-gate] BLOCKED: integrity failures detected');
      for (const failure of failures) {
        console.error(` - ${failure}`);
      }
      process.exitCode = 2;
      return;
    }

    console.log(
      '[06-gate] PASS: integrity checks succeeded. Coverage warnings are informational under the known-gap policy.'
    );
  } finally {
    sqlite.close();
    await duck.close();
  }
}

main().catch((err) => {
  console.error('[06-gate] failed:', err);
  process.exit(1);
});
