declare module '@polymarket/builder-signing-sdk' {
  export interface BuilderApiKeyCreds {
    key: string;
    secret: string;
    passphrase: string;
  }

  export interface LocalBuilderConfig {
    localBuilderCreds: BuilderApiKeyCreds;
  }

  export interface RemoteBuilderConfig {
    remoteBuilderConfig: {
      url: string;
    };
  }

  export class BuilderConfig {
    constructor(config: LocalBuilderConfig | RemoteBuilderConfig);
  }

  export function buildHmacSignature(
    secret: string,
    timestamp: number,
    method: string,
    path: string,
    body?: string
  ): string;
}
