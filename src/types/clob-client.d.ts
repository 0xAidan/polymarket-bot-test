// Fallback type declarations for @polymarket/clob-client-v2.
// The published package ships its own types; this shim exists in case the
// installed package's d.ts surface drifts from what we use. TypeScript will
// prefer the package's own typings when present.
declare module '@polymarket/clob-client-v2' {
  export enum Side {
    BUY = 'BUY',
    SELL = 'SELL',
  }

  export enum OrderType {
    GTC = 'GTC',
    IOC = 'IOC',
    FOK = 'FOK',
    GTD = 'GTD',
  }

  export interface ApiKeyCreds {
    key: string;
    secret: string;
    passphrase: string;
  }

  export interface BuilderConfig {
    builderCode: string;
  }

  export interface ClobClientOptions {
    host: string;
    chain: number;
    signer: any;
    creds?: ApiKeyCreds;
    signatureType?: number;
    funderAddress?: string;
    builderConfig?: BuilderConfig;
  }

  export interface UserOrder {
    tokenID: string;
    price: number;
    size: number;
    side: Side;
    feeRateBps?: never;
    nonce?: never;
    taker?: never;
    builderCode?: string;
  }

  export interface UserMarketOrder {
    tokenID: string;
    amount: number;
    side: Side;
    builderCode?: string;
    userUSDCBalance?: number;
  }

  export class ClobClient {
    constructor(opts: ClobClientOptions);
    createOrDeriveApiKey(): Promise<ApiKeyCreds>;
    getMarket(tokenId: string): Promise<any>;
    createAndPostOrder(
      order: UserOrder & { builderCode?: string; userUSDCBalance?: number },
      options?: { tickSize?: string | any; negRisk?: boolean },
      orderType?: OrderType,
    ): Promise<any>;
    getOpenOrders(): Promise<any[]>;
    cancelOrder(orderId: string): Promise<any>;
    cancelOrders(orderIds: string[]): Promise<any>;
    cancelAll(): Promise<any>;
    getBalanceAllowance(params: { asset_type: string }): Promise<any>;
  }
}
