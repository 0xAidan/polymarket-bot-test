/**
 * Phase 1.5 step 7: fill the ~55-day gap of Polymarket trade data
 * (March 5 2026 → now) into `discovery_activity_v3` in DuckDB using the
 * existing Goldsky listener infrastructure.
 *
 * This is a one-shot backfill — it pages through all OrderFilled events
 * from a starting timestamp to the chain tip and exits. The script is fully
 * resumable: a cursor file tracks the last successfully processed timestamp
 * so a crash or Ctrl-C loses at most one page of work.
 *
 * ## Usage
 *
 *   tsx scripts/backfill/07_goldsky_gap_fill.ts
 *
 * ## Env vars (all optional)
 *
 *   DUCKDB_PATH              — path to the DuckDB file (default: ./data/discovery_v3.duckdb)
 *   DUCKDB_MEMORY_LIMIT_GB   — cap DuckDB memory
 *   DUCKDB_THREADS            — cap parallelism
 *   DUCKDB_TEMP_DIR           — spill directory
 *   GAP_FILL_CURSOR_PATH     — cursor file (default: ./data/07_gap_fill_cursor.json)
 *   GAP_FILL_START_TS        — override the gap start (default: 2026-03-05T00:00:00Z)
 *   GAP_FILL_PAGE_SIZE       — events per Goldsky page (default: 500)
 *   GAP_FILL_DELAY_MS        — delay between pages in ms (default: 200)
 *
 * ## After running
 *
 *   Run 05_score_and_publish.ts to rescore all wallets with the new data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { openDuckDB } from '../../src/discovery/v3/duckdbClient.js';
import { runV3DuckDBMigrationsBackfillNoIndex } from '../../src/discovery/v3/duckdbSchema.js';
import { getDuckDBPath } from '../../src/discovery/v3/featureFlag.js';
import {
  createGoldskyClient,
  normalizeOrderFilled,
  insertNormalizedRowsBatch,
  type GoldskyOrderFilled,
  type NormalizedV3Row,
} from '../../src/discovery/v3/goldskyListener.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_GAP_START_TS = '2026-03-05T00:00:00Z';
const DEFAULT_CURSOR_PATH = './data/07_gap_fill_cursor.json';
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_DELAY_MS = 0;
const MAX_RETRIES = 3;

interface CursorFile {
  lastTimestamp: number;
  totalInserted: number;
  totalFetched: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatElapsed(startMs: number): string {
  const seconds = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

function readCursor(path: string): CursorFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as CursorFile;
    // Support both old (lastBlock) and new (lastTimestamp) cursor formats.
    const ts = parsed.lastTimestamp ?? (parsed as any).lastBlock;
    if (typeof ts === 'number' && ts > 0) {
      return { ...parsed, lastTimestamp: ts };
    }
    return null;
  } catch {
    return null;
  }
}

function writeCursor(path: string, cursor: CursorFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Starting timestamp
// ---------------------------------------------------------------------------

/**
 * Return the Unix timestamp (seconds) for approximately March 5, 2026.
 * The Goldsky subgraph paginates by `timestamp_gt`, so we use the
 * timestamp directly.
 */
function findStartingTimestamp(startTsUnix: number): number {
  // Subtract 1 so the `timestamp_gt` filter includes events AT the start.
  const cursor = startTsUnix - 1;
  console.log(
    `[07] using start timestamp ${startTsUnix} (${new Date(startTsUnix * 1000).toISOString()}), ` +
    `cursor=${cursor} (timestamp_gt pagination)`
  );
  return cursor;
}

// ---------------------------------------------------------------------------
// Fetch with retry
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  client: ReturnType<typeof createGoldskyClient>,
  lastTimestamp: number,
  pageSize: number,
): Promise<GoldskyOrderFilled[]> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.fetchOrderFilledSince(lastTimestamp, pageSize);
    } catch (err) {
      lastErr = err as Error;
      const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.warn(`[07] Goldsky fetch failed (attempt ${attempt}/${MAX_RETRIES}): ${lastErr.message} — retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cursorPath = process.env.GAP_FILL_CURSOR_PATH || DEFAULT_CURSOR_PATH;
  const startTsIso = process.env.GAP_FILL_START_TS || DEFAULT_GAP_START_TS;
  const pageSize = Number(process.env.GAP_FILL_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const delayMs = Number(process.env.GAP_FILL_DELAY_MS) || DEFAULT_DELAY_MS;
  const startTsUnix = Math.floor(new Date(startTsIso).getTime() / 1000);

  console.log(`[07] Goldsky gap fill — start=${startTsIso} pageSize=${pageSize} delay=${delayMs}ms`);
  console.log(`[07] cursor file: ${cursorPath}`);

  // ── DuckDB ──────────────────────────────────────────────────────────────
  const dbPath = getDuckDBPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const duck = openDuckDB(dbPath);

  try {
    // Use backfill-safe migrations (no ART indexes — would OOM on 800M+ rows).
    await runV3DuckDBMigrationsBackfillNoIndex((sql) => duck.exec(sql));

    const beforeRows = (
      await duck.query<{ c: number | bigint }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3')
    )[0].c;
    console.log(`[07] existing rows in discovery_activity_v3: ${formatNumber(Number(beforeRows))}`);

    // ── Determine starting timestamp ──────────────────────────────────
    const savedCursor = readCursor(cursorPath);
    let lastTimestamp: number;
    let totalInserted: number;
    let totalFetched: number;

    if (savedCursor) {
      lastTimestamp = savedCursor.lastTimestamp;
      totalInserted = savedCursor.totalInserted;
      totalFetched = savedCursor.totalFetched;
      // Clean up any partial-page remnants from a previous Ctrl+C.
      // The cursor represents the max timestamp of the last FULLY completed
      // page, so anything above it is from an interrupted batch.
      const deleted = await duck.query<{ c: number | bigint }>(
        `SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3 WHERE ts_unix > ${lastTimestamp}`
      );
      const delCount = Number(deleted[0].c);
      if (delCount > 0) {
        await duck.exec(`DELETE FROM discovery_activity_v3 WHERE ts_unix > ${lastTimestamp}`);
        console.log(`[07] cleaned ${formatNumber(delCount)} partial-page rows above cursor ts ${lastTimestamp}`);
      }
      console.log(
        `[07] resuming from cursor — ts ${lastTimestamp} (${new Date(lastTimestamp * 1000).toISOString()}), ` +
        `${formatNumber(totalFetched)} events fetched, ${formatNumber(totalInserted)} rows inserted previously`
      );
    } else {
      lastTimestamp = findStartingTimestamp(startTsUnix);
      totalInserted = 0;
      totalFetched = 0;
    }

    // ── Paging loop ─────────────────────────────────────────────────────
    const client = createGoldskyClient();
    const t0 = Date.now();
    let pageNum = 0;

    while (true) {
      pageNum++;

      let events: GoldskyOrderFilled[];
      try {
        events = await fetchWithRetry(client, lastTimestamp, pageSize);
      } catch (err) {
        // All retries exhausted — save cursor and bail.
        console.error(`[07] FATAL: Goldsky fetch failed after ${MAX_RETRIES} retries: ${(err as Error).message}`);
        writeCursor(cursorPath, {
          lastTimestamp,
          totalInserted,
          totalFetched,
          updatedAt: new Date().toISOString(),
        });
        console.log(`[07] cursor saved at ts ${lastTimestamp} — re-run to resume`);
        process.exit(1);
      }

      if (events.length === 0) {
        console.log(`[07] caught up to chain tip — no more events after ts ${lastTimestamp}`);
        break;
      }

      // Normalize all events into v3 rows.
      const rows: NormalizedV3Row[] = [];
      for (const ev of events) {
        rows.push(...normalizeOrderFilled(ev));
      }

      // Insert into DuckDB (batch — single INSERT statement per page).
      let pageInserted = 0;
      try {
        pageInserted = await insertNormalizedRowsBatch(duck, rows);
      } catch (err) {
        // DuckDB error — log and continue.
        console.error(`[07] DuckDB insert error on page ${pageNum}: ${(err as Error).message} — continuing`);
      }

      // Advance cursor.
      const maxTs = events.reduce((m, e) => Math.max(m, Number(e.timestamp)), lastTimestamp);
      lastTimestamp = maxTs;
      totalFetched += events.length;
      totalInserted += pageInserted;

      // Save cursor after every page so we can resume.
      writeCursor(cursorPath, {
        lastTimestamp,
        totalInserted,
        totalFetched,
        updatedAt: new Date().toISOString(),
      });

      // Progress log.
      console.log(
        `[07] page ${pageNum} | ts ${lastTimestamp} (${new Date(lastTimestamp * 1000).toISOString()}) | ` +
        `fetched ${formatNumber(totalFetched)} events → ${formatNumber(totalFetched * 2)} rows | ` +
        `inserted ${formatNumber(totalInserted)} new | elapsed ${formatElapsed(t0)}`
      );

      // If page was partial, we've caught up.
      if (events.length < pageSize) {
        console.log(`[07] partial page (${events.length}/${pageSize}) — caught up to chain tip`);
        break;
      }

      // Rate limit.
      await sleep(delayMs);
    }

    // ── Summary ─────────────────────────────────────────────────────────
    const afterRows = (
      await duck.query<{ c: number | bigint }>('SELECT COUNT(*)::BIGINT AS c FROM discovery_activity_v3')
    )[0].c;
    const netNew = Number(afterRows) - Number(beforeRows);
    console.log(
      `[07] done — ${formatNumber(totalFetched)} events fetched across ${pageNum} pages, ` +
      `${formatNumber(netNew)} net new rows in DuckDB, elapsed ${formatElapsed(t0)}`
    );
    console.log(`[07] next step: run 05_score_and_publish.ts to rescore wallets`);
  } finally {
    await duck.close();
  }
}

main().catch((err) => {
  console.error('[07] failed:', err);
  process.exit(1);
});
