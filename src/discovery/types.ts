/**
 * Discovery Engine types, contract constants, and ABI fragments.
 *
 * The discovery engine monitors on-chain OrderFilled events on Polygon
 * and polls the Polymarket Data API to detect wallet activity across
 * all markets in real time.
 */

// ---------------------------------------------------------------------------
// Contract addresses (Polygon mainnet)
// ---------------------------------------------------------------------------

export const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
export const NEG_RISK_CTF_EXCHANGE_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// keccak256 of the OrderFilled event signature
export const ORDER_FILLED_TOPIC0 =
  '0xd0a08e8c493f9c94f29311571544f45a67d412c07ad8c7d3a07f3a53b7b6cece';

// ---------------------------------------------------------------------------
// ABI fragment for decoding OrderFilled events
// ---------------------------------------------------------------------------

export const ORDER_FILLED_ABI_FRAGMENT = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

// Non-indexed params in the order they appear in `data`
export const ORDER_FILLED_DATA_TYPES = [
  'uint256', // makerAssetId
  'uint256', // takerAssetId
  'uint256', // makerAmountFilled
  'uint256', // takerAmountFilled
  'uint256', // fee
];

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface DiscoveredTrade {
  txHash: string;
  maker: string;
  taker: string;
  assetId: string;
  marketSlug?: string;
  marketTitle?: string;
  conditionId?: string;
  side?: string;
  size: number;
  price?: number;
  fee: number;
  source: 'chain' | 'api';
  detectedAt: number; // unix epoch ms
  blockNumber?: number;
}

export interface WalletStats {
  address: string;
  pseudonym?: string;
  firstSeen: number;
  lastActive: number;
  tradeCount7d: number;
  volume7d: number;
  volumePrev7d: number;
  largestTrade: number;
  uniqueMarkets7d: number;
  avgTradeSize: number;
  isTracked: boolean;
  updatedAt: number;
}

export interface MarketCacheEntry {
  conditionId: string;
  slug?: string;
  title?: string;
  volume24h?: number;
  tokenIds: string[]; // YES and NO token IDs (asset IDs)
  updatedAt: number;
}

export interface DiscoveryConfig {
  enabled: boolean;
  alchemyWsUrl: string;
  pollIntervalMs: number;
  marketCount: number;
  statsIntervalMs: number;
  retentionDays: number;
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  enabled: false,
  alchemyWsUrl: '',
  pollIntervalMs: 30_000,
  marketCount: 50,
  statsIntervalMs: 300_000, // 5 min
  retentionDays: 90,
};

// ---------------------------------------------------------------------------
// On-chain event (parsed from log)
// ---------------------------------------------------------------------------

export interface OrderFilledEvent {
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: string;
  takerAmountFilled: string;
  fee: string;
  blockNumber: number;
  transactionHash: string;
  contractAddress: string;
}

// ---------------------------------------------------------------------------
// Health / status
// ---------------------------------------------------------------------------

export interface DiscoveryStatus {
  enabled: boolean;
  chainListener: {
    connected: boolean;
    lastEventAt?: number;
    reconnectCount: number;
  };
  apiPoller: {
    running: boolean;
    lastPollAt?: number;
    marketsMonitored: number;
  };
  stats: {
    totalWallets: number;
    totalTrades: number;
    uptimeMs: number;
  };
}
