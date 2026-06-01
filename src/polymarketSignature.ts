export enum PolymarketSignatureType {
  EOA = 0,
  POLY_PROXY = 1,
  POLY_GNOSIS_SAFE = 2,
  POLY_1271 = 3,
}

export const describeSignatureType = (signatureType: number): string => {
  switch (signatureType) {
    case PolymarketSignatureType.EOA:
      return 'EOA (0)';
    case PolymarketSignatureType.POLY_PROXY:
      return 'POLY_PROXY (1)';
    case PolymarketSignatureType.POLY_GNOSIS_SAFE:
      return 'POLY_GNOSIS_SAFE (2)';
    case PolymarketSignatureType.POLY_1271:
      return 'POLY_1271 (3)';
    default:
      return `UNKNOWN (${signatureType})`;
  }
};

/**
 * For non-EOA flows, signer and funder are typically different addresses.
 * If they match, users often configured the wrong funder/proxy/deposit wallet.
 */
export const shouldUseDistinctFunder = (signatureType: number): boolean =>
  signatureType !== PolymarketSignatureType.EOA;

export const shouldUseProxyRelayerTxType = (signatureType: number): boolean =>
  signatureType === PolymarketSignatureType.POLY_PROXY;
