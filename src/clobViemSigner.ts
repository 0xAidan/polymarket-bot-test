import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config } from './config.js';

/**
 * Polymarket CLOB v2 SDK expects a viem WalletClient (see @polymarket/clob-client-v2 README).
 * ethers v6 Wallet exposes signTypedData but not _signTypedData, which the SDK mis-detects as viem
 * without an account and throws "wallet client is missing account address".
 */
export const createClobViemWalletClient = (privateKey: string): WalletClient => {
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(normalized as `0x${string}`);
  return createWalletClient({
    account,
    chain: polygon,
    transport: http(config.polygonRpcUrl),
  });
};
