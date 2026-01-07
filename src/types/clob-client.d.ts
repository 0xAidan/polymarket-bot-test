declare module '@polymarket/clob-client' {
  import { BuilderConfig } from '@polymarket/builder-signing-sdk';

  export enum Side {
    BUY = 'BUY',
    SELL = 'SELL'
  }

  export enum OrderType {
    GTC = 'GTC', // Good-Til-Cancelled
    IOC = 'IOC', // Immediate-Or-Cancel
    FOK = 'FOK'  // Fill-Or-Kill
  }

  export interface ApiCredentials {
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
  }

  export interface ClobClientConfig {
    host: string;
    chainId: number;
    signer: any;
    apiCredentials?: ApiCredentials;
    signatureType?: number;
    funderAddress?: string;
  }

  export class ClobClient {
    constructor(
      host: string,
      chainId: number,
      signer: any,
      apiCredentials?: ApiCredentials,
      signatureType?: number,
      funderAddress?: string,
      relayer?: any,
      useRelayer?: boolean,
      builderConfig?: BuilderConfig
    );

    createOrDeriveApiKey(): Promise<ApiCredentials>;
    getMarket(tokenId: string): Promise<any>;
    createAndPostOrder(
      order: {
        tokenID: string;
        price: number;
        size: number;
        side: Side;
      },
      options?: {
        tickSize?: string | any;
        negRisk?: boolean;
      },
      orderType?: OrderType
    ): Promise<any>;
    getOpenOrders(): Promise<any[]>;
    cancelOrder(orderId: string): Promise<any>;
    cancelOrders(orderIds: string[]): Promise<any>;
    cancelAll(): Promise<any>;
  }

  export { Side, OrderType, ApiCredentials };
}
