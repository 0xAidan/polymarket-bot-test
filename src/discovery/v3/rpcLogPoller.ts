/**
 * Hourly (configurable) Polygon HTTP `eth_getLogs` poller for global OrderFilled
 * events. Budget-friendly alternative to Alchemy WebSocket streaming.
 */
import { config } from '../../config.js';
import {
  ALL_EXCHANGE_ADDRESSES,
  ORDER_FILLED_TOPIC0_V1,
  ORDER_FILLED_TOPIC0_V2,
} from '../types.js';
import { DuckDBClient } from './duckdbClient.js';
import {
  insertNormalizedRowsBatch,
  type PipelineCursorStore,
} from './goldskyListener.js';
import { orderFilledLogToV3Rows } from './orderFilledToV3.js';
import {
  getRpcPollBlockChunk,
  getRpcPollInitialLookbackBlocks,
  getRpcPollOverlapBlocks,
} from './featureFlag.js';

export const RPC_LIVE_PIPELINE_KEY = 'rpc-live';

export interface RpcClient {
  getBlockNumber(): Promise<number>;
  getLogs(fromBlock: number, toBlock: number): Promise<Record<string, unknown>[]>;
  getBlockTimestamp(blockNumber: number): Promise<number>;
}

export function createHttpRpcClient(
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch,
): RpcClient {
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
    return body.result;
  };

  return {
    async getBlockNumber(): Promise<number> {
      const hex = (await rpc('eth_blockNumber', [])) as string;
      return parseInt(hex, 16);
    },
    async getLogs(fromBlock: number, toBlock: number): Promise<Record<string, unknown>[]> {
      const result = (await rpc('eth_getLogs', [{
        address: ALL_EXCHANGE_ADDRESSES.map((a) => a.toLowerCase()),
        topics: [[ORDER_FILLED_TOPIC0_V1, ORDER_FILLED_TOPIC0_V2]],
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
      }])) as Record<string, unknown>[] | null;
      return result ?? [];
    },
    async getBlockTimestamp(blockNumber: number): Promise<number> {
      const block = (await rpc('eth_getBlockByNumber', [
        `0x${blockNumber.toString(16)}`,
        false,
      ])) as { timestamp?: string } | null;
      if (!block?.timestamp) throw new Error(`missing timestamp for block ${blockNumber}`);
      return parseInt(block.timestamp, 16);
    },
  };
}

export interface PollRpcOnceParams {
  duck: DuckDBClient;
  cursor: PipelineCursorStore;
  client: RpcClient;
  pipelineKey?: string;
  blockChunkSize?: number;
  overlapBlocks?: number;
  initialLookbackBlocks?: number;
}

export interface PollRpcOnceResult {
  fromBlock: number;
  toBlock: number;
  logsFetched: number;
  inserted: number;
  newCursor: number;
}

export async function pollRpcLogsOnce({
  duck,
  cursor,
  client,
  pipelineKey = RPC_LIVE_PIPELINE_KEY,
  blockChunkSize = getRpcPollBlockChunk(),
  overlapBlocks = getRpcPollOverlapBlocks(),
  initialLookbackBlocks = getRpcPollInitialLookbackBlocks(),
}: PollRpcOnceParams): Promise<PollRpcOnceResult> {
  const head = await client.getBlockNumber();
  let stored = cursor.getLastBlock(pipelineKey);
  let fromBlock = stored === 0
    ? Math.max(0, head - initialLookbackBlocks)
    : Math.max(0, stored - overlapBlocks);
  if (fromBlock > head) {
    return { fromBlock, toBlock: head, logsFetched: 0, inserted: 0, newCursor: stored };
  }

  const tsCache = new Map<number, number>();
  let logsFetched = 0;
  let inserted = 0;

  for (let start = fromBlock; start <= head; start += blockChunkSize + 1) {
    const end = Math.min(head, start + blockChunkSize);
    const logs = await client.getLogs(start, end);
    logsFetched += logs.length;
    if (logs.length === 0) continue;

    const rows = [];
    for (const log of logs) {
      const blockNumber = parseInt(String(log.blockNumber), 16);
      let tsUnix = tsCache.get(blockNumber);
      if (tsUnix == null) {
        tsUnix = await client.getBlockTimestamp(blockNumber);
        tsCache.set(blockNumber, tsUnix);
      }
      rows.push(...orderFilledLogToV3Rows(log, tsUnix));
    }
    inserted += await insertNormalizedRowsBatch(duck, rows);
  }

  cursor.setLastBlock(pipelineKey, head, Math.floor(Date.now() / 1000), '');
  return { fromBlock, toBlock: head, logsFetched, inserted, newCursor: head };
}

export function getDefaultRpcUrl(): string {
  return config.polygonRpcUrl || 'https://polygon-rpc.com';
}
