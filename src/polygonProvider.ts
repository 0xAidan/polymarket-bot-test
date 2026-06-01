import { JsonRpcProvider } from 'ethers';
import { config } from './config.js';

const POLYGON_CHAIN_ID = 137;

/**
 * Shared Polygon RPC provider (ethers v6).
 * Do not use ethers.providers.JsonRpcProvider — removed in v6.
 */
export const createPolygonProvider = (): JsonRpcProvider =>
  new JsonRpcProvider(config.polygonRpcUrl, POLYGON_CHAIN_ID);
