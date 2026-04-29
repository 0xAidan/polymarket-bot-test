/**
 * Discovery v3 soak report.
 *
 * Reads DuckDB + SQLite and prints a compact readiness snapshot for
 * repeated staging/prod soak checks.
 */
import Database from 'better-sqlite3';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';

const getSqlitePath = (): string => {
  const dataDir = process.env.DATA_DIR || './data';
  return `${dataDir}/copytrade.db`;
};

interface CountRow {
  c: number;
}

async function main(): Promise<void> {
  const duck = openDuckDB(getDuckDBPath());
  const sqlite = new Database(getSqlitePath(), { readonly: true });
  const now = Math.floor(Date.now() / 1000);

  try {
    const [snapshotRows] = await duck.query<CountRow>(
      'SELECT COUNT(*)::BIGINT AS c FROM discovery_feature_snapshots_v3'
    );
    const [distinctWallets] = await duck.query<CountRow>(
      'SELECT COUNT(DISTINCT proxy_wallet)::BIGINT AS c FROM discovery_feature_snapshots_v3'
    );
    const [activityRows] = await duck.query<CountRow>(
      'SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3'
    );
    const [snapshotRange] = await duck.query<{ min_day: string | null; max_day: string | null }>(
      'SELECT CAST(MIN(snapshot_day) AS VARCHAR) AS min_day, CAST(MAX(snapshot_day) AS VARCHAR) AS max_day FROM discovery_feature_snapshots_v3'
    );

    const tiers = sqlite
      .prepare('SELECT tier, COUNT(*) AS c FROM discovery_wallet_scores_v3 GROUP BY tier')
      .all() as Array<{ tier: string; c: number }>;

    const scoreUpdated = sqlite
      .prepare('SELECT MAX(updated_at) AS ts FROM discovery_wallet_scores_v3')
      .get() as { ts: number | null };

    const cursors = sqlite
      .prepare('SELECT pipeline, last_block, last_ts_unix, updated_at FROM pipeline_cursor')
      .all() as Array<{ pipeline: string; last_block: number; last_ts_unix: number; updated_at: number }>;

    const liveCursor =
      cursors.find((row) => row.pipeline === 'live') ??
      [...cursors].sort((a, b) => b.last_ts_unix - a.last_ts_unix)[0];

    const report = {
      generated_at: now,
      duckdb: {
        path: getDuckDBPath(),
        activity_rows: Number(activityRows?.c ?? 0),
        snapshot_rows: Number(snapshotRows?.c ?? 0),
        snapshot_wallets: Number(distinctWallets?.c ?? 0),
        snapshot_min_day: snapshotRange?.min_day ?? null,
        snapshot_max_day: snapshotRange?.max_day ?? null,
      },
      sqlite: {
        path: getSqlitePath(),
        tiers: Object.fromEntries(tiers.map((row) => [row.tier, Number(row.c)])),
        score_updated_at: scoreUpdated?.ts ?? null,
        score_age_seconds: scoreUpdated?.ts ? now - scoreUpdated.ts : null,
      },
      cursor: liveCursor
        ? {
            pipeline: liveCursor.pipeline,
            last_block: liveCursor.last_block,
            last_ts_unix: liveCursor.last_ts_unix,
            updated_at: liveCursor.updated_at,
            cursor_age_seconds: now - liveCursor.updated_at,
          }
        : null,
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    sqlite.close();
    await duck.close();
  }
}

main().catch((err) => {
  console.error('[07-soak] failed:', err);
  process.exit(1);
});
