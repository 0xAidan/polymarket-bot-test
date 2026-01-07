# Polymarket Copytrade Bot

A bot that monitors specified wallet addresses and automatically executes the same trades on Polymarket.

## Overview

This bot allows you to:
1. Add wallet addresses to track
2. Monitor their trades on Polymarket in real-time
3. Automatically execute the same trades on your wallet
4. Manage tracked wallets through a web interface

## Setup

### Prerequisites

- Node.js 18+ installed
- A crypto wallet with funds for trading
- Polymarket API credentials (get from [docs.polymarket.com](https://docs.polymarket.com))

### Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

**IMPORTANT**: Never commit your `.env` file or private keys to git!

4. Start the development server:
```bash
npm run dev
```

## Configuration

The bot requires:
- **PRIVATE_KEY**: Your wallet's private key (for executing trades)
- **POLYMARKET_API_KEY**: API key from Polymarket
- **POLYMARKET_API_URL**: API endpoint URL
- **POLYGON_RPC_URL**: Polygon blockchain RPC endpoint

## How It Works

1. **Wallet Monitoring**: The bot monitors the Polygon blockchain for trades from tracked wallets
2. **Trade Detection**: When a trade is detected, it extracts:
   - Market ID
   - Position (Yes/No)
   - Amount
   - Price
3. **Trade Execution**: The bot places the same trade on your wallet via Polymarket API

## API Documentation Needed

To complete this bot, we need:
- Polymarket API endpoints for:
  - Authentication
  - Placing orders
  - Market data
  - Order history

Please provide the Polymarket API documentation or links to:
- [docs.polymarket.com](https://docs.polymarket.com)

## Security Warning

⚠️ **NEVER share your private key or API keys publicly!**
⚠️ **Test with small amounts first!**
⚠️ **This bot executes real trades with real money!**

## License

MIT
