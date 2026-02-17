import * as ethers from 'ethers';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';

// In-memory store of decrypted wallets (populated at unlock time)
const decryptedWallets = new Map<string, ethers.Wallet>();

// In-memory store of decrypted Builder API credentials per wallet
export interface BuilderCredentials {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}
const decryptedBuilderCreds = new Map<string, BuilderCredentials>();

let isUnlocked = false;

/**
 * Get the keystores directory path (dynamic for tests).
 */
function keystoresDir(): string {
  return path.join(config.dataDir, 'keystores');
}

/**
 * Ensure the keystores directory exists.
 */
async function ensureKeystoresDir(): Promise<void> {
  await fs.mkdir(keystoresDir(), { recursive: true });
}

/**
 * Encrypt a private key using AES-256-GCM with a password-derived key.
 * Uses scrypt for key derivation (EVM best practice).
 */
function encryptPrivateKey(privateKey: string, password: string): string {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    version: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    encrypted,
  });
}

/**
 * Decrypt a private key encrypted with encryptPrivateKey.
 */
function decryptPrivateKey(encryptedData: string, password: string): string {
  const data = JSON.parse(encryptedData);
  const salt = Buffer.from(data.salt, 'hex');
  const iv = Buffer.from(data.iv, 'hex');
  const authTag = Buffer.from(data.authTag, 'hex');
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Add a new wallet by encrypting its private key and storing it.
 * Optionally also encrypts and stores Builder API credentials.
 * Returns the wallet address derived from the private key.
 */
export async function addEncryptedWallet(
  walletId: string,
  privateKey: string,
  masterPassword: string,
  builderCreds?: BuilderCredentials
): Promise<string> {
  await ensureKeystoresDir();

  // Validate the private key
  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(privateKey);
  } catch {
    throw new Error('Invalid private key');
  }

  const filePath = path.join(keystoresDir(), `${walletId}.keystore.json`);

  // Check if wallet already exists
  try {
    await fs.access(filePath);
    throw new Error(`Wallet "${walletId}" already exists`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  const encrypted = encryptPrivateKey(privateKey, masterPassword);
  await fs.writeFile(filePath, encrypted, 'utf-8');

  // Store decrypted wallet in memory
  decryptedWallets.set(walletId, wallet);

  // Store Builder API credentials if provided
  if (builderCreds && builderCreds.apiKey && builderCreds.apiSecret && builderCreds.apiPassphrase) {
    await saveBuilderCredentials(walletId, builderCreds, masterPassword);
    decryptedBuilderCreds.set(walletId, builderCreds);
  }

  return wallet.address;
}

/**
 * Save Builder API credentials encrypted on disk for a wallet.
 */
async function saveBuilderCredentials(
  walletId: string,
  creds: BuilderCredentials,
  masterPassword: string
): Promise<void> {
  await ensureKeystoresDir();
  const credsJson = JSON.stringify(creds);
  const encrypted = encryptPrivateKey(credsJson, masterPassword);
  const filePath = path.join(keystoresDir(), `${walletId}.builder.json`);
  await fs.writeFile(filePath, encrypted, 'utf-8');
}

/**
 * Update Builder API credentials for an existing wallet.
 */
export async function updateBuilderCredentials(
  walletId: string,
  creds: BuilderCredentials,
  masterPassword: string
): Promise<void> {
  await saveBuilderCredentials(walletId, creds, masterPassword);
  decryptedBuilderCreds.set(walletId, creds);
}

/**
 * Get decrypted Builder API credentials for a wallet (must be unlocked).
 */
export function getBuilderCredentials(walletId: string): BuilderCredentials | undefined {
  return decryptedBuilderCreds.get(walletId);
}

/**
 * Check if a wallet has stored Builder API credentials on disk.
 */
export async function hasBuilderCredentials(walletId: string): Promise<boolean> {
  const filePath = path.join(keystoresDir(), `${walletId}.builder.json`);
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove an encrypted wallet and its Builder credentials.
 */
export async function removeEncryptedWallet(walletId: string): Promise<void> {
  const filePath = path.join(keystoresDir(), `${walletId}.keystore.json`);
  try {
    await fs.unlink(filePath);
  } catch (err: any) {
    if (err.code === 'ENOENT') throw new Error(`Wallet "${walletId}" not found`);
    throw err;
  }
  decryptedWallets.delete(walletId);

  // Also remove Builder credentials file if it exists
  const builderPath = path.join(keystoresDir(), `${walletId}.builder.json`);
  try {
    await fs.unlink(builderPath);
  } catch {
    // Ignore — file may not exist
  }
  decryptedBuilderCreds.delete(walletId);
}

/**
 * Unlock all stored wallets using the master password.
 * Decrypts all keystore files and Builder credential files, holds them in memory.
 */
export async function unlockAllWallets(masterPassword: string): Promise<string[]> {
  await ensureKeystoresDir();

  const files = await fs.readdir(keystoresDir());
  const keystoreFiles = files.filter(f => f.endsWith('.keystore.json'));

  const walletIds: string[] = [];

  for (const file of keystoreFiles) {
    const walletId = file.replace('.keystore.json', '');
    const filePath = path.join(keystoresDir(), file);
    const encryptedData = await fs.readFile(filePath, 'utf-8');

    try {
      const privateKey = decryptPrivateKey(encryptedData, masterPassword);
      const wallet = new ethers.Wallet(privateKey);
      decryptedWallets.set(walletId, wallet);
      walletIds.push(walletId);
    } catch {
      console.error(`[SecureKeys] Failed to decrypt wallet "${walletId}" — wrong password or corrupted file`);
      throw new Error(`Failed to decrypt wallet "${walletId}". Check your master password.`);
    }

    // Also decrypt Builder credentials if they exist
    const builderPath = path.join(keystoresDir(), `${walletId}.builder.json`);
    try {
      const builderData = await fs.readFile(builderPath, 'utf-8');
      const credsJson = decryptPrivateKey(builderData, masterPassword);
      const creds: BuilderCredentials = JSON.parse(credsJson);
      decryptedBuilderCreds.set(walletId, creds);
      console.log(`[SecureKeys] Loaded Builder credentials for wallet "${walletId}"`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.warn(`[SecureKeys] Could not decrypt Builder credentials for "${walletId}":`, err.message);
      }
      // No builder creds file is fine — wallet just won't have them
    }
  }

  isUnlocked = true;
  console.log(`[SecureKeys] Unlocked ${walletIds.length} wallet(s)`);
  return walletIds;
}

/**
 * Get a decrypted ethers.Wallet by ID.
 * Must call unlockAllWallets first.
 */
export function getSigner(walletId: string): ethers.Wallet {
  const wallet = decryptedWallets.get(walletId);
  if (!wallet) {
    throw new Error(`Wallet "${walletId}" not found or not unlocked`);
  }
  return wallet;
}

/**
 * Get the address for a wallet ID without the full signer.
 */
export function getWalletAddress(walletId: string): string {
  return getSigner(walletId).address;
}

/**
 * Check if wallets are unlocked.
 */
export function isWalletUnlocked(): boolean {
  return isUnlocked;
}

/**
 * Get all unlocked wallet IDs.
 */
export function getUnlockedWalletIds(): string[] {
  return Array.from(decryptedWallets.keys());
}

/**
 * List all stored wallet IDs (without decrypting).
 */
export async function listStoredWalletIds(): Promise<string[]> {
  await ensureKeystoresDir();
  const files = await fs.readdir(keystoresDir());
  return files
    .filter(f => f.endsWith('.keystore.json'))
    .map(f => f.replace('.keystore.json', ''));
}

/**
 * Lock all wallets (clear all decrypted data from memory).
 */
export function lockAllWallets(): void {
  decryptedWallets.clear();
  decryptedBuilderCreds.clear();
  isUnlocked = false;
}

/**
 * Migrate the existing .env PRIVATE_KEY into an encrypted keystore.
 * This is a one-time migration for users upgrading from single-wallet.
 */
export async function migrateEnvPrivateKey(masterPassword: string): Promise<string | null> {
  const envKey = config.privateKey;
  if (!envKey) return null;

  // Check if "main" wallet already exists
  const existing = await listStoredWalletIds();
  if (existing.includes('main')) {
    console.log('[SecureKeys] "main" wallet already exists, skipping migration');
    return null;
  }

  try {
    const address = await addEncryptedWallet('main', envKey, masterPassword);
    console.log(`[SecureKeys] Migrated .env PRIVATE_KEY to encrypted keystore as "main" (${address})`);
    return address;
  } catch (err) {
    console.error('[SecureKeys] Failed to migrate .env private key:', err);
    return null;
  }
}
