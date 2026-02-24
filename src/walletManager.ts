import { TradingWallet, CopyAssignment } from './types.js';
import { config } from './config.js';
import {
  addEncryptedWallet,
  removeEncryptedWallet,
  getUnlockedWalletIds,
  isWalletUnlocked,
  unlockAllWallets,
  listStoredWalletIds,
  lockAllWallets,
  migrateEnvPrivateKey,
  hasBuilderCredentials,
  getBuilderCredentials,
  updateBuilderCredentials,
  type BuilderCredentials,
} from './secureKeyManager.js';
import { Storage } from './storage.js';

// In-memory trading wallet registry
let tradingWallets: TradingWallet[] = [];
let copyAssignments: CopyAssignment[] = [];

const WALLETS_CONFIG_KEY = 'tradingWallets';
const ASSIGNMENTS_CONFIG_KEY = 'copyAssignments';

// ============================================================================
// PERSISTENCE (via bot_config key-value store)
// ============================================================================

async function loadWalletConfig(): Promise<void> {
  const cfg = await Storage.loadConfig();
  tradingWallets = cfg[WALLETS_CONFIG_KEY] ?? [];
  copyAssignments = cfg[ASSIGNMENTS_CONFIG_KEY] ?? [];
}

async function saveWalletConfig(): Promise<void> {
  const cfg = await Storage.loadConfig();
  cfg[WALLETS_CONFIG_KEY] = tradingWallets;
  cfg[ASSIGNMENTS_CONFIG_KEY] = copyAssignments;
  await Storage.saveConfig(cfg);
}

// ============================================================================
// WALLET CRUD
// ============================================================================

/**
 * Initialize the wallet manager. Loads config from storage.
 */
export async function initWalletManager(): Promise<void> {
  await loadWalletConfig();
  console.log(`[WalletManager] Loaded ${tradingWallets.length} trading wallet(s)`);
}

/**
 * Add a new trading wallet.
 * The private key is encrypted and stored; only the address is kept in config.
 * Builder API credentials (apiKey, apiSecret, apiPassphrase) are also encrypted and stored.
 * Without Builder credentials, the wallet cannot place orders on Polymarket.
 */
export async function addTradingWallet(
  id: string,
  label: string,
  privateKey: string,
  masterPassword: string,
  builderCreds?: BuilderCredentials
): Promise<TradingWallet> {
  // Check for duplicate ID
  if (tradingWallets.find(w => w.id === id)) {
    throw new Error(`Trading wallet "${id}" already exists`);
  }

  // Encrypt and store the private key (+ Builder creds if provided)
  const address = await addEncryptedWallet(id, privateKey, masterPassword, builderCreds);

  const hasBuilder = !!(builderCreds?.apiKey && builderCreds?.apiSecret && builderCreds?.apiPassphrase);

  const wallet: TradingWallet = {
    id,
    label,
    address,
    isActive: true,
    createdAt: new Date().toISOString(),
    hasCredentials: hasBuilder,
  };

  if (!hasBuilder) {
    console.warn(`[WalletManager] ⚠️  Wallet "${id}" added WITHOUT Builder API credentials — it will NOT be able to place orders.`);
  }

  tradingWallets.push(wallet);
  await saveWalletConfig();

  console.log(`[WalletManager] Added trading wallet "${id}" (${address}) — Builder creds: ${hasBuilder ? 'YES' : 'NO'}`);
  return wallet;
}

/**
 * Remove a trading wallet.
 */
export async function removeTradingWallet(id: string): Promise<void> {
  const idx = tradingWallets.findIndex(w => w.id === id);
  if (idx === -1) throw new Error(`Trading wallet "${id}" not found`);

  await removeEncryptedWallet(id);
  tradingWallets.splice(idx, 1);

  // Also remove any copy assignments pointing to this wallet
  copyAssignments = copyAssignments.filter(a => a.tradingWalletId !== id);

  await saveWalletConfig();
  console.log(`[WalletManager] Removed trading wallet "${id}"`);
}

/**
 * Toggle a trading wallet active/inactive.
 */
export async function toggleTradingWallet(id: string, active?: boolean): Promise<TradingWallet> {
  const wallet = tradingWallets.find(w => w.id === id);
  if (!wallet) throw new Error(`Trading wallet "${id}" not found`);

  wallet.isActive = active !== undefined ? active : !wallet.isActive;
  await saveWalletConfig();
  return wallet;
}

/**
 * Update a trading wallet's label.
 */
export async function updateTradingWalletLabel(id: string, label: string): Promise<TradingWallet> {
  const wallet = tradingWallets.find(w => w.id === id);
  if (!wallet) throw new Error(`Trading wallet "${id}" not found`);

  wallet.label = label;
  await saveWalletConfig();
  return wallet;
}

/**
 * Get all trading wallets.
 */
export function getTradingWallets(): TradingWallet[] {
  return [...tradingWallets];
}

/**
 * Get a specific trading wallet by ID.
 */
export function getTradingWallet(id: string): TradingWallet | undefined {
  return tradingWallets.find(w => w.id === id);
}

/**
 * Get active trading wallets only.
 */
export function getActiveTradingWallets(): TradingWallet[] {
  return tradingWallets.filter(w => w.isActive);
}

// ============================================================================
// COPY ASSIGNMENTS
// ============================================================================

/**
 * Assign a tracked wallet to copy to a specific trading wallet.
 */
export async function addCopyAssignment(
  trackedWalletAddress: string,
  tradingWalletId: string,
  useOwnConfig = false
): Promise<CopyAssignment> {
  // Validate trading wallet exists
  if (!tradingWallets.find(w => w.id === tradingWalletId)) {
    throw new Error(`Trading wallet "${tradingWalletId}" not found`);
  }

  // Check for duplicate assignment
  const existing = copyAssignments.find(
    a => a.trackedWalletAddress.toLowerCase() === trackedWalletAddress.toLowerCase()
      && a.tradingWalletId === tradingWalletId
  );
  if (existing) {
    throw new Error(`Assignment already exists: ${trackedWalletAddress} → ${tradingWalletId}`);
  }

  const assignment: CopyAssignment = {
    trackedWalletAddress: trackedWalletAddress.toLowerCase(),
    tradingWalletId,
    useOwnConfig,
  };

  copyAssignments.push(assignment);
  await saveWalletConfig();
  return assignment;
}

/**
 * Remove a copy assignment.
 */
export async function removeCopyAssignment(
  trackedWalletAddress: string,
  tradingWalletId: string
): Promise<void> {
  const before = copyAssignments.length;
  copyAssignments = copyAssignments.filter(
    a => !(a.trackedWalletAddress.toLowerCase() === trackedWalletAddress.toLowerCase()
      && a.tradingWalletId === tradingWalletId)
  );

  if (copyAssignments.length === before) {
    throw new Error(`Assignment not found: ${trackedWalletAddress} → ${tradingWalletId}`);
  }

  await saveWalletConfig();
}

/**
 * Get all copy assignments.
 */
export function getCopyAssignments(): CopyAssignment[] {
  return [...copyAssignments];
}

// ============================================================================
// WALLET UNLOCK / LOCK
// ============================================================================

/**
 * Unlock all wallets with the master password.
 * Optionally migrates the .env PRIVATE_KEY into encrypted storage.
 * Also refreshes hasCredentials flag on all wallets.
 */
export async function unlockWallets(masterPassword: string): Promise<{ unlocked: string[]; migrated: boolean }> {
  // First, try to migrate the .env private key if applicable
  let migrated = false;
  const migratedAddr = await migrateEnvPrivateKey(masterPassword);
  if (migratedAddr) {
    migrated = true;
    // Reload wallet config in case migration added the main wallet
    await loadWalletConfig();

    // If the main wallet isn't in config yet, add it
    if (!tradingWallets.find(w => w.id === 'main')) {
      tradingWallets.push({
        id: 'main',
        label: 'Main Wallet',
        address: migratedAddr,
        isActive: true,
        createdAt: new Date().toISOString(),
        hasCredentials: false,
      });
      await saveWalletConfig();
    }
  }

  // Unlock all keystores (also decrypts Builder credentials)
  const unlocked = await unlockAllWallets(masterPassword);

  // Refresh hasCredentials flag on all wallets based on actual stored files
  let configChanged = false;
  for (const wallet of tradingWallets) {
    const hasCreds = await hasBuilderCredentials(wallet.id);
    if (wallet.hasCredentials !== hasCreds) {
      wallet.hasCredentials = hasCreds;
      configChanged = true;
    }
  }
  if (configChanged) {
    await saveWalletConfig();
  }

  return { unlocked, migrated };
}

/**
 * Update Builder API credentials for an existing trading wallet.
 */
export async function updateWalletBuilderCredentials(
  id: string,
  creds: BuilderCredentials,
  masterPassword: string
): Promise<TradingWallet> {
  const wallet = tradingWallets.find(w => w.id === id);
  if (!wallet) throw new Error(`Trading wallet "${id}" not found`);

  await updateBuilderCredentials(id, creds, masterPassword);

  wallet.hasCredentials = true;
  await saveWalletConfig();

  console.log(`[WalletManager] Updated Builder credentials for wallet "${id}"`);
  return wallet;
}

/**
 * Lock all wallets (clear from memory).
 */
export { lockAllWallets };

/**
 * Check if wallets are unlocked.
 */
export { isWalletUnlocked };

/**
 * Get Builder API credentials for a wallet (must be unlocked).
 */
export { getBuilderCredentials };

/**
 * List stored wallet IDs (without decrypting).
 */
export { listStoredWalletIds };

/**
 * Get all unlocked wallet IDs.
 */
export { getUnlockedWalletIds };
