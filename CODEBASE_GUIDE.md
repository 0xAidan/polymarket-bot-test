# Polymarket Bot: Zero-to-Mastery Guide

**Goal:** This document will take you from "I know TypeScript" to "I fully understand how this algorithmic trading bot works," including the underlying crypto/financial technologies.

---

## Part 1: The Core Technologies (Prerequisites)

Before looking at the code, you need to understand the tools we are using.

### 1. What is Polymarket? (Under the Hood)
Polymarket is a **Prediction Market** built on the Polygon blockchain.
- **Binary Outcomes:** Every market typically has "YES" and "NO" tokens.
- **Pricing:** Prices range from $0.00 to $1.00. Buying "YES" at $0.60 means the market believes there is a 60% chance the event will happen.
- **Settlement:** If "YES" wins, the token becomes worth $1.00 (USDC). If it loses, it becomes $0.00.
- **CTF (Conditional Token Framework):** This is the smart contract standard used. It’s not a simple ERC-20 token; it's a specialized standard for splitting collateral into outcomes.

### 2. The APIs: CLOB vs. Data vs. Gamma
Polymarket isn't just one interaction point. We use three different APIs:

1.  **CLOB (Central Limit Order Book) API** (`clob.polymarket.com`):
    *   **What it is:** The actual exchange engine. This is where buyers match with sellers. It is fast, off-chain matching with on-chain settlement.
    *   **Our usage:** Placing orders, cancelling orders, checking our user balance.
    *   **Key Tech:** Requires **Cryptographic Signing** (authenticating with your private key).

2.  **Data API** (`data-api.polymarket.com`):
    *   **What it is:** A readable database of *past* events.
    *   **Our usage:** Seeing what other people (whales) traded, checking their current positions.
    *   **Key Tech:** Standard HTTP GET requests (REST).

3.  **Gamma API** (`gamma-api.polymarket.com`):
    *   **What it is:** Market metadata.
    *   **Our usage:** Translating a cryptic `tokenID` ("38472...") into a human name ("Will Trump win?").

### 3. Ethers.js (The Crypto Layer)
`ethers.js` is a library for interacting with the Ethereum/Polygon blockchain.
*   **Wallet:** An object that holds your Private Key. It can "Sign" messages.
*   **Signing:** The CLOB API doesn't use passwords. To prove you are you, you "sign" a message with your private key. The API checks the math to verify it came from you without ever seeing your key.
*   **In this bot:** We use `ethers` to create a `Wallet` from your private key, which the `CLOB Client` then uses to sign every trade you make.

### 4. WebSockets vs. Polling
*   **Polling (HTTP):** "Are we there yet? No. Are we there yet? No."
    *   We use this for **Wallet Monitor**. We ask the Data API every 10 seconds: "Did User X make a trade?"
*   **WebSockets (WS):** Opening a permanent phone line. "Call me if anything happens."
    *   We use this for **Order Updates**. The CLOB calls us instantly when *our* trade fills.
    *   *Note:* We cannot use WebSockets to watch *other* people's trades easily because Polymarket doesn't broadcast them publicly in real-time for free; hence, we Poll.

---

## Part 2: Architecture High-Level

The bot is a loop that connects "The Eyes" (Monitoring) to "The Hands" (Execution).

```mermaid
graph TD
    A[Target Wallet (Whale)] -->|Polls Positions| B(WalletMonitor)
    B -->|Detects Charge| C{CopyTrader}
    C -->|Calculates Trade| D(TradeExecutor)
    D -->|Signs & Sends| E[Polymarket CLOB]
    E -->|Confirms| F(Usage/Perf Check)
```

1.  **WalletMonitor:** Watches the target wallet.
2.  **CopyTrader:** The brain. Decides "Is this safe? Is it a dupe? How much do we buy?"
3.  **TradeExecutor:** Talks to the exchange to make it happen.

---

## Part 3: Codebase Mastery (File by File)

We will walk through the `src/` folder logically, not alphabetically.

### 1. The Entry Point: `index.ts` & `config.ts`
*   **`config.ts`**: Loads your `.env` file (private keys, API keys). It’s the settings menu.
*   **`index.ts`**: The "Power Button".
    *   It creates the `CopyTrader` instance.
    *   It starts the Express web server (for the dashboard).
    *   It keeps the process running.

### 2. The Eyes: `walletMonitor.ts`
This is where the magic starts. We need to know when our target trades.

*   **How it works:** It runs a loop (e.g., every 10s).
*   **Technique 1: Position Diffing.**
    *   Generic REST API Call: `GET /positions?user=0xTarget...`
    *   It saves the *previous* list of positions.
    *   It gets the *new* list.
    *   **Math:** `New Size - Old Size`. If > 0, they bought. If < 0, they sold.
*   **Technique 2: Activity Log.**
    *   API Call: `GET /activity?user=0xTarget...`
    *   This is a list of their recent fills.
    *   We check if there is a timestamp newer than the last time we checked.

### 3. The Brain: `copyTrader.ts`
This is the Controller. It receives signals from `walletMonitor` and decides what to do.

*   **Deduplication:** The biggest risk is buying the same thing 5 times because the polling cycle detected it 5 times. We use `processedTrades` (a Set of strings) to remember IDs of trades we've already done.
*   **Filtering:**
    *   *Value Filter:* "Don't copy trades worth less than $10."
    *   *Side Filter:* "Only copy BUYs, ignore SELLs."
*   **Sizing:** "The Whale bought $50,000. I only have $500." The bot calculates your order size based on your constants (e.g., "Always buy $10 worth").

### 4. The Hands: `tradeExecutor.ts` & `clobClient.ts`
This is the hardest part technically because of Authentication.

*   **`clobClient.ts`**: This wraps the official `@polymarket/clob-client`.
    *   **L1 vs L2 Headers:** Polymarket Cloudflare blocks simple scripts. We use "L2 Headers" (Level 2). This involves using a standard `eoa` (Externally Owned Account) key to derive specific API credentials.
    *   **The Proxy Worker:** If running on a cloud (like Railway), our IP gets blocked. The code supports sending requests through a `cloudflare-worker` (a tiny script in the repo) to mask our IP.
*   **`tradeExecutor.ts`**:
    *   **Tick Size:** You can't buy at $0.5011112. You must round to the "tick" (e.g., $0.01 or $0.001). This file handles that math.
    *   **Slippage:** If price is $0.50, we might bid $0.51 to ensure we get it immediately (`IOC` - Immediate or Cancel).

### 5. Data Persistence: `storage.ts`
We don't use a SQL database (like Postgres) to keep it simple. We use **JSON files** in the `/data` folder.
*   `active_wallets.json`: Who are we tracking?
*   `history.json`: What have we bought?

---

## Part 4: Advanced Concepts Deep Dive

### The "Proxy Wallet" Concept
When you use Polymarket, you don't hold the tokens in your main wallet (EOA). Polymarket creates a Gnosis Safe (a smart contract wallet) for you. exact trades happens *proxy-to-proxy*.
*   **Why this matters:** When checking balances, `ethers.getBalance(myAddress)` returns 0 USDC. We must check the **Proxy's** balance or use the CLOB API helper `getBalanceAllowance()`.

### The Cloudflare Problem
Polymarket aggressively protects their API from bots.
*   **Builder API:** We use a special "Builder API Key". This is a white-gated key you get from Polymarket.
*   **Header Signing:** We sign the timestamp and URL path.
*   If we get a `403 Forbidden`, it usually means our "Builder Signature" is wrong or our IP is dirty.

### Handling "Nonce"
Every transaction on Ethereum needs a number (Nonce: 0, 1, 2...).
*   The CLOB is off-chain, so we don't pay gas for every order.
*   But we still sign messages. These messages have timestamps/nonces. If your system clock is wrong, the order fails.

---

## Part 5: The Life of a Trade (Walkthrough)

1.  **00:00:00** - `WalletMonitor` wakes up.
2.  **00:00:01** - Fetches "Whale's" positions. Finds entry: `{"outcome": "YES", "size": 1000}`.
3.  **00:00:01** - Logic: Last time we checked, size was 0. **+1000 Delta Detected.**
4.  **00:00:02** - `copyTrader` gets event.
    *   Checks `processedTrades`. New? Yes.
    *   Checks `isBuy`. Yes.
    *   Checks `Config`. Trade Size = $20.
5.  **00:00:03** - `tradeExecutor` calculates price.
    *   Current Market Price: $0.60.
    *   Slippage (2%): Limit Price = $0.612.
    *   Tick Rounding: Final Price = $0.61.
6.  **00:00:04** - `clobClient` creates order payload.
    *   Signs payload with Private Key.
    *   Attaches Builder API Key headers.
    *   POST `clob.polymarket.com/order`
7.  **00:00:05** - API responds: `{"orderID": "xyz", "status": "MATCHED"}`.
8.  **00:00:06** - Trade recorded in `storage.ts`. Dashboard updates.

---

## How to Read This Codebase
Start in this order:
1.  **`src/types.ts`**: See what a "Trade" looks like.
2.  **`src/config.ts`**: See what settings exist.
3.  **`src/walletMonitor.ts`**: See how we fetch data.
4.  **`src/clobClient.ts`**: The "hard" technical part interacting with the exchange.
