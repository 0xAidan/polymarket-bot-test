import * as ethers from 'ethers';

const PLACEHOLDER_PATTERNS = [
  'your_proxy_wallet_address_here',
  'your_wallet_address_here',
  'your_address_here',
];

export const normalizeAddress = (value: unknown): string => String(value ?? '').trim().toLowerCase();

export const getValidEvmAddress = (value: unknown): string | null => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  if (PLACEHOLDER_PATTERNS.some((pattern) => lower.includes(pattern))) {
    return null;
  }

  try {
    return (ethers as any).utils.getAddress(raw).toLowerCase();
  } catch {
    return null;
  }
};
