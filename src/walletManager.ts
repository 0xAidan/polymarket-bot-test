import { TradingWallet, CopyAssignment } from './types.js';
import { isHostedMultiTenantMode } from './hostedMode.js';
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
import { createComponentLogger } from './logger.js';
import { Storage } from './storage.js';
import { getTenantIdOrDefault } from './tenantContext.js';

const log = createComponentLogger('WalletManager');

type TenantWalletState = {
  loaded: boolean;
  tradingWallets: TradingWallet[];
  copyAssignments: CopyAssignment[];
};

const walletStateByTenant = new Map<string, TenantWalletState>();

const WALLETS_CONFIG_KEY = 'tradingWallets';
const ASSIGNMENTS_CONFIG_KEY = 'copyAssignments';

// ============================================================================
// PERSISTENCE (via bot_config key-value store)
// ============================================================================

function scopedTenantId(): string {
  return getTenantIdOrDefault();
}

function getOrCreateTenantState(): TenantWalletState {
  const tenantId = scopedTenantId();
  let state = walletStateByTenant.get(tenantId);
  if (!state) {
    state = { loaded: false, tradingWallets: [], copyAssignments: [] };
    walletStateByTenant.set(tenantId, state);
  }
  return state;
}

async function loadWalletConfig(): Promise<void> {
  const cfg = await Storage.loadConfig();
  const state = getOrCreateTenantState();
  state.tradingWallets = cfg[WALLETS_CONFIG_KEY] ?? [];
  state.copyAssignments = cfg[ASSIGNMENTS_CONFIG_KEY] ?? [];
  state.loaded = true;
}

async function saveWalletConfig(): Promise<void> {
  const state = getOrCreateTenantState();
  const cfg = await Storage.loadConfig();
  cfg[WALLETS_CONFIG_KEY] = state.tradingWallets;
  cfg[ASSIGNMENTS_CONFIG_KEY] = state.copyAssignments;
  await Storage.saveConfig(cfg);
}

async function ensureWalletConfigLoaded(): Promise<TenantWalletState> {
  const state = getOrCreateTenantState();
  if (!state.loaded) {
    await loadWalletConfig();
  }
  return getOrCreateTenantState();
}

// ============================================================================
// WALLET CRUD
// ============================================================================

/**
 * Initialize the wallet manager. Loads config from storage.
 */
export async function initWalletManager(): Promise<void> {
  await loadWalletConfig();
  const state = getOrCreateTenantState();
  log.info(`[WalletManager] Loaded ${state.tradingWallets.length} trading wallet(s) for tenant ${scopedTenantId()}`);
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
  const state = await ensureWalletConfigLoaded();
  // Check for duplicate ID
  if (state.tradingWallets.find(w => w.id === id)) {
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
    log.warn(`[WalletManager] ⚠️  Wallet "${id}" added WITHOUT Builder API credentials — it will NOT be able to place orders.`);
  }

  state.tradingWallets.push(wallet);
  await saveWalletConfig();

  log.info(`[WalletManager] Added trading wallet "${id}" (${address}) — Builder creds: ${hasBuilder ? 'YES' : 'NO'}`);
  return wallet;
}

/**
 * Remove a trading wallet.
 */
export async function removeTradingWallet(id: string): Promise<void> {
  const state = await ensureWalletConfigLoaded();
  const idx = state.tradingWallets.findIndex(w => w.id === id);
  if (idx === -1) throw new Error(`Trading wallet "${id}" not found`);

  await removeEncryptedWallet(id);
  state.tradingWallets.splice(idx, 1);

  // Also remove any copy assignments pointing to this wallet
  state.copyAssignments = state.copyAssignments.filter(a => a.tradingWalletId !== id);

  await saveWalletConfig();
  log.info(`[WalletManager] Removed trading wallet "${id}"`);
}

/**
 * Toggle a trading wallet active/inactive.
 */
export async function toggleTradingWallet(id: string, active?: boolean): Promise<TradingWallet> {
  const state = await ensureWalletConfigLoaded();
  const wallet = state.tradingWallets.find(w => w.id === id);
  if (!wallet) throw new Error(`Trading wallet "${id}" not found`);

  wallet.isActive = active !== undefined ? active : !wallet.isActive;
  await saveWalletConfig();
  return wallet;
}

/**
 * Update a trading wallet's label.
 */
export async function updateTradingWalletLabel(id: string, label: string): Promise<TradingWallet> {
  const state = await ensureWalletConfigLoaded();
  const wallet = state.tradingWallets.find(w => w.id === id);
  if (!wallet) throw new Error(`Trading wallet "${id}" not found`);

  wallet.label = label;
  await saveWalletConfig();
  return wallet;
}

/**
 * Get all trading wallets.
 */
export function getTradingWallets(): TradingWallet[] {
  const state = getOrCreateTenantState();
  return [...state.tradingWallets];
}

/**
 * Get a specific trading wallet by ID.
 */
export function getTradingWallet(id: string): TradingWallet | undefined {
  const state = getOrCreateTenantState();
  return state.tradingWallets.find(w => w.id === id);
}

/**
 * Get active trading wallets only.
 */
export function getActiveTradingWallets(): TradingWallet[] {
  const state = getOrCreateTenantState();
  return state.tradingWallets.filter(w => w.isActive);
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
  const state = await ensureWalletConfigLoaded();
  // Validate trading wallet exists
  if (!state.tradingWallets.find(w => w.id === tradingWalletId)) {
    throw new Error(`Trading wallet "${tradingWalletId}" not found`);
  }

  // Check for duplicate assignment
  const existing = state.copyAssignments.find(
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

  state.copyAssignments.push(assignment);
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
  const state = await ensureWalletConfigLoaded();
  const before = state.copyAssignments.length;
  state.copyAssignments = state.copyAssignments.filter(
    a => !(a.trackedWalletAddress.toLowerCase() === trackedWalletAddress.toLowerCase()
      && a.tradingWalletId === tradingWalletId)
  );

  if (state.copyAssignments.length === before) {
    throw new Error(`Assignment not found: ${trackedWalletAddress} → ${tradingWalletId}`);
  }

  await saveWalletConfig();
}

/**
 * Get all copy assignments.
 */
export function getCopyAssignments(): CopyAssignment[] {
  const state = getOrCreateTenantState();
  return [...state.copyAssignments];
}

/**
 * Get copy assignments for a specific tracked wallet.
 */
export function getAssignmentsForTrackedWallet(trackedWalletAddress: string): CopyAssignment[] {
  const state = getOrCreateTenantState();
  const lowerAddress = trackedWalletAddress.toLowerCase();
  return state.copyAssignments.filter(a => a.trackedWalletAddress === lowerAddress);
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
  const state = await ensureWalletConfigLoaded();
  // First, try to migrate the .env private key if applicable (never in hosted multi-tenant mode)
  let migrated = false;
  const migratedAddr = isHostedMultiTenantMode()
    ? null
    : await migrateEnvPrivateKey(masterPassword);
  if (migratedAddr) {
    migrated = true;
    // Reload wallet config in case migration added the main wallet
    await loadWalletConfig();

    // If the main wallet isn't in config yet, add it
    if (!state.tradingWallets.find(w => w.id === 'main')) {
      state.tradingWallets.push({
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
  for (const wallet of state.tradingWallets) {
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
  const state = await ensureWalletConfigLoaded();
  const wallet = state.tradingWallets.find(w => w.id === id);
  if (!wallet) throw new Error(`Trading wallet "${id}" not found`);

  await updateBuilderCredentials(id, creds, masterPassword);

  wallet.hasCredentials = true;
  await saveWalletConfig();

  log.info(`[WalletManager] Updated Builder credentials for wallet "${id}"`);
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
