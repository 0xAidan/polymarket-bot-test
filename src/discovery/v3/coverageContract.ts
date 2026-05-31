import type Database from 'better-sqlite3';

const DEFAULT_BACKFILL_SOURCE = 'huggingface:SII-WANGZJ/Polymarket_data/users.parquet';
const DEFAULT_GAP_POLICY =
  'Historical coverage is limited to the imported backfill source plus live ingest since cutover; see issue #103 for known gaps.';
const DEFAULT_HISTORICAL_COVERAGE_MAX_TS = 1772668800; // 2026-03-05T00:00:00Z

const parseNumber = (raw?: string): number | null => {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.floor(value);
};

export interface DiscoveryCoverageContract {
  historical_backfill_source: string;
  historical_coverage_max_ts: number | null;
  known_gap_policy: string;
  live_ingest_cursor_ts: number | null;
  live_ingest_cursor_block: number | null;
  score_updated_at: number | null;
}

interface CursorRow {
  pipeline: string;
  last_block: number;
  last_ts_unix: number;
  updated_at: number;
}

export const getDiscoveryCoverageContract = (db: Database.Database): DiscoveryCoverageContract => {
  const historicalCoverageMaxTs =
    parseNumber(process.env.DISCOVERY_V3_HISTORICAL_COVERAGE_MAX_TS) ??
    DEFAULT_HISTORICAL_COVERAGE_MAX_TS;

  const backfillSource =
    process.env.DISCOVERY_V3_HISTORICAL_BACKFILL_SOURCE || DEFAULT_BACKFILL_SOURCE;

  const knownGapPolicy = process.env.DISCOVERY_V3_KNOWN_GAP_POLICY || DEFAULT_GAP_POLICY;

  const cursorRows = db.prepare(
    'SELECT pipeline, last_block, last_ts_unix, updated_at FROM pipeline_cursor'
  ).all() as CursorRow[];

  const liveCursor =
    cursorRows.find((row) => row.pipeline === 'live') ??
    [...cursorRows].sort((a, b) => b.last_ts_unix - a.last_ts_unix)[0];

  const scoreUpdated = db
    .prepare('SELECT MAX(updated_at) AS updated_at FROM discovery_wallet_scores_v3')
    .get() as { updated_at: number | null };

  return {
    historical_backfill_source: backfillSource,
    historical_coverage_max_ts: historicalCoverageMaxTs,
    known_gap_policy: knownGapPolicy,
    live_ingest_cursor_ts: liveCursor?.last_ts_unix ?? null,
    live_ingest_cursor_block: liveCursor?.last_block ?? null,
    score_updated_at: scoreUpdated?.updated_at ?? null,
  };
};
