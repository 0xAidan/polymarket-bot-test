/**
 * Promotion gate for discovery v3.
 *
 * Hard integrity failures block promotion. Golden-wallet display checks
 * compare pipeline stats to Polymarket reference APIs (fail-closed).
 */
import Database from 'better-sqlite3';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import {
  validateWalletAgainstDataApi,
  validateWalletPromotionGate,
} from '../../src/discovery/v3/dataApiValidator.js';

interface DuckCount {
  c: number;
}

interface SnapshotWalletRow {
  proxy_wallet: string;
  volume_total: number;
  trade_count: number;
  realized_pnl: number;
}

/** Acceptance wallets — must match Polymarket profile ballpark after clean harvest. */
const GOLDEN_WALLETS: Array<{ label: string; address: string }> = [
  { label: 'Amber Falcon / dvisik', address: '0x2055b6a642839e86644d381c619aabc0afec1d9d' },
  { label: 'Amber Hare / c000OLI0003', address: '0xfedc381bf3fb5d20433bb4a0216b15dbbc5c6398' },
];

const getSqlitePath = (): string => {
  const dataDir = process.env.DATA_DIR || './data';
  return `${dataDir}/copytrade.db`;
};

async function main(): Promise<void> {
  const duck = await openDuckDB(getDuckDBPath());
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
       SELECT proxy_wallet, volume_total, trade_count, realized_pnl
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
      if (!result.ok) coverageWarnings++;
      const status = result.ok ? 'OK' : 'WARN';
      const capped = result.apiFullyPaginated === false ? ' [api-capped]' : '';
      console.log(
        `[06-gate] sample ${wallet.proxy_wallet} ${status}${capped} ${result.reason ?? ''}`
      );
    }

    console.log('[06-gate] alpha tier display checks (published SQLite)…');
    const alphaRows = sqlite
      .prepare(
        `SELECT proxy_wallet, volume_total, trade_count, realized_pnl, predictions_count
         FROM discovery_wallet_scores_v3
         WHERE tier = 'alpha'
         ORDER BY tier_rank ASC
         LIMIT 25`
      )
      .all() as Array<{
      proxy_wallet: string;
      volume_total: number;
      trade_count: number;
      realized_pnl: number;
      predictions_count: number | null;
    }>;

    for (const row of alphaRows) {
      const gate = await validateWalletPromotionGate(row.proxy_wallet, {
        volume_total: Number(row.volume_total),
        trade_count: Number(row.trade_count),
        realized_pnl: Number(row.realized_pnl),
      });
      const status = gate.ok ? 'PASS' : 'FAIL';
      console.log(
        `[06-gate] alpha rank sample ${row.proxy_wallet} ${status} ` +
          `pnl=${row.realized_pnl} vol=${row.volume_total} fills=${row.trade_count} ` +
          `pred=${row.predictions_count ?? 'n/a'} ${gate.reason ?? ''}`
      );
      if (!gate.ok) {
        failures.push(`alpha tier ${row.proxy_wallet}: ${gate.reason ?? 'promotion gate failed'}`);
      }
    }

    console.log('[06-gate] golden wallet display checks…');
    for (const golden of GOLDEN_WALLETS) {
      const addr = golden.address.toLowerCase();
      const [snap] = await duck.query<SnapshotWalletRow>(
        `WITH latest AS (
           SELECT * FROM (
             SELECT *,
                    ROW_NUMBER() OVER (PARTITION BY proxy_wallet ORDER BY snapshot_day DESC) AS rn
             FROM discovery_feature_snapshots_v3
           ) t WHERE rn = 1
         )
         SELECT proxy_wallet, volume_total, trade_count, realized_pnl
         FROM latest WHERE LOWER(proxy_wallet) = '${addr}'`
      );
      if (!snap) {
        failures.push(`${golden.label}: no snapshot row for ${addr}`);
        continue;
      }
      const gate = await validateWalletPromotionGate(addr, {
        volume_total: Number(snap.volume_total),
        trade_count: Number(snap.trade_count),
        realized_pnl: Number(snap.realized_pnl),
      });
      const status = gate.ok ? 'PASS' : 'FAIL';
      console.log(
        `[06-gate] golden ${golden.label} ${status} vol=${snap.volume_total} pnl=${snap.realized_pnl} ` +
        `apiVol=${gate.apiVolume ?? 'n/a'} apiPnl=${gate.apiLifetimePnl ?? 'n/a'} traded=${gate.apiTradedCount ?? 'n/a'} ` +
        `${gate.reason ?? ''}`
      );
      if (!gate.ok) {
        failures.push(`${golden.label}: ${gate.reason ?? 'promotion gate failed'}`);
      }
    }

    console.log('[06-gate] integrity summary', {
      dupeGroups: Number(dupeGroups?.c ?? 0),
      badWalletRows: Number(badWalletRows?.c ?? 0),
      snapshotRows: Number(snapshotRows?.c ?? 0),
      tiers: Object.fromEntries(tierMap.entries()),
      coverageWarnings,
    });

    if (failures.length > 0) {
      console.error('[06-gate] BLOCKED: integrity or golden-wallet failures');
      for (const failure of failures) {
        console.error(` - ${failure}`);
      }
      process.exitCode = 2;
      return;
    }

    console.log('[06-gate] PASS: integrity + golden wallet checks succeeded.');
  } finally {
    sqlite.close();
    await duck.close();
  }
}

main().catch((err) => {
  console.error('[06-gate] failed:', err);
  process.exit(1);
});
