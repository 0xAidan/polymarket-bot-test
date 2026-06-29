const FORBIDDEN_KEY_PATTERNS = [
  /^privateKey$/i,
  /^private_key$/i,
  /^encrypted$/i,
  /^ciphertext$/i,
  /^mnemonic$/i,
  /^seed$/i,
  /^apiKey$/i,
  /^apiSecret$/i,
  /^apiPassphrase$/i,
  /^api_secret$/i,
  /^api_passphrase$/i,
  /^polymarketBuilderCode$/i,
  /^builderCode$/i,
  /^masterPassword$/i,
  /^keystore$/i,
  /^keystoreJson$/i,
  /^decrypted$/i,
  /^credentials$/i,
  /^WALLET_ENCRYPTION_PASSWORD$/i,
  /^AUTH_SESSION_SECRET$/i,
  /^API_SECRET$/i,
];

const PRIVATE_KEY_HEX_RE = /^0x[a-fA-F0-9]{64}$/;

const isForbiddenKey = (key: string): boolean => (
  FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key))
);

const sanitizeStringValue = (value: string): string => {
  if (PRIVATE_KEY_HEX_RE.test(value.trim())) {
    return '[REDACTED]';
  }
  return value;
};

export const sanitizeAdminAnalyticsPayload = <T>(value: T): T => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeStringValue(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAdminAnalyticsPayload(item)) as T;
  }

  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(input)) {
      if (isForbiddenKey(key)) {
        continue;
      }
      output[key] = sanitizeAdminAnalyticsPayload(nested);
    }
    return output as T;
  }

  return value;
};
