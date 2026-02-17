// ============================================================================
// Platform Abstraction Layer — Shared Types
// ============================================================================

/** Supported prediction market platforms */
export type Platform = 'polymarket' | 'kalshi';

/** Normalized market representation across platforms */
export interface NormalizedMarket {
  platform: Platform;
  id: string;           // Platform-specific identifier (tokenId or ticker)
  title: string;
  slug: string;
  status: 'open' | 'closed' | 'resolved';
  yesPrice: number;     // 0-1 for Polymarket, converted from cents for Kalshi
  noPrice: number;
  volume: number;
  lastUpdated: number;  // Unix ms
}

/** Normalized position across platforms */
export interface NormalizedPosition {
  platform: Platform;
  marketId: string;     // tokenId (Poly) or ticker (Kalshi)
  marketTitle: string;
  outcome: string;      // 'YES' | 'NO' or label
  side: 'YES' | 'NO';
  size: number;
  avgPrice: number;
  currentPrice: number;
  conditionId?: string; // Polymarket conditionId (for cross-platform matching)
}

/** Normalized order result */
export interface NormalizedOrderResult {
  platform: Platform;
  success: boolean;
  orderId?: string;
  txHash?: string;
  status?: string;
  error?: string;
}

/** Order request to place on any platform */
export interface PlaceOrderRequest {
  platform: Platform;
  marketId: string;     // tokenId (Poly) or ticker (Kalshi)
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  size: number;         // Shares (Poly) or contracts (Kalshi)
  price: number;        // 0-1 for Poly, 0-1 for Kalshi (adapter converts to cents)
}

/** Platform adapter interface — each platform implements this */
export interface PlatformAdapter {
  readonly platform: Platform;

  /** Whether this platform is configured and ready to use */
  isConfigured(): boolean;

  /** Whether this platform can execute trades (has credentials) */
  canExecute(): boolean;

  /** Get current market price */
  getMarketPrice(marketId: string): Promise<{ yesPrice: number; noPrice: number } | null>;

  /** Get positions for a wallet/account */
  getPositions(identifier: string): Promise<NormalizedPosition[]>;

  /** Place an order */
  placeOrder(order: PlaceOrderRequest): Promise<NormalizedOrderResult>;

  /** Get account balance in USD */
  getBalance(): Promise<number | null>;

  /** Get platform-specific status */
  getStatus(): { configured: boolean; canExecute: boolean; label: string };
}
