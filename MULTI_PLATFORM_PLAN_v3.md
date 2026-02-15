# Multi-Platform Prediction Market Bot — Expansion Plan v3.0

**Version:** 3.0  
**Date:** February 15, 2026  
**Status:** Active — Awaiting decisions and Dome API key  
**Branch:** `feature/advanced-trade-filters` (current working branch)  
**Audience:** Engineering team, collaborators

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What's New in v3.0](#2-whats-new-in-v30)
3. [Lessons Learned from v1 Attempt](#3-lessons-learned-from-v1-attempt)
4. [Non-Negotiable Rules](#4-non-negotiable-rules)
5. [Current System Snapshot](#5-current-system-snapshot)
6. [Dome API — What It Is and What We Use](#6-dome-api--what-it-is-and-what-we-use)
7. [Security Architecture — EVM Key Management](#7-security-architecture--evm-key-management)
8. [Phase 0A: Codebase Cleanup](#8-phase-0a-codebase-cleanup)
9. [Phase 0B: SQLite Infrastructure Hardening](#9-phase-0b-sqlite-infrastructure-hardening)
10. [Phase 1A: Dome Integration + WebSocket Real-Time](#10-phase-1a-dome-integration--websocket-real-time)
11. [Phase 1B: Multi-Wallet Architecture](#11-phase-1b-multi-wallet-architecture)
12. [Phase 2: Win95 UI Rewrite](#12-phase-2-win95-ui-rewrite)
13. [Phase 3: Auto-Redeem + Position Lifecycle](#13-phase-3-auto-redeem--position-lifecycle)
14. [Phase 4: Arbitrage Detection](#14-phase-4-arbitrage-detection)
15. [Phase 5: Wallet Entity Linking + Hedge Detection](#15-phase-5-wallet-entity-linking--hedge-detection)
16. [Phase 6: One-Click Hedge + Auto-Execute Arbitrage](#16-phase-6-one-click-hedge--auto-execute-arbitrage)
17. [Phase 7: Ladder Exit Strategy + Smart Stop-Loss](#17-phase-7-ladder-exit-strategy--smart-stop-loss)
18. [Full Dashboard Mockups (Win95 Theme)](#18-full-dashboard-mockups-win95-theme)
19. [Testing Strategy](#19-testing-strategy)
20. [Master Timeline](#20-master-timeline)
21. [Technical Reference](#21-technical-reference)
22. [Risk Register](#22-risk-register)
23. [Open Decisions](#23-open-decisions)
24. [What Is Required From You (Aidan)](#24-what-is-required-from-you-aidan)

---

## 1. Executive Summary

We are transforming our Polymarket copy-trading bot into a **multi-platform, multi-wallet prediction market trading system** with a distinctive retro Windows 95 interface. The system will:

- **Support multiple trading wallets** — Each with its own private key, balance, and configuration, managed from one dashboard
- **Monitor trades in real-time** via Dome WebSocket (replacing 5-second polling)
- **See cross-platform data** from Polymarket + Kalshi via Dome API
- **Auto-redeem winning bets** and close resolved positions without manual intervention
- **Detect arbitrage opportunities** when the same event has different prices across platforms
- **Auto-execute arbitrage trades** when spread exceeds a configurable threshold
- **Link wallets into entities** to detect when the same person is hedging across platforms
- **One-click hedge** any position across platforms
- **Automated ladder exits** for profit-taking at multiple price levels
- **Smart stop-loss** with recovery-based calculations and trailing stops
- **Store all sensitive data securely** using encrypted keystores and EVM best practices

### Design Principles

1. **Additive, not destructive.** Every feature is added alongside existing code. Nothing that works today should break.
2. **Paper mode first.** Any feature that touches real money launches in paper/simulation mode.
3. **One PR per phase.** Each phase is a standalone PR reviewed and merged independently.
4. **Encrypted by default.** Private keys never stored in plaintext after Phase 1B.
5. **Multi-wallet native.** Every new feature is built with N wallets in mind from the start.

---

## 2. What's New in v3.0

| Feature | Status in v2.0 | Status in v3.0 |
|---|---|---|
| Multi-wallet (N private keys, N trading accounts) | Not planned | **Phase 1B** — full architecture |
| Win95 retro UI | Not planned | **Phase 2** — complete rewrite |
| Codebase cleanup (debug shims, dead code) | Mentioned as "out of scope" | **Phase 0A** — dedicated phase |
| Auto-redeem winning bets | Not planned | **Phase 3** — on-chain CTF redemption |
| Auto-close losing positions (merge) | Not planned | **Phase 3** — CTF merge positions |
| Encrypted private key storage | Plaintext .env | **Phase 1B** — AES-256-GCM encrypted keystore |
| Dome Order Router for execution | Not planned | **Phase 1B** — primary execution method for multi-wallet |
| "Copy config from" another wallet | Not planned | **Phase 1B** — UX for cloning filter configs |

---

## 3. Lessons Learned from v1 Attempt

*(Unchanged from v2.0 — see previous plan for full details)*

Key points:
- Never delete working utility files without updating callers
- Never simplify public API return types
- Never change CopyTrader order of operations without approval
- Feature flags must be functional from first commit
- Always call `ensureDataDir()` before SQLite init

---

## 4. Non-Negotiable Rules

*(Unchanged from v2.0, plus additions)*

### Code Safety
- `npm run build` must pass before any PR
- No changes to CopyTrader trade processing pipeline order
- No changes to CLOB client authentication flow (but we can ADD Dome Router alongside it)
- No `.env` format changes that break existing setups (new vars are additive only)

### Security (NEW)
- Private keys NEVER stored in plaintext files after Phase 1B ships
- Encrypted keystore files protected by master password
- Master password NEVER written to disk — held in memory only, entered at startup
- All sensitive API credentials (Builder keys, Dome key) encrypted at rest
- `.gitignore` must include `*.keystore.json`, `data/*.enc`, `data/*.keystore`

### Review Process
- Every phase = one draft PR
- No PR merges without Aidan's explicit approval
- PR description must list: files changed, new files, deleted files, behavior changes, new env vars

---

## 5. Current System Snapshot

### Architecture
```
┌───────────────────────────────────────────────────────────┐
│                    CURRENT ARCHITECTURE                     │
│                                                             │
│  Monitoring          Orchestration         Execution        │
│  ┌──────────────┐    ┌───────────────┐    ┌─────────────┐  │
│  │ WalletMonitor │───▶│  CopyTrader   │───▶│ Trade       │  │
│  │ (5s polling)  │    │  (filters,    │    │ Executor    │  │
│  └──────────────┘    │   dedup,      │    │ (CLOB SDK)  │  │
│                      │   sizing)     │    └─────────────┘  │
│  ┌──────────────┐    └───────────────┘                     │
│  │ WebSocket    │                                          │
│  │ (own trades  │    Storage           UI                  │
│  │  only)       │    ┌───────────┐    ┌─────────────┐      │
│  └──────────────┘    │ JSON files │    │ Express +   │      │
│                      │ (flat)     │    │ Vanilla JS  │      │
│                      └───────────┘    └─────────────┘      │
└───────────────────────────────────────────────────────────┘
```

### Dead Code Identified for Phase 0A Removal

| Item | Location | Lines | Why Dead |
|---|---|---|---|
| Legacy embedded dashboard | `src/server.ts` lines 54-2776 | ~2,700 | Served at `/legacy`, never used. Real dashboard is `public/` |
| Debug fetch shims | 6 source files | 81 calls | `fetch('http://127.0.0.1:7242/ingest/...')` — debug logging to nonexistent server |
| Cloudflare Worker | `cloudflare-worker/worker.js` | 67 | Unused proxy for Railway hosting |
| Excessive DEBUG logging | `clobClient.ts`, `tradeExecutor.ts` | ~100 lines | Verbose console.log for debugging that's no longer needed |
| `websocketMonitor.ts` | `src/websocketMonitor.ts` | 596 | Only monitors own trades (Polymarket limitation). Will be replaced by Dome WS. Keep temporarily, mark deprecated. |

### Key File Sizes (Current)

| File | Lines | Purpose |
|---|---|---|
| `src/server.ts` | 2,807 | Express server + **2,700 lines of dead legacy dashboard** |
| `src/copyTrader.ts` | 1,360 | Main orchestrator — DO NOT modify order of operations |
| `src/api/routes.ts` | 2,012 | REST API endpoints |
| `src/walletMonitor.ts` | 814 | Polling-based trade detection |
| `src/storage.ts` | 674 | JSON file-based persistence |
| `src/clobClient.ts` | 548 | CLOB client (heavy debug logging) |
| `src/websocketMonitor.ts` | 596 | Own-trade-only WS (partially dead) |
| `src/positionMirror.ts` | 609 | Position mirroring feature |
| `src/balanceTracker.ts` | 486 | USDC balance tracking |
| `src/polymarketApi.ts` | 691 | Polymarket API client |
| `src/tradeExecutor.ts` | 400 | Trade execution |
| `src/types.ts` | 333 | TypeScript types |

After Phase 0A cleanup, `server.ts` drops from 2,807 → ~100 lines. `clobClient.ts` drops from 548 → ~300.

---

## 6. Dome API — What It Is and What We Use

*(Core details unchanged from v2.0)*

### Dome Order Router — Key for Multi-Wallet

The Order Router is the critical piece for multi-wallet support. It provides:

1. **`linkUser(userId, signer)`** — One-time setup per wallet. Creates Polymarket CLOB API credentials. Returns `{ apiKey, apiSecret, apiPassphrase }` that must be stored securely.
2. **`setCredentials(userId, credentials)`** — Load stored credentials for a wallet (no re-linking needed).
3. **`placeOrder({ userId, marketId, side, size, price, signer }, credentials)`** — Place order on behalf of any linked wallet.

This means:
- Each trading wallet = one `userId` in Dome's system
- Credentials stored in our encrypted keystore (not plaintext)
- No need to manage separate ClobClient instances per wallet
- Builder attribution handled by Dome (no per-wallet Builder API keys needed)
- Supports both EOA wallets and Safe (proxy) wallets

```typescript
// Example: Multi-wallet order flow
const router = new PolymarketRouter({ chainId: 137, apiKey: DOME_API_KEY });

// Wallet #1: Link once, store credentials
const creds1 = await router.linkUser({ userId: 'wallet-main', signer: signer1 });
await secureStore.save('wallet-main', creds1);

// Wallet #2: Link once, store credentials
const creds2 = await router.linkUser({ userId: 'wallet-arb', signer: signer2 });
await secureStore.save('wallet-arb', creds2);

// Later: Place orders for any wallet
router.setCredentials('wallet-main', await secureStore.load('wallet-main'));
await router.placeOrder({ userId: 'wallet-main', marketId, side: 'buy', size: 100, price: 0.50, signer: signer1 });
```

### What Dome CANNOT Do (Honest Limitations)

| Thing | Can Dome Do It? | Workaround |
|---|---|---|
| Execute trades on Kalshi | **No** | Manual instructions shown in UI |
| Redeem winning positions on-chain | **No** | Direct CTF contract interaction (Phase 3) |
| Merge/close losing positions on-chain | **No** | Direct CTF contract interaction (Phase 3) |
| Match non-sports markets across platforms | **Limited** | Sports markets primarily; may expand |
| Monitor Kalshi wallets in real-time | **No** | Polling only via REST |

---

## 7. Security Architecture — EVM Key Management

### The Problem

Currently, private keys are stored in plaintext in `.env`:
```
PRIVATE_KEY=0xabc123...
```
This is the #1 cause of crypto theft. With multiple wallets, the risk multiplies.

### The Solution: Encrypted Keystore (ethers.js V3 format)

We will use the **ethers.js encrypted JSON wallet** format — the same format used by Geth, MetaMask, and every major Ethereum client. This uses:
- **AES-128-CTR** cipher for encryption
- **scrypt** key derivation function (CPU + memory hard, resistant to GPU brute-force)
- **Unique salt and IV** per keystore file

#### How It Works

**First-time setup (or adding a new wallet):**
1. User enters private key + master password via UI or setup wizard
2. System encrypts private key: `await wallet.encrypt(masterPassword)` → produces JSON keystore
3. JSON keystore saved to `data/keystores/wallet-{id}.keystore.json`
4. Original plaintext private key is **immediately discarded** from memory
5. Master password held in memory only for the session (never written to disk)

**On bot startup:**
1. Bot prompts for master password (CLI prompt or UI unlock screen)
2. For each keystore file: `ethers.Wallet.fromEncryptedJson(keystore, masterPassword)` → recovers wallet
3. Wallets held in memory for the session
4. If password is wrong, decryption fails — bot cannot start (no fallback to plaintext)

**Security properties:**
- Private keys encrypted at rest with scrypt (brute-force resistant)
- If someone steals the `data/keystores/` directory, they still need the master password
- Master password never touches disk (entered interactively or via env var for CI/cloud)
- Each wallet has its own keystore file (can be backed up individually)
- Compatible with standard Ethereum tooling (can import keystores into MetaMask, etc.)

#### Migration Path (Backward Compatibility)

Phase 1B will provide a migration from plaintext `.env` to encrypted keystore:

1. On first run after Phase 1B: if `PRIVATE_KEY` exists in `.env`, offer to migrate
2. User enters a master password
3. System encrypts the key → saves keystore → removes `PRIVATE_KEY` from `.env`
4. `.env` gets `KEYSTORE_DIR=./data/keystores` instead

For users who cannot use interactive password entry (cloud hosting, CI):
- `MASTER_PASSWORD` env var (less secure, but better than plaintext private keys)
- Future: integrate with cloud KMS (AWS Secrets Manager, etc.) — out of scope for now

#### What Gets Encrypted

| Secret | Current Storage | After Phase 1B |
|---|---|---|
| Private keys (per wallet) | Plaintext `.env` | Encrypted keystore files (scrypt + AES) |
| Polymarket Builder API credentials | Plaintext `.env` | Encrypted in keystore metadata or separate vault |
| Dome API key | Plaintext `.env` | Stays in `.env` (not a wallet key, lower risk) |
| Dome Order Router credentials (per wallet) | N/A (new) | Encrypted in SQLite (AES-256-GCM with master password derived key) |
| Polymarket CLOB API credentials (per wallet) | Derived at runtime | Cached encrypted in SQLite (re-derived if lost) |

#### .gitignore Additions

```gitignore
# Security - NEVER commit these
data/keystores/
*.keystore.json
*.keystore
data/*.enc
.master-password
```

---

## 8. Phase 0A: Codebase Cleanup

**Goal:** Remove all dead code, debug shims, and technical debt. Zero new features.

**Branch:** `feature/phase0a-cleanup`  
**Estimated effort:** 15 hours  
**Depends on:** Nothing

### What Gets Removed

#### 1. Legacy Embedded Dashboard in `server.ts`
The entire `/legacy` route (lines 54-2776) — ~2,700 lines of inline HTML/CSS/JS that duplicate the real dashboard in `public/`. After removal, `server.ts` becomes ~100 lines: just Express setup, middleware, static file serving, health check, and the SPA fallback route.

#### 2. Debug Fetch Shims (81 calls across 6 files)
Every `fetch('http://127.0.0.1:7242/ingest/...')` call, including surrounding `#region agent log` / `#endregion` comments. These were added during a debugging session and serve no purpose. They fire-and-forget to a nonexistent local server.

| File | Debug fetch calls | Lines freed |
|---|---|---|
| `src/walletMonitor.ts` | 34 | ~70 |
| `src/copyTrader.ts` | 21 | ~45 |
| `src/websocketMonitor.ts` | 11 | ~25 |
| `src/clobClient.ts` | 5 | ~15 |
| `src/tradeExecutor.ts` | 5 | ~15 |
| `src/polymarketApi.ts` | 5 | ~15 |

#### 3. Excessive Verbose Logging
In `clobClient.ts` and `tradeExecutor.ts`, there are ~50 lines of `console.log('[DEBUG]...')` that log every field of every response. Keep error logging, remove success-path verbosity.

#### 4. Cloudflare Worker
Remove `cloudflare-worker/worker.js` and its directory. The CLOB URL is configurable via env var already.

#### 5. Deprecation Mark on `websocketMonitor.ts`
Add `@deprecated` JSDoc tag. Don't remove it yet (Phase 1A replaces its functionality).

### What Does NOT Change
- All business logic
- All public method signatures
- All API endpoints
- All UI files
- `copyTrader.ts` order of operations
- `booleanParsing.ts`

### Acceptance Criteria
- [ ] `npm run build` passes
- [ ] `server.ts` is <150 lines
- [ ] Zero `fetch('http://127.0.0.1:7242` calls remain in codebase
- [ ] `cloudflare-worker/` directory removed
- [ ] Bot starts and functions identically
- [ ] No changes to any trade execution or monitoring logic

---

## 9. Phase 0B: SQLite Infrastructure Hardening

*(Same as Phase 0 in v2.0 — see previous plan for full details)*

**Branch:** `feature/phase0b-sqlite-infra`  
**Estimated effort:** 20 hours  
**Depends on:** Phase 0A merged

Key points:
- New `src/database.ts` with schema, WAL mode, ensureDataDir guard
- `src/storage.ts` refactored to dual-backend (JSON + SQLite)
- `STORAGE_BACKEND` env var defaults to `json`
- Legacy JSON → SQLite migration with file rename (not delete)
- Auto-fallback to JSON if SQLite init fails
- Tests for both backends + migration

---

## 10. Phase 1A: Dome Integration + WebSocket Real-Time

*(Same as Phase 1 in v2.0 — see previous plan for full details)*

**Branch:** `feature/phase1a-dome-websocket`  
**Estimated effort:** 20 hours  
**Depends on:** Phase 0B merged

Key points:
- New `src/domeClient.ts` (shared REST wrapper)
- New `src/domeWebSocket.ts` (WS connection + event mapping)
- Polling fallback when WS disconnects
- DetectedTrade enrichment with wallet config
- Monitoring mode indicator in UI

---

## 11. Phase 1B: Multi-Wallet Architecture

**Goal:** Support N independent Polymarket trading wallets, each with their own encrypted credentials, balance, and configuration. Dome Order Router as primary execution method.

**Branch:** `feature/phase1b-multi-wallet`  
**Estimated effort:** 40 hours  
**Depends on:** Phase 1A merged (for Dome SDK)

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                MULTI-WALLET ARCHITECTURE                      │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   SecureKeyManager (new)                 │ │
│  │                                                          │ │
│  │  data/keystores/                                         │ │
│  │    wallet-main.keystore.json   (encrypted)               │ │
│  │    wallet-arb.keystore.json    (encrypted)               │ │
│  │    wallet-test.keystore.json   (encrypted)               │ │
│  │                                                          │ │
│  │  unlock(masterPassword) → decrypts all → holds in memory │ │
│  │  addWallet(privateKey, label, masterPw) → encrypt + save │ │
│  │  removeWallet(walletId) → delete keystore file           │ │
│  │  getSigner(walletId) → ethers.Wallet                     │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           │                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                 WalletManager (new)                      │ │
│  │                                                          │ │
│  │  TradingWallet[] — each has:                             │ │
│  │    id, label, address, proxyAddress, isActive            │ │
│  │    defaultTradeSize, defaultSlippage                     │ │
│  │    domeCredentials (encrypted in SQLite)                 │ │
│  │    trackedWalletOverrides                                │ │
│  │                                                          │ │
│  │  registerWallet(privateKey, label, config)               │ │
│  │  removeWallet(walletId)                                  │ │
│  │  getWallet(walletId): TradingWallet                      │ │
│  │  getExecutorForWallet(walletId): WalletExecutor          │ │
│  │  linkWalletViaDome(walletId): PolymarketCredentials      │ │
│  │  getAllBalances(): Map<walletId, balance>                 │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           │                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              CopyTrader (modified)                       │ │
│  │                                                          │ │
│  │  On DetectedTrade:                                       │ │
│  │    1. Look up which trading wallets copy this address    │ │
│  │    2. For EACH matching trading wallet:                  │ │
│  │       a. Apply that wallet's filters/config              │ │
│  │       b. Execute via Dome Router (userId = walletId)     │ │
│  │    3. One tracked wallet can trigger trades on N wallets │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           │                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │         Dome Order Router (execution layer)             │ │
│  │                                                          │ │
│  │  router.placeOrder({ userId: walletId, ... })            │ │
│  │  Supports FOK (Fill or Kill) for instant fills           │ │
│  │  Builder attribution handled by Dome                     │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  FALLBACK: Original ClobClient for primary wallet             │
│  (if Dome is unavailable, Wallet #1 can still trade directly) │
└─────────────────────────────────────────────────────────────┘
```

### New Files

**`src/secureKeyManager.ts`** (~200 lines)
```typescript
export class SecureKeyManager {
  private wallets: Map<string, ethers.Wallet> = new Map();
  private isUnlocked = false;

  // Unlock all keystores with master password (called at startup)
  async unlock(masterPassword: string): Promise<void>

  // Check if manager is unlocked
  isReady(): boolean

  // Add a new wallet (encrypts + saves keystore file)
  async addWallet(id: string, privateKey: string, masterPassword: string): Promise<string /*address*/>

  // Remove a wallet (deletes keystore file)
  async removeWallet(id: string): Promise<void>

  // Get decrypted signer for a wallet (must be unlocked)
  getSigner(id: string): ethers.Wallet

  // Get wallet address without needing unlock
  getAddress(id: string): string

  // List all wallet IDs from keystore directory
  listWalletIds(): string[]

  // Migrate from plaintext PRIVATE_KEY in .env
  async migrateFromEnv(masterPassword: string): Promise<string /*walletId*/>
}
```

**`src/walletManager.ts`** (~350 lines)
```typescript
export class WalletManager {
  constructor(
    keyManager: SecureKeyManager,
    domeRouter: PolymarketRouter,
    storage: typeof Storage
  )

  // Wallet CRUD
  async registerWallet(privateKey: string, label: string, config: Partial<TradingWalletConfig>): Promise<TradingWallet>
  async removeWallet(walletId: string): Promise<void>
  async updateWalletConfig(walletId: string, config: Partial<TradingWalletConfig>): Promise<void>
  getWallet(walletId: string): TradingWallet
  getAllWallets(): TradingWallet[]
  getActiveWallets(): TradingWallet[]

  // Dome Order Router integration
  async linkWallet(walletId: string): Promise<void> // one-time Dome linkUser
  async placeOrder(walletId: string, order: TradeOrder): Promise<TradeResult>

  // Balance tracking (per wallet)
  async getBalance(walletId: string): Promise<number>
  async getAllBalances(): Promise<Map<string, number>>

  // Config cloning
  async cloneConfigFrom(sourceWalletId: string, targetWalletId: string): Promise<void>
}
```

### New Types

```typescript
interface TradingWallet {
  id: string;                     // UUID
  label: string;                  // "Main", "Arb Bot", etc.
  address: string;                // EOA address
  proxyAddress?: string;          // Polymarket proxy wallet
  walletType: 'eoa' | 'safe';    // For Dome Order Router
  isActive: boolean;
  createdAt: Date;

  // Per-wallet defaults
  defaultTradeSize: number;
  defaultSlippage: number;
  maxDailyLoss?: number;

  // Which tracked wallets this wallet copies, and config overrides
  copyAssignments: CopyAssignment[];
}

interface CopyAssignment {
  trackedWalletAddress: string;
  enabled: boolean;
  useConfigFrom?: string;        // walletId to clone config from, or null = own
  overrides?: Partial<TrackedWallet>; // per-assignment filter overrides
}

interface TradingWalletConfig {
  defaultTradeSize: number;
  defaultSlippage: number;
  maxDailyLoss?: number;
}
```

### CopyTrader Modifications

The CopyTrader's `handleDetectedTrade()` method currently processes one trade for one executor. With multi-wallet:

1. When a DetectedTrade arrives from a tracked wallet address:
2. Look up ALL trading wallets that have a `CopyAssignment` for this tracked address
3. For EACH matching trading wallet:
   a. Apply that wallet's filters/sizing (either its own config or cloned from another)
   b. Execute via `walletManager.placeOrder(walletId, order)`
4. Track each execution independently in trade metrics

**What does NOT change:** The dedup, filter, and sizing logic itself. Only the "who do we execute for" step becomes a loop.

### Migration from Single Wallet

For backward compatibility, Phase 1B provides a smooth migration:

1. If `PRIVATE_KEY` exists in `.env` and no keystores exist: auto-create `wallet-primary` from it
2. Prompt user to set a master password
3. Encrypt and save keystore
4. Comment out (don't delete) `PRIVATE_KEY` in `.env` with migration note
5. All existing tracked wallet assignments transfer to `wallet-primary`

### UI Changes (minimal — full UI rewrite is Phase 2)

In current UI, add:
- Wallet selector dropdown in header showing active trading wallet
- "Trading Wallets" section in Settings tab (add/remove/configure)
- "Unlock" screen on startup if keystores exist

### Acceptance Criteria

- [ ] Multiple wallets can be added/removed via API and UI
- [ ] Each wallet has its own encrypted keystore
- [ ] Master password unlocks all wallets at startup
- [ ] Dome Order Router successfully places orders for each wallet
- [ ] A tracked wallet's trade can trigger copies on multiple trading wallets
- [ ] Balance displayed per trading wallet
- [ ] Migration from single `PRIVATE_KEY` works seamlessly
- [ ] If Dome Router fails, primary wallet falls back to direct CLOB client
- [ ] `npm run build` passes
- [ ] No plaintext private keys on disk after migration

---

## 12. Phase 2: Win95 UI Rewrite

**Goal:** Complete visual overhaul with authentic Windows 95 aesthetics, built from scratch in vanilla CSS/JS.

**Branch:** `feature/phase2-win95-ui`  
**Estimated effort:** 60 hours  
**Depends on:** Phase 1B merged (multi-wallet UI elements needed)

### Design System

**Color Palette (authentic Win95):**
```css
--win95-desktop: #008080;        /* Teal desktop background */
--win95-window-bg: #C0C0C0;     /* Silver window background */
--win95-title-active: #000080;   /* Navy active title bar */
--win95-title-inactive: #808080; /* Gray inactive title bar */
--win95-title-text: #FFFFFF;     /* White title text */
--win95-button-face: #C0C0C0;   /* Button face */
--win95-button-highlight: #FFFFFF; /* Button top/left edge */
--win95-button-shadow: #808080;  /* Button bottom/right edge */
--win95-button-dark: #000000;    /* Button outer bottom/right */
--win95-text: #000000;           /* Default text */
--win95-field-bg: #FFFFFF;       /* Input field background */
--win95-selection: #000080;      /* Selected item bg */
--win95-selection-text: #FFFFFF; /* Selected item text */
--win95-success: #008000;        /* Green for success */
--win95-error: #FF0000;          /* Red for errors */
--win95-warning: #808000;        /* Yellow-brown for warnings */
```

**Typography:**
- Primary: `"Pixelated MS Sans Serif", "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Geneva, sans-serif`
- Monospace: `"Fixedsys", "Lucida Console", "Courier New", monospace`
- Base size: 11px (authentic Win95)

**CSS Components to build:**

1. **Window chrome** — Title bar with icon, title text, minimize/maximize/close buttons. Raised 3D border.
2. **3D borders** — `border-style: outset` for raised, `inset` for sunken. Using the classic 2px light/dark pattern.
3. **Buttons** — Raised default, sunken pressed, flat disabled. The 3D beveled look.
4. **Tabs** — Raised tab strip with active tab connected to content area.
5. **Scrollbars** — Styled to match Win95 (gray track, raised thumb, arrow buttons).
6. **Form controls** — 3D checkboxes, radio buttons, select dropdowns, text inputs with sunken border.
7. **Tables** — Grid lines, header row, alternating optional.
8. **Status bar** — Bottom of window, sunken panel sections.
9. **Progress bars** — Chunky segmented blocks.
10. **Modal dialogs** — Centered dialog window with shadow.
11. **Menu bar** — File/Edit style menu strip under title bar.
12. **Taskbar** — Bottom of screen, Start button, clock, status indicators.
13. **Tree view** — Expandable/collapsible for entity groups.
14. **Tooltip** — Classic yellow popup.

### Window Layout (NOT draggable — styled as windows, laid out normally)

The main application is a single "Program Manager" window. Inside it:
- **Menu bar** with tabs: Dashboard | Wallets | Settings | Diagnostics
- **Content area** changes per tab
- Each major section (Trading Wallets, Recent Trades, Arb Opportunities) is a **group box** (bordered section with title in the border)
- **Modals** (hedge preview, ladder setup, wallet config) ARE separate dialog windows

### Taskbar

```
┌──────────────────────────────────────────────────────────────────┐
│ [Start] │ ■ Monitoring: WebSocket ● │ 3 wallets │ 47 trades │ 4:32 PM │
└──────────────────────────────────────────────────────────────────┘
```

The Start button opens a menu with:
- Quick links to each tab
- Bot status (Running/Stopped)
- Start/Stop bot controls
- About dialog

### File Structure

```
public/
  index.html           — Single page shell + Win95 window structure
  css/
    win95.css          — Core Win95 design system (borders, buttons, forms, windows)
    layout.css         — Application-specific layout
    components.css     — Component-specific styles (tables, cards, modals)
  js/
    app.js             — Main application logic (tab switching, data loading)
    api.js             — API client functions
    windows.js         — Modal/dialog window management
    components.js      — Reusable UI components (tables, forms, progress bars)
  fonts/
    ms-sans-serif.woff2  — Pixel-accurate MS Sans Serif web font
  img/
    icons/             — 16x16 and 32x32 pixel art icons for windows, buttons, etc.
```

### Accessibility & Usability

Despite the retro look, the UI must be:
- Keyboard navigable (tab order, Enter to submit)
- Screen reader compatible (proper ARIA labels)
- Responsive down to 1024px width (no mobile — this is a desktop trading tool)
- All existing functionality preserved — every button, form, toggle from the current UI must work

### Acceptance Criteria

- [ ] All existing dashboard, wallets, settings, diagnostics features work
- [ ] Win95 visual style is consistent across all elements
- [ ] Multi-wallet UI elements integrated (wallet switcher, wallet management)
- [ ] Modals work for all dialog flows (hedge preview, ladder setup, etc.)
- [ ] Taskbar shows live status
- [ ] No JavaScript errors in console
- [ ] `npm run build` passes
- [ ] Loading states show Win95-style hourglass cursor

---

## 13. Phase 3: Auto-Redeem + Position Lifecycle

**Goal:** Automatically redeem winning positions and merge/close losing ones after market resolution. No more manual redemption.

**Branch:** `feature/phase3-auto-redeem`  
**Estimated effort:** 25 hours  
**Depends on:** Phase 1B merged (multi-wallet support needed for per-wallet redemption)

### How Polymarket Resolution Works

1. UMA oracle reports payouts via `reportPayouts()` on CTF contract
2. Winning outcome tokens become redeemable for USDC collateral
3. Losing outcome tokens become worthless (but can be merged if you hold both sides)
4. Positions stay in wallet until user explicitly calls `redeemPositions()` on-chain
5. **There is no auto-redeem — this is why you have to do it manually**

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              AUTO-REDEEM / POSITION LIFECYCLE                  │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │         PositionLifecycleManager (new)                │    │
│  │                                                        │   │
│  │  Periodic check (every 5 minutes per wallet):          │   │
│  │                                                        │   │
│  │  1. GET /positions?user={proxy}&redeemable=true        │   │
│  │     → List of resolved positions ready to claim        │   │
│  │                                                        │   │
│  │  2. GET /positions?user={proxy}&mergeable=true         │   │
│  │     → List of positions that can be merged for USDC    │   │
│  │                                                        │   │
│  │  3. For each redeemable position:                      │   │
│  │     a. Determine if negRisk market                     │   │
│  │     b. Encode redeem call (CTF or NegRiskAdapter)      │   │
│  │     c. Execute via wallet's signer (on-chain tx)       │   │
│  │     d. Log result, update UI                           │   │
│  │                                                        │   │
│  │  4. For each mergeable position:                       │   │
│  │     a. Calculate merge amount (min of YES, NO shares)  │   │
│  │     b. Encode merge call                               │   │
│  │     c. Execute via wallet's signer (on-chain tx)       │   │
│  │     d. Log result, update UI                           │   │
│  │                                                        │   │
│  │  5. Track total USDC redeemed per wallet, per day      │   │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  On-chain contracts:                                          │
│  - CTF: 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045           │
│  - NegRisk Adapter: 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296│
│  - USDC: 0x2791bca1f2de4661ed88a30c99a7a9449aa84174           │
│  - Proxy Factory: 0xaB45c5A4B0c941a2F231C04C3f49182e1A254052  │
│  - Safe Factory: 0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b   │
└─────────────────────────────────────────────────────────────┘
```

### New Files

**`src/positionLifecycle.ts`** (~400 lines)
```typescript
export class PositionLifecycleManager {
  constructor(
    walletManager: WalletManager,
    keyManager: SecureKeyManager,
    rpcUrl: string
  )

  // Lifecycle
  start(): void           // Begin periodic checks
  stop(): void            // Stop periodic checks

  // Manual triggers
  async redeemAll(walletId: string): Promise<RedemptionResult[]>
  async mergeAll(walletId: string): Promise<MergeResult[]>
  async redeemPosition(walletId: string, conditionId: string): Promise<RedemptionResult>
  async mergePosition(walletId: string, conditionId: string, amount: string): Promise<MergeResult>

  // Query
  async getRedeemablePositions(walletId: string): Promise<RedeemablePosition[]>
  async getMergeablePositions(walletId: string): Promise<MergeablePosition[]>
  getRedemptionHistory(): RedemptionRecord[]

  // Settings
  setAutoRedeem(enabled: boolean): void
  setAutoMerge(enabled: boolean): void
  setCheckInterval(seconds: number): void
}

interface RedeemablePosition {
  conditionId: string;
  title: string;
  outcome: string;
  shares: number;
  estimatedPayout: number;   // shares * 1.0 for winner
  negRisk: boolean;
  walletId: string;
}

interface MergeablePosition {
  conditionId: string;
  title: string;
  yesShares: number;
  noShares: number;
  mergeableAmount: number;   // min(yesShares, noShares)
  estimatedReturn: number;   // mergeableAmount * 1.0 USDC
  negRisk: boolean;
  walletId: string;
}

interface RedemptionResult {
  success: boolean;
  conditionId: string;
  txHash?: string;
  amountRedeemed?: number;
  gasCost?: number;
  error?: string;
}
```

### On-Chain Transaction Details

**Redeem winning positions (non-negRisk):**
```typescript
const ctf = new ethers.Contract(CTF_ADDRESS, ctfAbi, signer);
const data = ctf.interface.encodeFunctionData(
  "redeemPositions(address,bytes32,bytes32,uint256[])",
  [USDC_ADDRESS, ethers.constants.HashZero, conditionId, [1, 2]]
);
// For Safe wallet: wrap in Safe transaction via proxy factory
// For EOA: direct contract call
```

**Redeem winning positions (negRisk):**
```typescript
const negRisk = new ethers.Contract(NEG_RISK_ADAPTER_ADDRESS, negRiskAbi, signer);
const data = negRisk.interface.encodeFunctionData(
  "redeemPositions(bytes32,uint256[])",
  [conditionId, [yesAmount, noAmount]]
);
```

**Merge positions (recover USDC from holding both sides):**
```typescript
const ctf = new ethers.Contract(CTF_ADDRESS, ctfAbi, signer);
const data = ctf.interface.encodeFunctionData(
  "mergePositions(address,bytes32,bytes32,uint256[],uint256)",
  [USDC_ADDRESS, ethers.constants.HashZero, conditionId, [1, 2], mergeAmount]
);
```

**Gas costs:** Each redeem/merge is an on-chain Polygon transaction. Cost is typically 0.001-0.01 MATIC (~$0.001-0.01 USD). Negligible.

### Settings

```typescript
interface AutoRedeemConfig {
  enabled: boolean;               // Default: true
  autoMergeEnabled: boolean;      // Default: true
  checkIntervalSeconds: number;   // Default: 300 (5 minutes)
  minRedeemValueUSDC: number;     // Default: 0.10 (don't redeem dust)
  gasLimitGwei: number;           // Default: 200 (Polygon gas price cap)
  notifyOnRedeem: boolean;        // Default: true (show in UI)
}
```

### UI Changes

**Dashboard → "Position Lifecycle" card (Win95 group box):**
```
╔═ Position Lifecycle ════════════════════════════════════════╗
║                                                              ║
║  Auto-Redeem: ● ON    Auto-Merge: ● ON    Check: 5 min     ║
║                                                              ║
║  Redeemable (2 positions):                 [Redeem All]     ║
║  ├ Chiefs SB YES  │ 100 shares │ ~$52.00   [Redeem]        ║
║  └ BTC>100k NO    │ 50 shares  │ ~$25.00   [Redeem]        ║
║                                                              ║
║  Mergeable (1 position):                   [Merge All]      ║
║  └ NYC Mayor YES/NO │ 20 each  │ ~$20.00  [Merge]          ║
║                                                              ║
║  Today: Redeemed $127.50 │ Merged $20.00 │ Gas: $0.03      ║
╚══════════════════════════════════════════════════════════════╝
```

### Acceptance Criteria

- [ ] Auto-redeem detects redeemable positions via Data API `?redeemable=true`
- [ ] Auto-merge detects mergeable positions via Data API `?mergeable=true`
- [ ] On-chain `redeemPositions()` successfully claims winning shares
- [ ] On-chain `mergePositions()` successfully merges losing positions for USDC
- [ ] Both negRisk and non-negRisk markets handled correctly
- [ ] Works for all registered trading wallets (multi-wallet)
- [ ] Safe wallet redemption routes through proxy factory
- [ ] EOA wallet redemption calls contract directly
- [ ] Settings allow enable/disable per feature
- [ ] Dust filter prevents redeeming positions worth < $0.10
- [ ] Gas costs tracked and displayed
- [ ] `npm run build` passes

---

## 14. Phase 4: Arbitrage Detection

*(Same as Phase 2 in v2.0, renumbered. See previous plan for full details.)*

**Branch:** `feature/phase4-arb-detection`  
**Estimated effort:** 25 hours  
**Depends on:** Phase 1A merged

---

## 15. Phase 5: Wallet Entity Linking + Hedge Detection

*(Same as Phase 3 in v2.0, renumbered. See previous plan for full details.)*

**Branch:** `feature/phase5-entity-linking`  
**Estimated effort:** 24 hours  
**Depends on:** Phase 1A merged

---

## 16. Phase 6: One-Click Hedge + Auto-Execute Arbitrage

*(Same as Phase 4 in v2.0, renumbered, with multi-wallet modifications.)*

**Branch:** `feature/phase6-hedge-and-autoarb`  
**Estimated effort:** 30 hours  
**Depends on:** Phases 4 and 5 merged

**Multi-wallet addition:** When executing a hedge or arb trade, the user selects which trading wallet to use from a dropdown. The execution goes through `walletManager.placeOrder(selectedWalletId, order)`.

---

## 17. Phase 7: Ladder Exit Strategy + Smart Stop-Loss

*(Same as Phase 5 in v2.0, renumbered. See previous plan for full details.)*

**Branch:** `feature/phase7-position-management`  
**Estimated effort:** 40 hours  
**Depends on:** Phase 1A merged

---

## 18. Full Dashboard Mockups (Win95 Theme)

### Dashboard Tab

```
╔═══════════════════════════════════════════════════════════════════════╗
║ ■ Polymarket Trading Terminal                              _ □ X    ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Dashboard │ Wallets │ Settings │ Diagnostics                        ║
╠═══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  ╔═ Trading Wallets ══════════════════════════════════════════════╗  ║
║  ║                                                                ║  ║
║  ║  ► [Main]   0x2D43...3010   $1,247.53  ● Active   [Config]   ║  ║
║  ║    [Arb]    0xDEF1...A021   $523.10    ● Active   [Config]   ║  ║
║  ║    [Test]   0x1234...F789   $50.00     ○ Paused   [Config]   ║  ║
║  ║                                                                ║  ║
║  ║  Total Balance: $1,820.63       Monitoring: ● WebSocket       ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                        ║
║  │98% │ │ 47 │ │82ms│ │ 5  │ │ 46 │ │ 1  │                        ║
║  │Succ│ │Trd │ │Lat │ │Wlt │ │Pass│ │Fail│                        ║
║  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘                        ║
║                                                                      ║
║  ╔═ Recent Trades ════════════════════════════════════════════════╗  ║
║  ║  Time   Wallet  Source  Market         Side  Amt    Hlth  Act ║  ║
║  ║  ────── ─────── ─────── ────────────── ───── ────── ───── ─── ║  ║
║  ║  14:32  [Main]  COPY    Chiefs YES     BUY   $52    ■+12% [H]║  ║
║  ║  14:28  [Arb]   ARB     BTC>100k NO    BUY   $48    ■-10% [H]║  ║
║  ║  14:15  [Main]  HEDGE   BTC>100k NO    BUY   $60    ——    —  ║  ║
║  ║  14:02  [Main]  COPY    NYC Mayor      SELL  $30    ——    —  ║  ║
║  ║  13:41  [Main]  STOP    ETH>5k         SELL  $80    ——    —  ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ╔═ Position Lifecycle ═══════════════════════════════════════════╗  ║
║  ║  Auto-Redeem: ● ON    Auto-Merge: ● ON    Last check: 2m ago ║  ║
║  ║  Redeemable: 2 ($77.00)  Mergeable: 1 ($20.00)  [Redeem All] ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ╔═ Arbitrage Opportunities ══════════════════════ [SCANNING] ════╗  ║
║  ║  Market           Poly    Kalshi  Spread  Profit  Execute      ║  ║
║  ║  Chiefs SB YES    $0.52   $0.48   4.0%    $4.17   [Go ▼]     ║  ║
║  ║  BTC>100k YES     $0.61   $0.58   3.1%    $3.23   [Go ▼]     ║  ║
║  ║                                                                ║  ║
║  ║  24 markets scanned • Last: 12s ago                            ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ╔═ Active Ladders ══════════════════════════════════════════════╗  ║
║  ║  Position         Entry  Current  Next Level   Progress       ║  ║
║  ║  BTC>100k YES     $0.50  $0.67    $0.70 (L3)   ████████░░   ║  ║
║  ║  Chiefs SB YES    $0.40  $0.52    $0.55 (L2)   ████░░░░░░   ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ╔═ Performance ═════════════════════════════════════════════════╗  ║
║  ║  (Chart.js chart — unchanged in functionality, Win95 styled)  ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
╠═══════════════════════════════════════════════════════════════════════╣
║ ■ Monitoring: WebSocket ● │ 3 wallets │ 47 trades today │ 4:32 PM  ║
╚═══════════════════════════════════════════════════════════════════════╝
```

### Wallets Tab

```
╔═══════════════════════════════════════════════════════════════════════╗
║  Dashboard │ Wallets │ Settings │ Diagnostics                        ║
╠═══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  ╔═ Entity Groups ════════════════════════════ [+ New Group] ═════╗  ║
║  ║                                                                ║  ║
║  ║  [-] Whale 42                               [Edit] [Delete]   ║  ║
║  ║      ├ 0xABC...F01 (Poly)  "Main wallet"                     ║  ║
║  ║      ├ 0xDEF...A21 (Poly)  "Alt wallet"                      ║  ║
║  ║      └ K:whale42   (Kalshi)                                   ║  ║
║  ║      Combined: $2,847 • 5 positions                           ║  ║
║  ║      ⚠ HEDGE: Opposing positions on BTC>100k                  ║  ║
║  ║                                                                ║  ║
║  ║  [+] Sports Bettor                          [Edit] [Delete]   ║  ║
║  ║      ├ 0x123...789 (Poly)  "NFL focus"                        ║  ║
║  ║      Combined: $1,200 • 3 NFL markets                         ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ═══ Tracked Wallets ═══════════════════════════ [+ Add Wallet] ══  ║
║                                                                      ║
║  ╔═ 0xABC...F01 "DeFi Chad" ══════════ ● ACTIVE ═════════════════╗  ║
║  ║  Last seen: 2m ago │ 12 trades copied │ 92% success           ║  ║
║  ║                                                                ║  ║
║  ║  Copies to: [Main ▼] [Arb ▼]              [Assign Group ▼]   ║  ║
║  ║                                                                ║  ║
║  ║  Config:  ○ Own settings  ● Same as [Main ▼]                  ║  ║
║  ║                                                                ║  ║
║  ║  [Configure Filters]  [View History]  [Deactivate]            ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  (more wallet cards...)                                              ║
║                                                                      ║
╚═══════════════════════════════════════════════════════════════════════╝
```

### Settings Tab

```
╔═══════════════════════════════════════════════════════════════════════╗
║  Dashboard │ Wallets │ Settings │ Diagnostics                        ║
╠═══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  ╔═ Trading Wallets ══════════════════════ [+ Add Wallet] ════════╗  ║
║  ║                                                                ║  ║
║  ║  [Main]  0x2D43...3010  │ Trade Size: [$50]  │ Slip: [2]%    ║  ║
║  ║  [Arb]   0xDEF1...A021  │ Trade Size: [$25]  │ Slip: [1]%    ║  ║
║  ║  [Test]  0x1234...F789  │ Trade Size: [$10]  │ Slip: [3]%    ║  ║
║  ║                                                                ║  ║
║  ║  [Manage Wallets...]  [Change Master Password]                ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ╔═ General Settings ════════════════════════════════════════════╗  ║
║  ║  (existing settings — unchanged in functionality)             ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ╔═ Dome API ═══════════════════════════════════════════════════╗  ║
║  ║  Status: ● Connected (Dev Tier)  │  WS: ● Active            ║  ║
║  ║  Subs: 5/500  │  QPS: 23/100  │  Last event: 2s ago         ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ╔═ Auto-Redeem & Merge ════════════════════════════════════════╗  ║
║  ║  [x] Auto-redeem winning positions    Check every: [300]s    ║  ║
║  ║  [x] Auto-merge losing positions      Min value: [$0.10]     ║  ║
║  ║  Gas limit: [200] Gwei                                       ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ╔═ Arbitrage Scanner ═════════════════════════════════════════╗  ║
║  ║  [x] Enable Scanner  │  Interval: [60]s  │  Spread: [3]%    ║  ║
║  ║  [ ] Auto-Execute    │  Mode: (○ Paper ○ Live) │ Max: [$100] ║  ║
║  ║  Execute with: [Main ▼]                                      ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ╔═ Smart Stop-Loss ═══════════════════════════════════════════╗  ║
║  ║  [ ] Enable │ Mode: (○ Paper ○ Live)                         ║  ║
║  ║  Max Recovery: [50]%  │  [x] Trailing: [10]% below peak      ║  ║
║  ║  Daily Loss Limit: [$100]                                    ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
║  ╔═ Ladder Defaults ═══════════════════════════════════════════╗  ║
║  ║  [ ] Auto-create on copied trades                            ║  ║
║  ║  Default: [Even Split (4 levels) ▼]  │  Mode: (○ Paper ○ L) ║  ║
║  ╚════════════════════════════════════════════════════════════════╝  ║
║                                                                      ║
╚═══════════════════════════════════════════════════════════════════════╝
```

### Unlock Screen (on startup if keystores exist)

```
╔══════════════════════════════════════════════╗
║ ■ Unlock Trading Terminal           _ □ X   ║
╠══════════════════════════════════════════════╣
║                                              ║
║        🔒 Enter Master Password              ║
║                                              ║
║   Password: [________________________]       ║
║                                              ║
║   3 wallets found in keystore                ║
║                                              ║
║            [  Unlock  ]  [  Cancel  ]        ║
║                                              ║
╚══════════════════════════════════════════════╝
```

---

## 19. Testing Strategy

### Philosophy

Every phase is tested rigorously BEFORE the PR is opened. The developer (AI agent) runs all tests and verification. Aidan's review is limited to visual spot-checks and real-wallet verification (~3-5 minutes per phase).

### Test Framework

- **Runner:** Node.js built-in `node:test` (already configured in `package.json`)
- **Assertions:** `node:assert/strict`
- **Mocking:** `node:test` built-in `mock` API for stubbing external APIs
- **Execution:** `npm run test` runs all `tests/**/*.test.ts` files
- **No additional test dependencies** -- keeps the stack simple

### Four Test Layers

#### Layer 1: Unit Tests (automated, per module)

Every new `.ts` source file gets a corresponding `tests/<module>.test.ts`. Tests individual functions in isolation with mocked dependencies (no real API calls, no real blockchain, no real Dome).

| Phase | Test File(s) | Key Test Cases |
|---|---|---|
| 0A | *(none -- verified by build + existing tests)* | Cleanup didn't break anything |
| 0B | `tests/database.test.ts`, `tests/storage.test.ts` | Schema creation, CRUD both backends, dual-backend dispatch, migration, auto-fallback |
| 1A | `tests/domeClient.test.ts`, `tests/domeWebSocket.test.ts` | REST error handling, rate limit backoff, WS event-to-DetectedTrade mapping, wallet config enrichment, reconnect logic |
| 1B | `tests/secureKeyManager.test.ts`, `tests/walletManager.test.ts` | Encrypt/decrypt roundtrip, wrong password rejection, wallet CRUD, config cloning, .env migration |
| 2 | `tests/api-smoke.test.ts` | All API endpoints return correct shape and status codes |
| 3 | `tests/positionLifecycle.test.ts` | Redeem encoding correctness, merge encoding, redeemable detection, negRisk vs non-negRisk handling, dust filter |
| 4 | `tests/arbScanner.test.ts` | Spread calculation, fee adjustment, opportunity expiry, zero/negative spread edge cases |
| 5 | `tests/entityManager.test.ts` | Entity CRUD, hedge classification (hedging vs doubling down vs reducing) |
| 6 | `tests/hedgeCalculator.test.ts`, `tests/positionTracker.test.ts` | Hedge cost math, position recording, partial close tracking |
| 7 | `tests/ladderExitManager.test.ts`, `tests/smartStopLoss.test.ts`, `tests/priceMonitor.test.ts` | Level triggering, trailing stop math, recovery calculation, lock-in ratcheting, daily loss limit |

#### Layer 2: Integration Tests (automated, cross-module)

Bundled into the same test files but tagged with descriptive names. Run against real SQLite (in temp dirs) but mock external APIs.

- Storage + Database: write via Storage API, read back, verify fields match across both backends
- CopyTrader + WalletManager: mock DetectedTrade triggers correct wallet executors (not others)
- PositionLifecycle + WalletManager: redeem runs for all active wallets
- ArbScanner + DomeClient: mock Dome responses, verify opportunities generated with correct math

#### Layer 3: Regression Smoke Test (automated, runs every PR)

`tests/smoke.test.ts` -- a single file that gates every PR:

1. TypeScript compilation succeeds (`npm run build`)
2. Config loads with valid defaults
3. Storage roundtrip works (both backends if SQLite available)
4. Mock DetectedTrade flows through CopyTrader filter pipeline without crash
5. All GET API endpoints respond with 200
6. Server starts and stops cleanly (no hanging processes)
7. Existing `booleanParsing.test.ts` still passes

#### Layer 4: Developer Verification (automated, run by AI agent)

Before opening each PR, the AI agent executes and reports results for:

1. `npm run build` -- zero TypeScript errors
2. `npm run test` -- all tests pass (unit + integration + smoke)
3. `npm run dev` -- bot starts successfully (launched, verified, stopped)
4. API endpoint checks via curl -- correct response shapes
5. Console output review -- no unexpected errors, no leftover debug logging
6. Linter check -- no new lint errors introduced

Results are posted in the PR description with pass/fail status.

### What Aidan Verifies (3-5 minutes per phase)

Only things the AI agent physically cannot test:

| Phase | What You Check | Time |
|---|---|---|
| 0A | Open localhost:3001, confirm dashboard loads, check no visual breakage | 2 min |
| 0B | Start with `STORAGE_BACKEND=sqlite`, add a wallet, restart, confirm it persists | 3 min |
| 1A | Confirm "Monitoring: WebSocket" shows in dashboard (requires live Dome connection) | 2 min |
| 1B | Enter master password at startup, confirm both wallets show balances | 3 min |
| 2 | Visual review of Win95 UI -- does it look right across all tabs? | 5 min |
| 3 | Check if any redeemable positions show up (if you have resolved markets) | 2 min |
| 4 | Confirm arb opportunities display with prices | 2 min |
| 5 | Create an entity group, assign wallets, confirm it renders | 3 min |
| 6 | Click hedge preview on a position, confirm calculations look reasonable | 3 min |
| 7 | Set up a paper-mode ladder, confirm it logs trigger events | 3 min |

**Total time from you across all 10 phases: ~28 minutes**

### PR Gate Requirements

Every PR must satisfy ALL of these before it's ready for review:

- [ ] `npm run build` passes with zero errors
- [ ] `npm run test` passes with zero failures
- [ ] Bot starts and stops cleanly with `npm run dev`
- [ ] No new lint errors (checked via `ReadLints`)
- [ ] All new code has corresponding test coverage
- [ ] PR description includes test results summary
- [ ] Phase-specific acceptance criteria from plan are checked off
- [ ] No regressions in existing functionality (smoke test)

---

## 20. Master Timeline

```
WEEK  1  │  2  │  3  │  4  │  5  │  6  │  7  │  8  │  9  │ 10 │ 11 │ 12
──────────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼────┼────┼────
Phase 0A  ██   │     │     │     │     │     │     │     │     │    │    │
Cleanup   ░░   │     │     │     │     │     │     │     │     │    │    │
(15 hrs)       │     │     │     │     │     │     │     │     │    │    │
               │     │     │     │     │     │     │     │     │    │    │
Phase 0B       ████ │     │     │     │     │     │     │     │    │    │
SQLite         ░░░░ │     │     │     │     │     │     │     │    │    │
(20 hrs)       │     │     │     │     │     │     │     │     │    │    │
               │     │     │     │     │     │     │     │     │    │    │
Phase 1A       │     ████ │     │     │     │     │     │     │    │    │
Dome + WS      │     ░░░░ │     │     │     │     │     │     │    │    │
(20 hrs)       │     │     │     │     │     │     │     │     │    │    │
               │     │     │     │     │     │     │     │     │    │    │
Phase 1B       │     │     ██████████ │     │     │     │     │    │    │
Multi-Wallet   │     │     ░░░░░░░░░░ │     │     │     │     │    │    │
(40 hrs)       │     │     │     │     │     │     │     │     │    │    │
               │     │     │     │     │     │     │     │     │    │    │
Phase 2        │     │     │     ████████████████ │     │     │    │    │
Win95 UI       │     │     │     ░░░░░░░░░░░░░░░░ │     │     │    │    │
(60 hrs)       │     │     │     │     │     │     │     │     │    │    │
               │     │     │     │     │     │     │     │     │    │    │
Phase 3        │     │     │     │     │     │     ██████│     │    │    │
Auto-Redeem    │     │     │     │     │     │     ░░░░░░│     │    │    │
(25 hrs)       │     │     │     │     │     │     │     │     │    │    │
               │     │     │     │     │     │     │     │     │    │    │
Phase 4        │     │     │     │     │     │     │     ██████│    │    │
Arb Detect     │     │     │     │     │     │     │     ░░░░░░│    │    │
(25 hrs)       │     │     │     │     │     │     │     │     │    │    │
               │     │     │     │     │     │     │     │     │    │    │
Phase 5        │     │     │     │     │     │     │     │     ████│    │
Entities       │     │     │     │     │     │     │     │     ░░░░│    │
(24 hrs)       │     │     │     │     │     │     │     │     │    │    │
               │     │     │     │     │     │     │     │     │    │    │
Phase 6        │     │     │     │     │     │     │     │     │    ████│
Hedge+Arb      │     │     │     │     │     │     │     │     │    ░░░░│
(30 hrs)       │     │     │     │     │     │     │     │     │    │    │
               │     │     │     │     │     │     │     │     │    │    │
Phase 7        │     │     │     │     │     │     │     │     │    │    ████
Ladder+Stop    │     │     │     │     │     │     │     │     │    │    ░░░░
(40 hrs)
```

### Phase Summary

| Phase | Name | Hours | Key Deliverable | Depends On |
|---|---|---|---|---|
| **0A** | Codebase Cleanup | 15 | Remove ~3,000 lines dead code | Nothing |
| **0B** | SQLite Infrastructure | 20 | Dual-backend storage | Phase 0A |
| **1A** | Dome + WebSocket | 20 | Sub-second trade detection | Phase 0B |
| **1B** | Multi-Wallet | 40 | N wallets, encrypted keys, Dome Router | Phase 1A |
| **2** | Win95 UI Rewrite | 60 | Complete retro interface | Phase 1B |
| **3** | Auto-Redeem | 25 | On-chain position lifecycle | Phase 1B |
| **4** | Arb Detection | 25 | Cross-platform price scanning | Phase 1A |
| **5** | Entity Linking | 24 | Wallet grouping, hedge detection | Phase 1A |
| **6** | Hedge + Auto-Arb | 30 | Trade execution (paper → live) | Phases 4+5 |
| **7** | Ladder + Stop-Loss | 40 | Position management (paper → live) | Phase 1A |
| **TOTAL** | | **~299 hrs** | | ~12 weeks |

### Parallelism Notes
- Phases 3, 4, 5 can run in parallel after Phase 1B
- Phase 2 (UI) can overlap with Phases 3-5 if someone else works on backend
- Phase 7 only needs Phase 1A, so it could theoretically start earlier

---

## 21. Technical Reference

### New NPM Dependencies

| Package | Purpose | Phase |
|---|---|---|
| `better-sqlite3` + `@types/better-sqlite3` | SQLite persistence | 0B |
| `@dome-api/sdk` | Dome REST API + WS + Order Router | 1A, 1B |

### New Source Files (by Phase)

```
Phase 0A:
  (deletions only — cloudflare-worker/, legacy dashboard in server.ts)

Phase 0B:
  src/database.ts              — SQLite schema, init, migration
  tests/storage.test.ts        — Storage tests for both backends

Phase 1A:
  src/domeClient.ts            — Shared Dome REST API wrapper
  src/domeWebSocket.ts         — Dome WebSocket connection manager

Phase 1B:
  src/secureKeyManager.ts      — Encrypted keystore management
  src/walletManager.ts         — Multi-wallet CRUD + Dome Router

Phase 2:
  public/css/win95.css         — Core Win95 design system
  public/css/layout.css        — Application layout
  public/css/components.css    — Component styles
  public/js/windows.js         — Modal/dialog window management
  public/js/components.js      — Reusable UI components

Phase 3:
  src/positionLifecycle.ts     — Auto-redeem + auto-merge

Phase 4:
  src/arbScanner.ts            — Cross-platform arbitrage scanner

Phase 5:
  src/entityManager.ts         — Wallet entity CRUD + hedge detection

Phase 6:
  src/positionTracker.ts       — Own-position tracking with entry prices
  src/hedgeCalculator.ts       — Hedge cost/profit calculation + execution

Phase 7:
  src/priceMonitor.ts          — Shared price polling
  src/ladderExitManager.ts     — Ladder exit strategy engine
  src/smartStopLoss.ts         — Recovery-based stop-loss engine
```

### New Environment Variables

```env
# Phase 0B
STORAGE_BACKEND=json              # 'json' (default) or 'sqlite'

# Phase 1A
DOME_API_KEY=your_dome_api_key    # Required for all Dome features

# Phase 1B
KEYSTORE_DIR=./data/keystores    # Directory for encrypted keystore files
MASTER_PASSWORD=                  # Optional: for non-interactive environments (cloud/CI)
# Note: If MASTER_PASSWORD not set, bot prompts interactively at startup

# Phase 1B (backward compatibility — migrated to keystore on first run)
PRIVATE_KEY=0x...                 # Deprecated after migration. Kept for initial migration only.
```

### Smart Contract Addresses (Polygon Mainnet)

| Contract | Address | Used In |
|---|---|---|
| CTF (Conditional Tokens) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | Phase 3 (redeem/merge) |
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | Phase 3 |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | Phase 3 (negRisk redeem) |
| USDC (Polygon) | `0x2791bca1f2de4661ed88a30c99a7a9449aa84174` | Phase 3 (collateral) |
| Proxy Wallet Factory | `0xaB45c5A4B0c941a2F231C04C3f49182e1A254052` | Phase 3 (proxy wallet txs) |
| Safe Factory | `0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b` | Phase 3 (safe wallet txs) |

---

## 22. Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | SQLite migration corrupts data | HIGH | Low | JSON fallback. Legacy files preserved. |
| R2 | Dome API downtime | Medium | Medium | Polling fallback for monitoring. Direct CLOB for primary wallet. |
| R3 | Dome tier costs prohibitive | Medium | Low | Evaluate Dev tier pricing before Phase 1A. |
| R4 | Arb spreads too thin after fees | Low | Medium | Show fee-adjusted profits. Paper mode first. |
| R5 | Matching Markets limited to sports | Medium | High | Note in UI. Build custom matching later. |
| R6 | Ladder/stop triggers wrong price | HIGH | Low | Paper mode first. Shared price monitor. |
| R7 | Auto-execute places unintended trades | HIGH | Low | Paper mode default. Explicit opt-in. Rate limits. |
| R8 | Master password forgotten | HIGH | Medium | Warning during setup. No recovery possible. User can re-import keys. |
| R9 | On-chain redeem/merge tx fails | Low | Medium | Retry logic. Gas estimation before send. Error displayed in UI. |
| R10 | Kalshi execution not available | Medium | High | Alert-only. Manual instructions. Plan for Kalshi API later. |
| R11 | Multi-wallet config complexity | Medium | Medium | "Copy config from" UX. Sensible defaults. |
| R12 | Win95 UI breaks accessibility | Medium | Medium | Proper ARIA labels. Keyboard navigation. Thorough testing. |
| R13 | Private key leak during migration | HIGH | Low | Plaintext key held in memory only during encrypt. Cleared after. |

---

## 23. Open Decisions

| # | Question | Who Decides | Needed By |
|---|---|---|---|
| D1 | Dome API tier pricing — is Dev tier affordable? | Aidan | Before Phase 1A |
| D2 | Use Dome Order Router as primary executor (recommended) or keep ClobClient? | Aidan | Before Phase 1B |
| D3 | UI rewrite early (Phase 2, before features) or late (after features)? Recommendation: early | Aidan | Before Phase 2 |
| D4 | Matching markets beyond sports — wait for Dome or build custom? | Aidan | Phase 4 |
| D5 | Kalshi direct API integration — separate phase or fold in? | Aidan | Phase 6 |
| D6 | Paper mode trades: main trade history or separate tab? | Team | Phase 6 |
| D7 | Master password: interactive prompt or env var for cloud hosting? | Aidan | Phase 1B |
| D8 | How many trading wallets to support at launch? (2? 5? unlimited?) | Aidan | Phase 1B |

---

## 24. What Is Required From You (Aidan)

### Before Any Code Starts

| # | What | Why | Effort |
|---|---|---|---|
| 1 | **Sign up for Dome API key (Dev tier)** at dashboard.domeapi.io | Every feature beyond basic copy-trading depends on Dome | 15 min + pricing review |
| 2 | **Confirm Dome Dev tier pricing** is acceptable for your usage | If too expensive, we scope down Dome-dependent features | 5 min |
| 3 | **Ensure git push works** (configure PAT or SSH key) | PRs need to be pushed for review. Has failed twice before. | 10 min |
| 4 | **Decide on Open Decisions D1-D3** (Dome Router, UI timing, Dome pricing) | Blocks Phase 1A/1B/2 architecture | 10 min |

### During Phase 1B (Multi-Wallet)

| # | What | Why | Effort |
|---|---|---|---|
| 5 | **Provide private keys** for each additional Polymarket wallet | Multi-wallet requires each key. These get encrypted immediately. | 5 min per wallet |
| 6 | **Choose a master password** | Encrypts all keystores. Must be strong. Cannot be recovered. | 1 min |
| 7 | **Test the migration** from your current plaintext `.env` | Verify your primary wallet works after encryption migration | 10 min |

### Ongoing (Throughout All Phases)

| # | What | Why | Effort |
|---|---|---|---|
| 8 | **Review and approve PRs** (~10 PRs total) | You said "nothing merged without me clicking it" | ~30 min each, ~5 hrs total |
| 9 | **Test on your own machine** after each phase merge | Verify real trades work, balance shows, wallets connect | ~15 min per phase |
| 10 | **Report issues immediately** if anything breaks after a merge | Faster feedback = faster fixes | As needed |

### Total Time Investment From You: ~8-10 hours spread over 12 weeks

That's about 45 minutes per week of your time. The rest is engineering work.

---

## Appendix A: Dome API Quick Reference

*(Unchanged from v2.0)*

## Appendix B: Polymarket CTF Contract Reference

| Function | Contract | Purpose |
|---|---|---|
| `redeemPositions(collateral, parentId, conditionId, indexSets)` | CTF | Redeem winning shares for USDC |
| `redeemPositions(conditionId, amounts)` | NegRisk Adapter | Redeem negRisk winning shares |
| `mergePositions(collateral, parentId, conditionId, indexSets, amount)` | CTF | Merge YES+NO shares back to USDC |
| `splitPosition(collateral, parentId, conditionId, indexSets, amount)` | CTF | Split USDC into YES+NO shares |

### Index Sets (Binary Markets)
- First outcome (YES): `0b01 = 1`
- Second outcome (NO): `0b10 = 2`
- Full partition: `[1, 2]`

### Position Query (Data API)
```
GET https://data-api.polymarket.com/positions?user={address}&redeemable=true
GET https://data-api.polymarket.com/positions?user={address}&mergeable=true
```

Response includes: `conditionId`, `size`, `avgPrice`, `currentValue`, `cashPnl`, `redeemable`, `mergeable`, `negativeRisk`, `title`, `outcome`

## Appendix C: Glossary

| Term | Definition |
|---|---|
| **EOA** | Externally Owned Account (MetaMask/Rabby address) |
| **Proxy Wallet** | Polymarket smart contract wallet per user |
| **Safe Wallet** | Gnosis Safe-based smart contract wallet for browser wallets |
| **CTF** | Conditional Token Framework (Gnosis) — tokenizes market outcomes |
| **Entity** | Group of wallets believed to be same person/org |
| **Arbitrage** | Exploiting price differences across platforms |
| **Hedge** | Opposing position to reduce risk |
| **Ladder Exit** | Selling in increments at ascending price levels |
| **Recovery-Based Stop** | Stop-loss based on gain needed to break even |
| **Trailing Stop** | Stop that moves up as price increases |
| **Paper Mode** | Simulation — logs what would happen without real trades |
| **Dome** | Third-party API aggregating Polymarket + Kalshi |
| **CLOB** | Central Limit Order Book (Polymarket's system) |
| **Matching Markets** | Same event listed on multiple platforms |
| **Keystore V3** | Standard encrypted wallet format (scrypt + AES) |
| **Master Password** | Single password that unlocks all encrypted wallets |
| **negRisk** | Polymarket market type using the Neg Risk Adapter contract |
| **Merge** | Burning one YES + one NO share to recover 1 USDC |
| **Redeem** | Claiming winning shares for USDC after market resolution |
