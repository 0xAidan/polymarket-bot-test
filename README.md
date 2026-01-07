# Polymarket Copytrade Bot

A bot that automatically copies trades from wallets you choose to track on Polymarket.

## What This Bot Does

1. You add wallet addresses to track
2. The bot watches those wallets for trades
3. When they make a trade, the bot automatically makes the same trade for you
4. You can see everything happening in a web dashboard

## Step 1: Get Your Code Ready (On Your Mac)

1. **Open Terminal** (Press `Command + Space`, type "Terminal", press Enter)

2. **Go to where you want the bot** (for example, your Desktop):
   ```bash
   cd ~/Desktop
   ```

3. **Download the code** (replace `<repository-url>` with your actual GitHub repo URL):
   ```bash
   git clone <repository-url>
   cd polymarket-bot-test
   ```

4. **Install the tools the bot needs**:
   ```bash
   npm install
   ```

## Step 2: Set Up Your Wallet

1. **Run the setup command**:
   ```bash
   npm run setup
   ```

2. **When it asks for your private key**:
   - Go to your crypto wallet (like MetaMask)
   - Find your private key in the wallet settings
   - Copy and paste it when the bot asks
   - Press Enter

3. **For the other questions** (API key, RPC URL):
   - Just press Enter to skip them (they're optional)

**Done!** The bot now knows your wallet.

## Step 3: Test It Locally (Optional - Just to Make Sure It Works)

1. **Start the bot**:
   ```bash
   npm run dev
   ```

2. **Open your web browser** and go to: `http://localhost:3000`

3. **You should see a dashboard**. This means it's working!

4. **Press `Control + C` in Terminal to stop the bot** (you'll deploy it to Railway next so it runs 24/7)

## Step 4: Deploy to Railway (So It Runs 24/7)

### Part A: Create Railway Account

1. **Go to [railway.app](https://railway.app)** in your web browser
2. **Click "Start a New Project"** or "Sign Up"
3. **Sign up with your GitHub account** (easiest way)
4. **Railway will ask for access to your GitHub** - click "Authorize"

### Part B: Connect Your Code

1. **In Railway, click "New Project"**
2. **Click "Deploy from GitHub repo"**
3. **Find your `polymarket-bot-test` repository** in the list
4. **Click on it** to connect it

### Part C: Add Your Wallet Information

1. **In Railway, click on your project**
2. **Click the "Variables" tab** (or "Environment" tab)
3. **Click "New Variable"** and add these one by one:

   **Variable 1:**
   - Name: `PRIVATE_KEY`
   - Value: (paste your wallet private key here - the same one you used in Step 2)
   - Click "Add"

   **Variable 2:**
   - Name: `POLYGON_RPC_URL`
   - Value: `https://polygon-rpc.com`
   - Click "Add"

   **That's it!** Railway will automatically add the `PORT` variable for you.

### Part D: Deploy

1. **Railway will automatically start building and deploying** your bot
2. **Wait a few minutes** - you'll see it building in the Railway dashboard
3. **When it says "Deployed"** - you're done! Your bot is now running 24/7

## Step 5: Use Your Bot

1. **In Railway, click on your project**
2. **Click the "Settings" tab**
3. **Find "Generate Domain"** and click it
4. **Copy the URL** it gives you (looks like `https://your-bot-name.up.railway.app`)
5. **Open that URL in your web browser**
6. **You'll see the dashboard** where you can:
   - Add wallet addresses to track
   - See all the trades being copied
   - Check performance stats

## Adding Wallets to Track

1. **Open your bot's dashboard** (the Railway URL from Step 5)
2. **Find the "Add Wallet" section**
3. **Paste a wallet address** you want to copy trades from
4. **Click "Add"**
5. **The bot will start copying their trades automatically!**

## Important Notes

⚠️ **NEVER share your private key with anyone!**
⚠️ **Start with small amounts to test!**
⚠️ **This bot uses real money - be careful!**

## Troubleshooting

**Bot won't start?**
- Make sure you added the `PRIVATE_KEY` variable in Railway
- Check Railway's logs (click "Deployments" → click the latest one → "View Logs")

**Can't see the dashboard?**
- Make sure Railway finished deploying (check the "Deployments" tab)
- Try the "Generate Domain" button again in Settings

**Need help?**
- Check Railway's logs for error messages
- Make sure your private key is correct (no extra spaces)

## That's It!

Your bot is now running 24/7 on Railway. It will automatically copy trades from any wallets you add to track. You can check on it anytime by visiting your Railway dashboard URL.
