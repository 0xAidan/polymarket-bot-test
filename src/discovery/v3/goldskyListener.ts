/**
 * Polls the Goldsky Polymarket orderbook subgraph for new OrderFilled events,
 * normalizes them into v3 activity rows, and inserts into
 * `discovery_activity_v3`. The DuckDB UNIQUE(tx_hash, log_index) constraint
 * handles any overlap with backfill at the boundary.
 */
import { DuckDBClient } from './duckdbClient.js';
import type Database from 'better-sqlite3';

export const GOLDSKY_ENDPOINT =
  'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn';

export interface GoldskyOrderFilled {
  id: string;
  transactionHash: string;
  logIndex: string;
  blockNumber: string;
  timestamp: string;
  maker: string;
  taker: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: string;
  takerAmountFilled: string;
  conditionId?: string;
  marketId?: string;
  eventId?: string;
}

export interface NormalizedV3Row {
  proxy_wallet: string;
  market_id: string;
  condition_id: string;
  event_id: string | null;
  ts_unix: number;
  block_number: number;
  tx_hash: string;
  log_index: number;
  role: 'maker' | 'taker';
  side: 'BUY' | 'SELL';
  price_yes: number;
  usd_notional: number;
  signed_size: number;
  abs_size: number;
}

export interface GoldskyClient {
  fetchOrderFilledSince(lastBlock: number, limit?: number): Promise<GoldskyOrderFilled[]>;
}

interface GraphqlResponse {
  data?: { orderFilledEvents?: GoldskyOrderFilled[] };
  errors?: Array<{ message: string }>;
}

/**
 * Default Goldsky client. Accepts a `fetchImpl` override so unit tests can
 * swap in a canned-response mock without patching globals.
 */
export function createGoldskyClient(opts: { fetchImpl?: typeof fetch; endpoint?: string } = {}): GoldskyClient {
  const f = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? GOLDSKY_ENDPOINT;
  return {
    async fetchOrderFilledSince(lastBlock: number, limit = 500): Promise<GoldskyOrderFilled[]> {
      const query = `
        query LiveTail($lastBlock: Int!, $limit: Int!) {
          orderFilledEvents(
            first: $limit,
            orderBy: blockNumber,
            orderDirection: asc,
            where: { blockNumber_gt: $lastBlock }
          ) {
            id transactionHash logIndex blockNumber timestamp
            maker taker makerAssetId takerAssetId
            makerAmountFilled takerAmountFilled
            conditionId marketId eventId
          }
        }
      `;
      const res = await f(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { lastBlock, limit } }),
      });
      if (!res.ok) throw new Error(`Goldsky ${res.status}`);
      const body = (await res.json()) as GraphqlResponse;
      if (body.errors?.length) throw new Error(`Goldsky errors: ${body.errors.map((e) => e.message).join('; ')}`);
      return body.data?.orderFilledEvents ?? [];
    },
  };
}

/**
 * Normalize two rows (maker + taker) per OrderFilled event. Buy side is
 * inferred from whether taker is delivering USDC — on Polymarket the
 * collateral asset id encodes USDC (conventionally the token with id 0).
 */
export function normalizeOrderFilled(event: GoldskyOrderFilled): NormalizedV3Row[] {
  const blockNumber = Number(event.blockNumber);
  const tsUnix = Number(event.timestamp);
  const logIndex = Number(event.logIndex);
  const makerAmount = Number(event.makerAmountFilled);
  const takerAmount = Number(event.takerAmountFilled);
  const makerIsCollateral = event.makerAssetId === '0' || event.makerAssetId === '';
  const price = makerIsCollateral
    ? (takerAmount === 0 ? 0 : makerAmount / takerAmount)
    : (makerAmount === 0 ? 0 : takerAmount / makerAmount);
  const usdNotional = makerIsCollateral ? makerAmount : takerAmount;
  const size = makerIsCollateral ? takerAmount : makerAmount;

  const makerSide: 'BUY' | 'SELL' = makerIsCollateral ? 'BUY' : 'SELL';
  const takerSide: 'BUY' | 'SELL' = makerIsCollateral ? 'SELL' : 'BUY';
  const marketId = event.marketId ?? event.conditionId ?? '';
  const conditionId = event.conditionId ?? '';
  const eventId = event.eventId ?? null;

  const base = {
    market_id: marketId,
    condition_id: conditionId,
    event_id: eventId,
    ts_unix: tsUnix,
    block_number: blockNumber,
    tx_hash: event.transactionHash,
    price_yes: price,
    usd_notional: usdNotional,
  };
  return [
    {
      ...base,
      proxy_wallet: event.maker,
      log_index: logIndex,
      role: 'maker' as const,
      side: makerSide,
      signed_size: makerSide === 'BUY' ? size : -size,
      abs_size: size,
    },
    {
      ...base,
      proxy_wallet: event.taker,
      // Distinguish maker vs taker rows with log_index offset; within a tx
      // the log_index per side is (logIndex, logIndex + 2^30) — still unique.
      log_index: logIndex + 1_000_000_000,
      role: 'taker' as const,
      side: takerSide,
      signed_size: takerSide === 'BUY' ? size : -size,
      abs_size: size,
    },
  ];
}

export async function insertNormalizedRows(
  db: DuckDBClient,
  rows: NormalizedV3Row[]
): Promise<number> {
  if (rows.length === 0) return 0;
  // DuckDB has no batch parameterized executemany exposed via the node client,
  // but we can stage rows in a temp table via VALUES. For hundreds-per-poll
  // volumes this is fine.
  let inserted = 0;
  for (const r of rows) {
    try {
      await db.exec(
        `INSERT INTO discovery_activity_v3 VALUES (
           '${r.proxy_wallet.replace(/'/g, "''")}',
           '${r.market_id.replace(/'/g, "''")}',
           '${r.condition_id.replace(/'/g, "''")}',
           ${r.event_id === null ? 'NULL' : `'${r.event_id.replace(/'/g, "''")}'`},
           ${r.ts_unix},
           ${r.block_number},
           '${r.tx_hash.replace(/'/g, "''")}',
           ${r.log_index},
           '${r.role}',
           '${r.side}',
           ${r.price_yes},
           ${r.usd_notional},
           ${r.signed_size},
           ${r.abs_size}
         )`
      );
      inserted++;
    } catch (err) {
      // Swallow UNIQUE-violation dupes silently (backfill overlap); rethrow others.
      if (!/duplicate key/i.test((err as Error).message)) throw err;
    }
  }
  return inserted;
}

export interface PipelineCursorStore {
  getLastBlock(pipeline: string): number;
  setLastBlock(pipeline: string, block: number, tsUnix: number): void;
}

export function createSqliteCursorStore(db: Database.Database): PipelineCursorStore {
  return {
    getLastBlock(pipeline: string): number {
      const row = db.prepare('SELECT last_block FROM pipeline_cursor WHERE pipeline = ?').get(pipeline) as { last_block: number } | undefined;
      return row?.last_block ?? 0;
    },
    setLastBlock(pipeline: string, block: number, tsUnix: number): void {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `INSERT INTO pipeline_cursor (pipeline, last_block, last_ts_unix, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pipeline) DO UPDATE SET
           last_block = excluded.last_block,
           last_ts_unix = excluded.last_ts_unix,
           updated_at = excluded.updated_at`
      ).run(pipeline, block, tsUnix, now);
    },
  };
}

export interface PollOnceParams {
  duck: DuckDBClient;
  cursor: PipelineCursorStore;
  client: GoldskyClient;
  pipelineKey?: string;
  pageSize?: number;
}

export interface PollOnceResult {
  fetched: number;
  inserted: number;
  newCursor: number;
}

export async function pollGoldskyOnce({
  duck,
  cursor,
  client,
  pipelineKey = 'live',
  pageSize = 500,
}: PollOnceParams): Promise<PollOnceResult> {
  const lastBlock = cursor.getLastBlock(pipelineKey);
  const events = await client.fetchOrderFilledSince(lastBlock, pageSize);
  if (events.length === 0) return { fetched: 0, inserted: 0, newCursor: lastBlock };

  const rows: NormalizedV3Row[] = [];
  for (const ev of events) rows.push(...normalizeOrderFilled(ev));
  const inserted = await insertNormalizedRows(duck, rows);
  const maxBlock = events.reduce((m, e) => Math.max(m, Number(e.blockNumber)), lastBlock);
  const maxTs = events.reduce((m, e) => Math.max(m, Number(e.timestamp)), 0);
  cursor.setLastBlock(pipelineKey, maxBlock, maxTs);
  return { fetched: events.length, inserted, newCursor: maxBlock };
}
