# Polymarket Copytrade Bot - Quickstart Guide

A bot that automatically copies trades from wallets you track on Polymarket.

## What It Does

1. You add wallet addresses to track
2. The bot watches those wallets for trades
3. When they make a trade, the bot automatically makes the same trade for you
4. You can see everything in a web dashboard

## Quick Start (Run on Your Computer)

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Your Wallet

Run the setup command:

```bash
npm run setup
```

This will ask you for:
- **Private Key**: Your wallet's private key (from MetaMask or your wallet)
- **Builder API Key**: Get this from [Polymarket Settings → Builder tab](https://polymarket.com/settings?tab=builder)
- **Builder Secret**: Also from Polymarket Settings → Builder tab
- **Builder Passphrase**: Also from Polymarket Settings → Builder tab

**Note**: The Builder API credentials are **required** - without them, your trades will be blocked by Cloudflare.

### 3. Run the Bot

```bash
npm run dev
```

The bot will start and you'll see:
- A web dashboard at `http://localhost:3001`
- Status information in the terminal
- Any errors or warnings

### 4. Use the Dashboard

1. Open `http://localhost:3001` in your browser
2. Add wallet addresses you want to track
3. The bot will automatically start copying their trades

## Environment Variables

If you prefer to set up manually, create a `.env` file in the project root:

```env
# Required: Your wallet private key
PRIVATE_KEY=your_private_key_here

# Required: Polymarket Builder API credentials (get from https://polymarket.com/settings?tab=builder)
POLYMARKET_BUILDER_API_KEY=your_builder_api_key_here
POLYMARKET_BUILDER_SECRET=your_builder_secret_here
POLYMARKET_BUILDER_PASSPHRASE=your_builder_passphrase_here

# Optional: Polygon RPC URL (defaults to https://polygon-rpc.com)
POLYGON_RPC_URL=https://polygon-rpc.com

# Optional: Server port (defaults to 3001)
PORT=3001
```

See `ENV_EXAMPLE.txt` for all available options.

## Important Notes

⚠️ **NEVER share your private key with anyone!**  
⚠️ **Start with small amounts to test!**  
⚠️ **This bot uses real money - be careful!**  
⚠️ **Builder API credentials are REQUIRED** - trades will fail without them

## Troubleshooting

**Bot won't start?**
- Make sure you've run `npm run setup` or created a `.env` file with `PRIVATE_KEY`
- Check that you have Builder API credentials configured
- Look at the terminal output for error messages

**Trades are failing?**
- Most common issue: Missing Builder API credentials
- Check that your `PRIVATE_KEY` is correct (no extra spaces)
- Verify your wallet has enough funds

**Can't see the dashboard?**
- Make sure the bot is running (`npm run dev`)
- Check the port number in the terminal (default is 3001)
- Try `http://localhost:3001` in your browser

## Commands

- `npm run setup` - Set up your wallet and API credentials
- `npm run dev` - Run the bot in development mode (auto-restarts on changes)
- `npm run build` - Build the bot for production
- `npm start` - Run the built bot (after `npm run build`)

## That's It!

Your bot is now running locally. Add wallet addresses through the dashboard and it will automatically copy their trades.
