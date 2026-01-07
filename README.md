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

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd polymarket-bot-test
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up your wallet** (this is the only step you need to do manually):
   ```bash
   npm run setup
   ```
   
   This will ask you for:
   - Your wallet private key (found in your crypto wallet settings)
   - Optional: API key and RPC URL (you can skip these)
   
   **That's it!** The script creates everything for you.

4. **Start the bot:**
   ```bash
   npm run dev
   ```

**IMPORTANT**: Never commit your `.env` file or private keys to git!

## Running on Separate Computers

If you want to share this bot with a colleague and both run it with your own wallets on separate computers:

1. **Share the repository** - Send them the repo link
2. **Each person does these 3 simple steps:**
   ```bash
   npm install
   npm run setup    # Enter your own private key when prompted
   npm run dev
   ```

**That's it!** Each person runs on their own computer with their own wallet. No conflicts because everyone has their own `.env` file.

## Running 24/7 (Cloud Deployment)

If you want the bot to run continuously without keeping your computer on, you can deploy it to a cloud service. Here are three simple options:

### Option 1: Railway (Recommended - Easiest)

1. **Sign up at [railway.app](https://railway.app)** (free tier available)
2. **Create a new project** → "Deploy from GitHub repo"
3. **Connect your GitHub repository**
4. **Add environment variables** in Railway dashboard:
   - `PRIVATE_KEY` - Your wallet private key
   - `POLYGON_RPC_URL` - Your Polygon RPC endpoint
   - `PORT` - Railway will set this automatically
   - Add any other variables from `ENV_EXAMPLE.txt`
5. **Deploy** - Railway will automatically build and deploy using the Dockerfile

**Note**: Railway provides a free tier that's perfect for this bot. They handle all the infrastructure for you.

### Option 2: Render

1. **Sign up at [render.com](https://render.com)** (free tier available)
2. **Create a new "Web Service"**
3. **Connect your GitHub repository**
4. **Configure the service:**
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
   - Environment: `Node`
5. **Add environment variables** in Render dashboard (same as Railway)
6. **Deploy**

**Note**: Render's free tier puts services to sleep after 15 minutes of inactivity. For a trading bot that needs to run 24/7, you'll need a paid plan (~$7/month).

### Option 3: VPS (DigitalOcean, Linode, AWS EC2, etc.)

1. **Create a VPS instance** (smallest size is fine, ~$5/month)
2. **Connect via SSH**
3. **Install Node.js 18+**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
4. **Clone your repository**:
   ```bash
   git clone <your-repo-url>
   cd polymarket-bot-test
   ```
5. **Set up environment variables**:
   ```bash
   cp ENV_EXAMPLE.txt .env
   nano .env  # Edit with your credentials
   ```
6. **Install and run with PM2** (keeps it running 24/7):
   ```bash
   npm install
   npm run build
   sudo npm install -g pm2
   pm2 start dist/index.js --name polymarket-bot
   pm2 save
   pm2 startup  # Follow instructions to auto-start on reboot
   ```

### Which Option Should I Choose?

- **Railway**: Best for beginners - everything is automated
- **Render**: Good if you want free tier (but remember it sleeps on free plan)
- **VPS**: Most control, but requires some Linux knowledge

All three options will run your bot 24/7! Choose the one that feels easiest for you.

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
