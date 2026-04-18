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

// keccak256("OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)")
export const ORDER_FILLED_TOPIC0 =
  '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';

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
  eventKey?: string;
  maker: string;
  taker: string;
  assetId: string;
  marketSlug?: string;
  marketTitle?: string;
  conditionId?: string;
  side?: string;
  size: number; // shares
  price?: number;
  notionalUsd?: number;
  outcome?: string;
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
  priorActiveAt?: number;
  tradeCount7d: number;
  volume7d: number;
  volumePrev7d: number;
  highInformationVolume7d: number;
  focusCategory?: DiscoveryMarketCategory;
  largestTrade: number;
  uniqueMarkets7d: number;
  avgTradeSize: number;
  isTracked: boolean;
  updatedAt: number;
  whaleScore: number;
  heatIndicator: HeatIndicator;
  totalPnl: number;
  roiPct: number | null;
  winRate: number;
  activePositions: number;
  lastSignalType?: string;
  lastSignalAt?: number;
}

export type DiscoveryMarketCategory =
  | 'politics'
  | 'macro'
  | 'company'
  | 'legal'
  | 'geopolitics'
  | 'entertainment'
  | 'sports'
  | 'crypto'
  | 'event'
  | 'other';

export interface MarketCacheEntry {
  conditionId: string;
  slug?: string;
  title?: string;
  volume24h?: number;
  tokenIds: string[]; // YES and NO token IDs (asset IDs)
  outcomes?: string[];
  category?: DiscoveryMarketCategory;
  isRecurring?: boolean;
  isSportsLike?: boolean;
  primaryDiscoveryEligible?: boolean;
  emergingEligible?: boolean;
  sharpWalletEligible?: boolean;
  highInformationPriority?: boolean;
  updatedAt: number;
}

export interface DiscoveryMarketPoolEntry {
  conditionId: string;
  eventId?: string;
  marketId?: string;
  eventSlug?: string;
  slug?: string;
  title?: string;
  focusCategory: DiscoveryMarketCategory;
  tagSlugs: string[];
  tokenIds: string[];
  outcomes?: string[];
  liquidity?: number;
  volume24h?: number;
  openInterest?: number;
  acceptingOrders?: boolean;
  competitive?: boolean;
  startDate?: string;
  endDate?: string;
  updatedAt: number;
}

export interface DiscoveryTokenMapEntry {
  conditionId: string;
  tokenId: string;
  outcome?: string;
  updatedAt: number;
}

export interface DiscoveryWalletCandidate {
  address: string;
  sourceType: 'leaderboard' | 'market-positions' | 'holders' | 'trades';
  sourceLabel: string;
  conditionId?: string;
  marketTitle?: string;
  sourceRank?: number;
  sourceMetric?: number;
  sourceMetadata?: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
  updatedAt: number;
}

export interface DiscoveryWalletValidation {
  address: string;
  profileName?: string;
  pseudonym?: string;
  xUsername?: string;
  verifiedBadge?: boolean;
  tradedMarkets?: number;
  openPositionsCount: number;
  closedPositionsCount: number;
  realizedPnl: number;
  realizedWinRate: number;
  makerRebateCount: number;
  tradeActivityCount: number;
  buyActivityCount: number;
  sellActivityCount: number;
  marketsTouched: number;
  lastValidatedAt: number;
  rawProfile?: Record<string, unknown>;
  rawPositions?: Record<string, unknown>[];
  rawClosedPositions?: Record<string, unknown>[];
  rawActivity?: Record<string, unknown>[];
}

export interface DiscoveryWalletScoreRow {
  address: string;
  profitabilityScore: number;
  focusScore: number;
  copyabilityScore: number;
  earlyScore: number;
  consistencyScore: number;
  convictionScore: number;
  noisePenalty: number;
  passedProfitabilityGate: boolean;
  passedFocusGate: boolean;
  passedCopyabilityGate: boolean;
  finalScore: number;
  previousFinalScore?: number;
  previousUpdatedAt?: number;
  previousPassedProfitabilityGate?: boolean;
  previousPassedFocusGate?: boolean;
  previousPassedCopyabilityGate?: boolean;
  updatedAt: number;
  trustScore?: number;
  strategyClass?: DiscoveryStrategyClass;
  confidenceBucket?: DiscoveryConfidenceBucket;
  surfaceBucket?: DiscoverySurfaceBucket;
  scoreVersion?: number;
}

export interface DiscoveryWalletReason {
  address: string;
  reasonType: 'supporting' | 'warning' | 'rejection';
  reasonCode: string;
  message: string;
  createdAt: number;
}

export type DiscoveryStrategyClass =
  | 'informational_directional'
  | 'structural_arbitrage'
  | 'market_maker'
  | 'reactive_momentum'
  | 'suspicious'
  | 'unknown';

export type DiscoveryConfidenceBucket = 'low' | 'medium' | 'high';

export type DiscoverySurfaceBucket =
  | 'emerging'
  | 'trusted'
  | 'copyable'
  | 'watch_only'
  | 'suppressed';

export interface DiscoveryReasonPayloadV2 {
  primaryReason: string;
  supportingReasons: string[];
  cautionFlags: string[];
}

export interface DiscoveryWalletScoreV2Row {
  address: string;
  scoreVersion: number;
  strategyClass: DiscoveryStrategyClass;
  discoveryScore: number;
  trustScore: number;
  copyabilityScore: number;
  confidenceBucket: DiscoveryConfidenceBucket;
  surfaceBucket: DiscoverySurfaceBucket;
  primaryReason: string;
  supportingReasons: string[];
  cautionFlags: string[];
  updatedAt: number;
}

export interface DiscoveryEvaluationSnapshot {
  id?: number;
  windowStart: number;
  windowEnd: number;
  sampleSize: number;
  topK: number;
  precisionAtK: number;
  meanAveragePrecision: number;
  ndcg: number;
  baselinePrecisionAtK: number;
  createdAt: number;
  notes?: string;
}

export interface DiscoveryCostSnapshot {
  id?: number;
  provider: 'gamma' | 'data' | 'clob' | 'other';
  endpoint: string;
  requestCount: number;
  estimatedCostUsd: number;
  coverageCount: number;
  runtimeMs: number;
  createdAt: number;
}

export interface DiscoveryRunLog {
  runId?: number;
  phase: string;
  gammaRequestCount: number;
  dataRequestCount: number;
  clobRequestCount: number;
  candidateCount: number;
  qualifiedCount: number;
  rejectedCount: number;
  durationMs: number;
  estimatedCostUsd?: number;
  categoryPurityPct?: number;
  copyabilityPassPct?: number;
  walletsWithTwoReasonsPct?: number;
  freeModeNoAlchemy?: boolean;
  notes?: string;
  createdAt: number;
}

export interface DiscoveryConfig {
  enabled: boolean;
  alchemyWsUrl: string;
  pollIntervalMs: number;
  marketCount: number;
  statsIntervalMs: number;
  retentionDays: number;
  readMode: 'v2-with-v1-fallback' | 'v2-primary';
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  enabled: false,
  alchemyWsUrl: '',
  pollIntervalMs: 30_000,
  marketCount: 50,
  statsIntervalMs: 300_000, // 5 min
  retentionDays: 90,
  readMode: 'v2-with-v1-fallback',
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

// ---------------------------------------------------------------------------
// Heat indicator
// ---------------------------------------------------------------------------

export type HeatIndicator = 'HOT' | 'WARMING' | 'STEADY' | 'COOLING' | 'COLD' | 'NEW';

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface WalletPosition {
  id?: number;
  address: string;
  conditionId: string;
  assetId: string;
  outcome?: string;
  marketSlug?: string;
  marketTitle?: string;
  side?: string;
  shares: number;
  avgEntry: number;
  totalCost: number;
  totalTrades: number;
  firstEntry: number;
  lastEntry: number;
  currentPrice?: number;
  priceUpdatedAt?: number;
  unrealizedPnl: number;
  roiPct: number;
  realizedPnl?: number;
  currentValue?: number;
  dataSource?: 'verified' | 'cached' | 'derived';
  positionStatus?: 'open' | 'redeemable' | 'closed';
  updatedAt?: number;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type SignalType =
  | 'SIZE_ANOMALY'
  | 'VOLUME_SPIKE'
  | 'DORMANT_ACTIVATION'
  | 'MARKET_PIONEER'
  | 'NEW_WHALE'
  | 'COORDINATED_ENTRY'
  | 'CONVICTION_BUILD';

export type SignalSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface DiscoverySignal {
  id?: number;
  signalType: SignalType;
  severity: SignalSeverity;
  address: string;
  conditionId?: string;
  marketTitle?: string;
  title: string;
  description: string;
  metadata?: Record<string, any>;
  detectedAt: number;
  dismissed: boolean;
}

// ---------------------------------------------------------------------------
// Signal thresholds (stored in discovery_config, editable at runtime)
// ---------------------------------------------------------------------------

export interface SignalThresholds {
  sizeAnomalyMultiplier: number;
  sizeAnomalyMinTrades: number;
  sizeAnomalyMinNotionalUsd: number;
  volumeSpikeMultiplier: number;
  volumeSpikeMinVolume: number;
  dormantDays: number;
  dormantMinVolume: number;
  newWhaleMinSize: number;
  marketPioneerMinPosition: number;
  marketPioneerMaxSmartMoney: number;
  smartMoneyScoreThreshold: number;
  coordinatedMinWallets: number;
  coordinatedMinVolume: number;
  coordinatedWindowMinutes: number;
  coordinatedMinAvgScore: number;
  convictionMinFills: number;
  convictionMinNotionalUsd: number;
  convictionWindowMinutes: number;
  maxSignalsPerDay: number;
}

export const DEFAULT_SIGNAL_THRESHOLDS: SignalThresholds = {
  sizeAnomalyMultiplier: 5,
  sizeAnomalyMinTrades: 5,
  sizeAnomalyMinNotionalUsd: 500,
  volumeSpikeMultiplier: 3,
  volumeSpikeMinVolume: 10000,
  dormantDays: 14,
  dormantMinVolume: 5000,
  newWhaleMinSize: 5000,
  marketPioneerMinPosition: 100000,
  marketPioneerMaxSmartMoney: 3,
  smartMoneyScoreThreshold: 60,
  coordinatedMinWallets: 3,
  coordinatedMinVolume: 50000,
  coordinatedWindowMinutes: 30,
  coordinatedMinAvgScore: 55,
  convictionMinFills: 4,
  convictionMinNotionalUsd: 5000,
  convictionWindowMinutes: 120,
  maxSignalsPerDay: 50,
};
