# Polymarket Copytrade Bot

**A bot that copies trades from wallets you track on Polymarket, with a built-in discovery engine to find and score traders.**

This guide walks you through setup and running the bot. No prior experience needed.

---

## Quick start (already have Node.js and the repo)

If you've already cloned the repo and have Node.js 20+ installed:

```bash
cd polymarket-bot-test
npm install
npm run setup
npm run dev
```

Then open **http://localhost:3001** in your browser. The dashboard lets you add wallets to copy and control the discovery engine.

**Stop the bot:** Press `Ctrl + C` in the terminal.

---

## What this bot does

1. **Copy trading** – You add wallet addresses to track. When those wallets trade on Polymarket, the bot places the same trades for you (within your limits).
2. **Discovery engine** – Finds and scores traders (leaderboards, market positions, trade activity) so you can decide who to copy.
3. **Dashboard** – Web UI at `http://localhost:3001` to add/remove tracked wallets, view status, and enable/configure discovery.

**Important:**
- The bot uses **real funds**. Start with small amounts to test.
- **Never share your private key.**
- Trades are **irreversible**.

---

## What you need

- **Node.js** 20 or higher (and npm, which comes with it)
- **Git** (to clone the repo)
- **Crypto wallet** with a private key (e.g. MetaMask)
- **Polymarket Builder API** credentials from [polymarket.com/settings → Builder](https://polymarket.com/settings?tab=builder)

---

## Table of contents

1. [Install prerequisites](#step-0-install-prerequisites)
2. [Clone and enter the project](#step-1-clone-the-repository)
3. [Install dependencies](#step-3-install-dependencies)
4. [Set up wallet and API keys](#step-4-set-up-your-wallet-and-api-keys)
5. [Start the bot and discovery engine](#step-5-start-the-bot-and-discovery-engine)
6. [Use the dashboard](#step-6-use-the-dashboard)
7. [Troubleshooting](#troubleshooting)
8. [Quick reference commands](#quick-reference-commands)

---

## Step 0: Install prerequisites

### Check Node.js and npm

Open **Terminal** (Mac/Linux) or **Command Prompt** (Windows) and run:

```bash
node --version
npm --version
```

You should see version numbers (e.g. `v20.10.0` and `10.2.0`). If not, install Node.js from [nodejs.org](https://nodejs.org/) (use the LTS version).

### Check Git

```bash
git --version
```

If that fails, install Git: [git-scm.com](https://git-scm.com/) (Windows) or `xcode-select --install` (Mac).

---

## Step 1: Clone the repository

Clone the repo into a folder you choose (e.g. `~/websites` or Desktop):

```bash
cd ~/websites
git clone https://github.com/username/polymarket-bot-test.git
```

Replace the URL with your actual repo URL if different.

---

## Step 2: Navigate to the project folder

```bash
cd polymarket-bot-test
```

Check you’re in the right place:

```bash
ls
```

You should see `package.json`, `README.md`, `src`, etc.

---

## Step 3: Install dependencies

```bash
npm install
```

Wait for it to finish (often 1–3 minutes). When done you should see something like “added … packages” and no red errors.

---

## Step 4: Set up your wallet and API keys

The bot needs:

1. Your wallet **private key**
2. **Polymarket Builder API** key, secret, and passphrase

### Option A: Use the setup script (recommended)

From the project folder:

```bash
npm run setup
```

The script will ask for:

| Step | What it asks | Where to get it |
|------|----------------|------------------|
| 1 | **Private key** | MetaMask: ⋮ → Account details → Show private key (or your wallet’s equivalent). Should start with `0x`, 66 characters. |
| 2 | **Builder API Key** | [polymarket.com/settings → Builder](https://polymarket.com/settings?tab=builder) → Create API Key → copy the key |
| 3 | **Builder API Secret** | Same page, shown when you create the key |
| 4 | **Builder API Passphrase** | The passphrase you set when creating the key |

When it finishes you’ll see: **Setup complete** and a `.env` file will exist in the project.

### Option B: Create `.env` manually

1. Copy the example env file:

   ```bash
   cp ENV_EXAMPLE.txt .env
   ```

2. Edit `.env` and replace:

   - `PRIVATE_KEY=...` with your wallet private key
   - `POLYMARKET_BUILDER_API_KEY=...`, `POLYMARKET_BUILDER_SECRET=...`, `POLYMARKET_BUILDER_PASSPHRASE=...` with your Builder API values

3. Save the file.

### Optional but important for some users

- **Proxy / trading wallet** – If Polymarket shows a “Proxy Wallet” or “Trading Wallet” and your dashboard balance is wrong, set `POLYMARKET_FUNDER_ADDRESS` in `.env` to that address (see `ENV_EXAMPLE.txt`).
- **Signature errors** – If you get invalid-signature errors, set `POLYMARKET_SIGNATURE_TYPE` in `.env` (0 = EOA, 1 = Magic Link, 2 = Browser wallet + proxy). Details are in `ENV_EXAMPLE.txt`.
- **Storage** – Default is JSON files in `./data`. You can set `STORAGE_BACKEND=sqlite` to use SQLite instead.

Never commit `.env` or share it; it contains secrets.

---

## Step 5: Start the bot and discovery engine

One command starts **both** the trading bot and the discovery engine:

```bash
npm run dev
```

This will:

1. Run setup automatically if `.env` is missing.
2. Start the **main app** (copy trader + dashboard).
3. Start the **discovery worker** (finds and scores traders).

You should see logs from both. When ready, you’ll see something like:

```
✅ BOT STARTED SUCCESSFULLY
```

- **Dashboard:** open **http://localhost:3001** in your browser.
- **Stop everything:** press `Ctrl + C` in the terminal.

### Running parts separately (optional)

| What you want | Command |
|---------------|--------|
| **Both bot + discovery** (normal use) | `npm run dev` |
| **Discovery worker only** (e.g. another machine) | `npm run dev:discovery` |
| **Discovery worker, single run** (no watch) | `npm run discovery:worker` |

The main app (dashboard + copy trading) is started only by `npm run dev` (or `npm run dev:app`); it does not run when you use `dev:discovery` alone.

---

## Step 6: Use the dashboard

1. Open **http://localhost:3001** in your browser.
2. **Add wallets to copy** – In the dashboard, add the wallet addresses you want to copy. The bot will monitor them and copy their Polymarket trades (within your settings).
3. **Discovery** – Enable and configure the discovery engine from the dashboard to find and score traders; use the results to decide which wallets to add.
4. **Settings** – Configure copy-trade behavior, stop-loss, and other options from the dashboard.

Keep the terminal open while using the bot; closing it or pressing `Ctrl + C` stops the bot and discovery.

---

## Troubleshooting

| Problem | What to do |
|--------|------------|
| `node` or `npm` not found | Install Node.js from [nodejs.org](https://nodejs.org/) (LTS). Restart the terminal. |
| `npm install` fails | Ensure you’re in the project folder (`cd polymarket-bot-test`), Node is 18+, and you have internet. Try: `rm -rf node_modules package-lock.json` then `npm install` again. |
| “PRIVATE_KEY is required” | Run `npm run setup` or add `PRIVATE_KEY` to `.env`. |
| “Builder API credentials not configured” | Add `POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_SECRET`, and `POLYMARKET_BUILDER_PASSPHRASE` to `.env` from [Polymarket Builder settings](https://polymarket.com/settings?tab=builder). Restart with `npm run dev`. |
| Dashboard not loading at http://localhost:3001 | Ensure `npm run dev` is running and no other app is using port 3001. Or set `PORT=3002` (or another port) in `.env`. |
| Trades failing / orders blocked | Check Builder API credentials and that there are no extra spaces in `.env`. If you use a proxy wallet, set `POLYMARKET_FUNDER_ADDRESS` and `POLYMARKET_SIGNATURE_TYPE` (see `ENV_EXAMPLE.txt`). Check dashboard stop-loss / USDC limits. |
| “No wallets are being tracked” | Normal at first. Add wallet addresses in the dashboard at http://localhost:3001. |
| Port 3001 already in use | Stop the other process using 3001, or set `PORT=3002` in `.env` and restart. |

---

## Quick reference commands

Copy-paste from the project folder (`cd polymarket-bot-test`):

```bash
# Install dependencies (once)
npm install

# Configure wallet and API keys (once, or when you need to change them)
npm run setup

# Start trading bot + discovery engine (dashboard at http://localhost:3001)
npm run dev

# Stop the bot
# Press Ctrl + C in the terminal

# Discovery worker only (optional)
npm run dev:discovery

# Production build and run (optional)
npm run build
npm start
```

---

## Summary

- **One command runs everything:** `npm run dev` starts the copy-trading bot and the discovery engine and serves the dashboard at **http://localhost:3001**.
- Use the dashboard to add wallets to copy, turn on discovery, and adjust settings.
- Keep real-money risk in mind: start small, protect your private key, and never share `.env`.

If something still doesn’t work, re-check [Step 4](#step-4-set-up-your-wallet-and-api-keys) and the [Troubleshooting](#troubleshooting) section above.
