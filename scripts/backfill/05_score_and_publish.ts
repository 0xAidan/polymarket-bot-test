/**
 * Phase 1.5 step 5: read the most recent snapshot per wallet from DuckDB,
 * apply eligibility gates, compute tier scores, write top-N per tier to
 * the SQLite hot read model (`discovery_wallet_scores_v3`).
 *
 * OOM FIX (2026-04-27)
 * ─────────────────────
 * The original script pulled ALL rows from `discovery_feature_snapshots_v3`
 * into the Node.js heap via a single duck.query() call. The window function
 * `ROW_NUMBER() OVER (PARTITION BY proxy_wallet ORDER BY snapshot_day DESC)`
 * forces DuckDB to materialise the entire working set before emitting a single
 * row. On the 8 GB Hetzner box, with the snapshots table now holding millions
 * of rows, DuckDB's working set hits its memory_limit and OOMs before the
 * result set ever reaches Node.
 *
 * Fix strategy — push the heavy work inside DuckDB, stream into SQLite:
 *   1. COPY the deduped latest-snapshot rows to a temp Parquet file using
 *      DuckDB's native streaming COPY path (spills to disk, never materialises
 *      in full in memory).
 *   2. Open the Parquet file with a zero-copy DuckDB scan and read in BATCH_SIZE
 *      chunks — the Node heap never holds more than BATCH_SIZE rows at once.
 *   3. Score each batch in TypeScript and upsert into SQLite.
 *   4. Delete the temp Parquet file when done.
 *
 * The result: the only large allocation is DuckDB's sort/partition spill during
 * step 1, which is bounded by DUCKDB_MAX_TEMP_DIR_GB and offloaded to disk
 * rather than RAM.
 */
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrationsBackfillNoIndex } from '../../src/discovery/v3/duckdbSchema.js';
import { runV3SqliteMigrations } from '../../src/discovery/v3/schema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import { scoreTiers } from '../../src/discovery/v3/tierScoring.js';
import type { V3FeatureSnapshot } from '../../src/discovery/v3/types.js';

/** How many rows to score and insert per SQLite transaction. */
const BATCH_SIZE = Number(process.env.SCORE_BATCH_SIZE ?? 5_000);

function getSqlitePath(): string {
  const dataDir = process.env.DATA_DIR || './data';
  return join(dataDir, 'copytrade.db');
}

/** Build a temp path for the intermediate parquet file. */
function getTempParquetPath(): string {
  const dir = process.env.DUCKDB_TEMP_DIR || tmpdir();
  return join(dir, `05_snapshots_latest_${process.pid}.parquet`);
}

async function main(): Promise<void> {
  const duck = openDuckDB(getDuckDBPath());
  const tempParquet = getTempParquetPath();

  try {
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => duck.exec(sql));

    // ── Step 1: COPY the deduplicated latest-snapshot rows to a Parquet file.
    // DuckDB's COPY path uses its native streaming + external-sort path
    // (controlled by max_temp_directory_size) instead of trying to build a
    // full in-memory result set. This is the only place DuckDB needs real
    // disk headroom; it will NOT OOM on the 8 GB box as long as
    // DUCKDB_MAX_TEMP_DIR_GB is set to a reasonable value (e.g. 20).
    console.log('[05] exporting latest snapshots → temp parquet (spills to disk if needed)…');
    await duck.exec(`
      COPY (
        SELECT
          proxy_wallet,
          CAST(snapshot_day AS VARCHAR)                AS snapshot_day,
          CAST(trade_count AS BIGINT)                  AS trade_count,
          volume_total,
          CAST(distinct_markets AS BIGINT)             AS distinct_markets,
          CAST(closed_positions AS BIGINT)             AS closed_positions,
          realized_pnl,
          unrealized_pnl,
          CAST(first_active_ts AS BIGINT)              AS first_active_ts,
          CAST(last_active_ts AS BIGINT)               AS last_active_ts,
          CAST(observation_span_days AS INTEGER)       AS observation_span_days
        FROM (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY proxy_wallet
                   ORDER BY snapshot_day DESC
                 ) AS rn
          FROM discovery_feature_snapshots_v3
        ) t
        WHERE rn = 1
      ) TO '${tempParquet}' (FORMAT PARQUET, COMPRESSION SNAPPY)
    `);
    console.log('[05] temp parquet written:', tempParquet);

    // ── Step 2: count rows so we can report progress without a second full scan.
    const [{ n }] = await duck.query<{ n: bigint }>(
      `SELECT COUNT(*) AS n FROM '${tempParquet}'`
    );
    const total = Number(n);
    console.log(`[05] scoring ${total} wallets in batches of ${BATCH_SIZE}…`);

    // ── Step 3: open SQLite, wipe the old scores table, prepare the insert stmt.
    const sqlitePath = getSqlitePath();
    mkdirSync(dirname(sqlitePath), { recursive: true });
    const db = new Database(sqlitePath);
    db.pragma('journal_mode = WAL');
    runV3SqliteMigrations(db);
    db.prepare('DELETE FROM discovery_wallet_scores_v3').run();

    const ins = db.prepare(
      `INSERT INTO discovery_wallet_scores_v3
         (proxy_wallet, tier, tier_rank, score, volume_total, trade_count,
          distinct_markets, closed_positions, realized_pnl, hit_rate,
          last_active_ts, reasons_json, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    const now = Math.floor(Date.now() / 1000);
    let processed = 0;
    let eligible = 0;
    let batchIndex = 0;

    // ── Step 4: stream batches from the Parquet file, score, insert.
    // The Node heap at any moment holds at most BATCH_SIZE raw rows +
    // their scored counterparts — never the full wallet universe.
    while (processed < total) {
      const rows = await duck.query<V3FeatureSnapshot>(
        `SELECT * FROM '${tempParquet}' LIMIT ${BATCH_SIZE} OFFSET ${processed}`
      );
      if (rows.length === 0) break;

      const input = rows.map((r) => ({
        snapshot: {
          ...r,
          trade_count: Number(r.trade_count),
          distinct_markets: Number(r.distinct_markets),
          closed_positions: Number(r.closed_positions),
          first_active_ts: Number(r.first_active_ts),
          last_active_ts: Number(r.last_active_ts),
          observation_span_days: Number(r.observation_span_days),
        },
        now_ts: now,
      }));

      const { scores, stats: batchStats } = scoreTiers(input);
      eligible += batchStats.eligible;

      const tx = db.transaction((list: typeof scores) => {
        for (const s of list) {
          ins.run(
            s.proxy_wallet, s.tier, s.tier_rank, s.score, s.volume_total,
            s.trade_count, s.distinct_markets, s.closed_positions,
            s.realized_pnl, s.hit_rate, s.last_active_ts, s.reasons_json, s.updated_at
          );
        }
      });
      tx(scores);

      processed += rows.length;
      batchIndex++;
      if (batchIndex % 10 === 0 || processed >= total) {
        console.log(`[05] batch ${batchIndex}: ${processed}/${total} processed, ${eligible} eligible so far`);
      }
    }

    db.close();
    console.log(`[05] eligibility: ${eligible}/${total} (rejection ${(((total - eligible) / Math.max(total, 1)) * 100).toFixed(1)}%)`);
    console.log(`[05] wrote scores to ${sqlitePath}`);

  } finally {
    await duck.close();

    // ── Step 5: clean up the temp parquet regardless of success/failure.
    if (existsSync(tempParquet)) {
      try { rmSync(tempParquet); } catch { /* ignore cleanup errors */ }
      console.log('[05] temp parquet deleted.');
    }
  }

  console.log('[05] done.');
}

main().catch((err) => {
  console.error('[05] failed:', err);
  process.exit(1);
});
