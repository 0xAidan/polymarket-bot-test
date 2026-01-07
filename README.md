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
- **PRIVATE_KEY**: Your wallet's private key (for executing trades and signing orders)
- **POLYMARKET_API_KEY**: (Optional) API key from Polymarket if required
- **POLYMARKET_CLOB_API_URL**: CLOB API endpoint (default: https://clob.polymarket.com)
- **POLYMARKET_DATA_API_URL**: Data API endpoint (default: https://data-api.polymarket.com)
- **POLYMARKET_GAMMA_API_URL**: Gamma API endpoint (default: https://gamma-api.polymarket.com)
- **POLYGON_RPC_URL**: Polygon blockchain RPC endpoint

Optional:
- **MONITORING_INTERVAL_MS**: How often to check for new trades (default: 15000ms / 15 seconds)

## How It Works

1. **Wallet Monitoring**: The bot polls Polymarket's Data API to monitor position changes from tracked wallets
2. **Trade Detection**: When a position change is detected, it:
   - Extracts market ID, outcome (YES/NO), amount, and price
   - Compares with previous positions to identify new trades
   - Also checks recent trade history for very recent activity
3. **Trade Execution**: The bot places the same trade on your wallet via Polymarket CLOB API:
   - Gets market information to determine token IDs
   - Constructs and signs the order
   - Submits the order to the CLOB API
4. **Performance Tracking**: All trades are logged with success rates, latency, and errors

## API Integration

This bot integrates with Polymarket's APIs:

- **Data API**: Fetches user positions and trade history to detect trades
- **CLOB API**: Places orders to execute trades
- **Gamma API**: Gets market information and token details

**Note**: The exact API endpoints and authentication methods may vary. If you encounter authentication issues:
1. Check Polymarket's latest API documentation at [docs.polymarket.com](https://docs.polymarket.com)
2. Verify the API endpoint URLs are correct
3. Ensure your wallet has sufficient funds and permissions

The bot uses wallet signature authentication by default, with optional API key support if provided.

## Security Warning

⚠️ **NEVER share your private key or API keys publicly!**
⚠️ **Test with small amounts first!**
⚠️ **This bot executes real trades with real money!**

## License

MIT
