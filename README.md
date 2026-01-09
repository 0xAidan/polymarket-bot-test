# Polymarket Copytrade Bot - Complete Setup Guide

**A bot that automatically copies trades from wallets you track on Polymarket.**

This guide will walk you through **EVERY SINGLE STEP** from zero to running bot. No prior experience needed!

---

## 📋 Table of Contents

1. [What This Bot Does](#what-this-bot-does)
2. [What You Need Before Starting](#what-you-need-before-starting)
3. [Step 0: Install Prerequisites](#step-0-install-prerequisites)
4. [Step 1: Clone the Repository](#step-1-clone-the-repository)
5. [Step 2: Navigate to the Project Folder](#step-2-navigate-to-the-project-folder)
6. [Step 3: Install Dependencies](#step-3-install-dependencies)
7. [Step 4: Set Up Your Wallet and API Keys](#step-4-set-up-your-wallet-and-api-keys)
8. [Step 5: Start the Bot](#step-5-start-the-bot)
9. [Step 6: Use the Dashboard](#step-6-use-the-dashboard)
10. [Troubleshooting](#troubleshooting)

---

## What This Bot Does

1. You add wallet addresses to track (wallets of traders you want to copy)
2. The bot watches those wallets for trades on Polymarket
3. When they make a trade, the bot automatically makes the same trade for you
4. You can see everything in a web dashboard at `http://localhost:3001`

**⚠️ IMPORTANT WARNINGS:**
- This bot uses **REAL MONEY** - start with small amounts to test!
- **NEVER share your private key** with anyone!
- Trades are **irreversible** - be careful!

---

## What You Need Before Starting

Before you can run this bot, you need:

1. **A computer** (Mac, Windows, or Linux)
2. **Node.js** installed (version 18 or higher)
3. **npm** (comes with Node.js)
4. **Git** installed (to clone the repository)
5. **A crypto wallet** with a private key (like MetaMask)
6. **Polymarket Builder API credentials** (we'll show you how to get these)

---

## Step 0: Install Prerequisites

### Check if You Have Node.js and npm

1. **Open your Terminal** (Mac/Linux) or **Command Prompt** (Windows)
   - **Mac**: Press `Cmd + Space`, type "Terminal", press Enter
   - **Windows**: Press `Win + R`, type "cmd", press Enter
   - **Linux**: Press `Ctrl + Alt + T`

2. **Type this command and press Enter:**
   ```bash
   node --version
   ```

3. **You should see something like:** `v18.17.0` or `v20.10.0`
   - ✅ **If you see a version number**: You have Node.js! Skip to "Check if you have Git"
   - ❌ **If you see an error**: You need to install Node.js (see below)

4. **Check npm too:**
   ```bash
   npm --version
   ```
   - ✅ **If you see a version number**: Great! You have npm!
   - ❌ **If you see an error**: Install Node.js (npm comes with it)

### Install Node.js (if you don't have it)

1. **Go to:** https://nodejs.org/
2. **Download the "LTS" version** (the green button that says "Recommended For Most Users")
3. **Run the installer** and follow the instructions
4. **Restart your Terminal/Command Prompt** after installing
5. **Check again** with `node --version` to make sure it worked

### Check if You Have Git

1. **In your Terminal/Command Prompt, type:**
   ```bash
   git --version
   ```

2. **You should see something like:** `git version 2.39.0`
   - ✅ **If you see a version number**: You have Git! Skip to Step 1
   - ❌ **If you see an error**: You need to install Git (see below)

### Install Git (if you don't have it)

**Mac:**
- Git might already be installed. If not, install Xcode Command Line Tools:
  ```bash
  xcode-select --install
  ```

**Windows:**
1. Go to: https://git-scm.com/download/win
2. Download and run the installer
3. Use all the default options (just keep clicking "Next")

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install git
```

**After installing Git, restart your Terminal/Command Prompt and check again with `git --version`**

---

## Step 1: Clone the Repository

"Cloning" means downloading the code from GitHub to your computer.

### Find the Repository URL

1. **Go to the GitHub repository page** (the page where you found this README)
2. **Click the green "Code" button** (usually in the top right)
3. **Copy the URL** that appears (it will look like: `https://github.com/username/polymarket-bot-test.git`)
   - You can click the copy icon next to the URL

### Clone It

1. **Open your Terminal/Command Prompt**

2. **Navigate to where you want to save the project** (optional, but recommended)
   - For example, if you want it in a "websites" folder:
     ```bash
     cd ~/websites
     ```
   - Or if you want it on your Desktop:
     ```bash
     cd ~/Desktop
     ```
   - **Note:** `~` means your home folder. On Windows, you might use `cd C:\Users\YourName\Desktop`

3. **Clone the repository:**
   ```bash
   git clone https://github.com/username/polymarket-bot-test.git
   ```
   (Replace the URL with the actual URL you copied)

4. **Wait for it to finish** - you'll see it downloading files

5. **You should see:** `Cloning into 'polymarket-bot-test'...` and then it finishes

---

## Step 2: Navigate to the Project Folder

After cloning, you need to "go into" the project folder.

1. **In your Terminal/Command Prompt, type:**
   ```bash
   cd polymarket-bot-test
   ```

2. **Press Enter**

3. **You should now be "inside" the project folder**

4. **Verify you're in the right place:**
   ```bash
   ls
   ```
   (On Windows, use `dir` instead of `ls`)

5. **You should see files like:** `package.json`, `README.md`, `src`, etc.

---

## Step 3: Install Dependencies

The bot needs some "dependencies" (other code libraries) to work. We install them with npm.

1. **Make sure you're in the project folder** (you should be from Step 2)

2. **Type this command:**
   ```bash
   npm install
   ```

3. **Press Enter and wait** - this might take 1-3 minutes

4. **You'll see a lot of text scrolling** - this is normal! It's downloading and installing packages

5. **When it's done, you should see:**
   - A message like "added 234 packages" or similar
   - No error messages in red

6. **If you see errors:**
   - Make sure you're in the right folder (`cd polymarket-bot-test`)
   - Make sure you have Node.js installed (`node --version`)
   - Try running `npm install` again

---

## Step 4: Set Up Your Wallet and API Keys

Before the bot can run, you need to give it:
1. Your wallet's private key
2. Polymarket Builder API credentials

### Option A: Use the Setup Script (EASIEST - Recommended)

The project includes a setup script that asks you questions and creates the configuration file automatically.

1. **Make sure you're in the project folder** (`cd polymarket-bot-test`)

2. **Run the setup command:**
   ```bash
   npm run setup
   ```

3. **The script will ask you questions one by one:**

   **Question 1: Private Key**
   - It will ask: `Private Key:`
   - **What is this?** Your wallet's private key (from MetaMask or your crypto wallet)
   - **How to find it:**
     - **MetaMask**: Click the three dots menu → Account Details → Show Private Key → Enter password → Copy the key
     - **Other wallets**: Look in your wallet's settings/security section
   - **Paste your private key** (it should start with `0x` and be 66 characters long)
   - **Press Enter**

   **Question 2: Builder API Key**
   - It will ask: `Builder API Key:`
   - **How to get this:**
     1. Go to https://polymarket.com and **log in**
     2. Click your **profile picture/icon** (usually top right)
     3. Click **"Settings"**
     4. Click the **"Builder"** tab
     5. If you don't have API keys yet, click **"Create New API Key"** or similar
     6. **Copy the "API Key"** value
   - **Paste it** and press Enter

   **Question 3: Builder API Secret**
   - It will ask: `Builder API Secret:`
   - **Where to find it:** Same place as above (Polymarket Settings → Builder tab)
   - **Copy the "Secret"** value
   - **Paste it** and press Enter

   **Question 4: Builder API Passphrase**
   - It will ask: `Builder API Passphrase:`
   - **Where to find it:** Same place as above (Polymarket Settings → Builder tab)
   - **Copy the "Passphrase"** value
   - **Paste it** and press Enter

   **Question 5: Optional API Key** (you can skip this)
   - It will ask: `API Key:` (optional)
   - **Just press Enter** to skip if you don't have one

   **Question 6: Optional RPC URL** (you can skip this)
   - It will ask: `RPC URL:` (optional)
   - **Just press Enter** to use the default

4. **When it's done, you should see:**
   ```
   ✅ Success! Your .env file has been created.
   🎉 Setup complete! You can now run: npm run dev
   ```

### Option B: Manual Setup (Advanced)

If you prefer to create the `.env` file manually:

1. **In the project folder, create a new file called `.env`**
   - **Mac/Linux:** You can use: `touch .env`
   - **Windows:** Create a new text file and rename it to `.env` (make sure it's not `.env.txt`)

2. **Open the file** in a text editor (Notepad, VS Code, etc.)

3. **Copy the contents from `ENV_EXAMPLE.txt`** and paste them into `.env`

4. **Replace the placeholder values:**
   - `PRIVATE_KEY=your_private_key_here` → Replace with your actual private key
   - `POLYMARKET_BUILDER_API_KEY=your_builder_api_key_here` → Replace with your API key
   - `POLYMARKET_BUILDER_SECRET=your_builder_secret_here` → Replace with your secret
   - `POLYMARKET_BUILDER_PASSPHRASE=your_builder_passphrase_here` → Replace with your passphrase

5. **Save the file**

### ⚠️ Important Notes About Credentials

- **Private Key:** This is like the password to your wallet. **NEVER share it with anyone!** Never commit it to GitHub!
- **Builder API Credentials:** These are **REQUIRED** for the bot to work. Without them, your trades will be blocked by Cloudflare.
- **The `.env` file:** This file contains your secrets. It should already be in `.gitignore` so it won't be uploaded to GitHub. **Never share this file!**

---

## Step 5: Start the Bot

Now that everything is set up, you can start the bot!

1. **Make sure you're in the project folder** (`cd polymarket-bot-test`)

2. **Start the bot:**
   ```bash
   npm run dev
   ```

3. **You should see output like this:**
   ```
   🌐 Starting web server...
   🔧 Validating configuration...
   ✓ Builder API credentials configured
   🚀 Initializing copy trader...
   📊 BOT STATUS
   ============================================================
   
   ⚠️  WARNING: No wallets are being tracked!
      To start copy trading:
      1. Open the web dashboard at http://localhost:3001
      2. Add wallet addresses to track
      3. The bot will automatically start monitoring them
   
   ✅ BOT STARTED SUCCESSFULLY
   ============================================================
   ```

4. **The bot is now running!** 🎉
   - **Don't close the Terminal/Command Prompt** - the bot needs to keep running
   - You'll see status updates and logs in the terminal
   - The web dashboard is now available at `http://localhost:3001`

5. **To stop the bot:**
   - Press `Ctrl + C` in the terminal
   - Wait for it to shut down gracefully

---

## Step 6: Use the Dashboard

The bot includes a web dashboard where you can:
- Add wallet addresses to track
- See the bot's status
- View your tracked wallets
- See trade history

### Open the Dashboard

1. **Open your web browser** (Chrome, Firefox, Safari, etc.)

2. **Go to:** `http://localhost:3001`
   - Type this in the address bar and press Enter

3. **You should see the dashboard** with options to add wallets

### Add a Wallet to Track

1. **Find a wallet address** you want to copy trades from
   - This could be a successful trader's wallet address on Polymarket
   - Wallet addresses look like: `0x1234567890abcdef1234567890abcdef12345678`

2. **In the dashboard, find the "Add Wallet" section**

3. **Paste the wallet address** into the input field

4. **Click "Add" or "Track Wallet"**

5. **The bot will now start monitoring that wallet** for trades!

### What Happens Next

- The bot watches the wallets you added
- When they make a trade on Polymarket, the bot detects it
- The bot automatically makes the same trade for you
- You can see all activity in the dashboard

---

## Troubleshooting

### Problem: "Command not found: node" or "Command not found: npm"

**Solution:** Node.js is not installed or not in your PATH.
- Go back to [Step 0: Install Prerequisites](#step-0-install-prerequisites)
- Install Node.js from https://nodejs.org/
- **Restart your Terminal/Command Prompt** after installing

### Problem: "Command not found: git"

**Solution:** Git is not installed.
- Go back to [Step 0: Install Prerequisites](#step-0-install-prerequisites)
- Install Git for your operating system
- **Restart your Terminal/Command Prompt** after installing

### Problem: "npm install" fails with errors

**Possible causes:**
1. **Not in the right folder:** Make sure you ran `cd polymarket-bot-test` first
2. **Node.js version too old:** You need Node.js 18 or higher. Check with `node --version`
3. **Internet connection:** Make sure you're connected to the internet
4. **Try deleting and reinstalling:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```
   (On Windows, use `rmdir /s node_modules` and `del package-lock.json`)

### Problem: "PRIVATE_KEY is required" error when starting

**Solution:** You haven't set up your `.env` file yet.
- Go back to [Step 4: Set Up Your Wallet and API Keys](#step-4-set-up-your-wallet-and-api-keys)
- Run `npm run setup` to configure your wallet

### Problem: "Builder API credentials not configured" warning

**Solution:** You need to add your Polymarket Builder API credentials.
- These are **REQUIRED** - the bot won't work without them
- Go to https://polymarket.com/settings?tab=builder
- Create API keys if you don't have them
- Add them to your `.env` file:
  ```
  POLYMARKET_BUILDER_API_KEY=your_key_here
  POLYMARKET_BUILDER_SECRET=your_secret_here
  POLYMARKET_BUILDER_PASSPHRASE=your_passphrase_here
  ```
- Restart the bot (`Ctrl + C` to stop, then `npm run dev` to start again)

### Problem: Can't access the dashboard at http://localhost:3001

**Possible causes:**
1. **Bot isn't running:** Make sure you ran `npm run dev` and it's still running
2. **Wrong port:** Check the terminal output - it will show which port it's using
3. **Firewall blocking:** Your firewall might be blocking the connection
4. **Try a different browser:** Sometimes browser extensions can interfere

### Problem: Trades are failing / Orders are being blocked

**Most common cause:** Missing or incorrect Builder API credentials.
- Make sure you have all three Builder credentials in your `.env` file
- Make sure there are no extra spaces or quotes around the values
- Verify your credentials are correct at https://polymarket.com/settings?tab=builder
- Make sure your wallet has enough funds

### Problem: "Port 3001 is already in use"

**Solution:** Something else is using port 3001.
- **Option 1:** Stop the other program using that port
- **Option 2:** Use a different port by adding to your `.env` file:
  ```
  PORT=3002
  ```
- Then restart the bot

### Problem: Bot says "No wallets are being tracked"

**This is normal!** It just means you haven't added any wallets yet.
- Open the dashboard at `http://localhost:3001`
- Add wallet addresses you want to track
- The bot will automatically start monitoring them

### Still Having Issues?

1. **Check the terminal output** - error messages usually tell you what's wrong
2. **Make sure all prerequisites are installed** (Node.js, npm, Git)
3. **Make sure you're in the project folder** (`cd polymarket-bot-test`)
4. **Try deleting `node_modules` and reinstalling:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```
5. **Check that your `.env` file exists** and has all required values
6. **Make sure the bot is actually running** (`npm run dev`)

---

## Quick Reference: Common Commands

```bash
# Navigate to project folder
cd polymarket-bot-test

# Install dependencies (do this once)
npm install

# Set up your wallet and API keys (do this once)
npm run setup

# Start the bot
npm run dev

# Stop the bot
# Press Ctrl + C in the terminal

# Build for production (advanced)
npm run build

# Run the built version (after building)
npm start
```

---

## What's Next?

Once your bot is running:

1. ✅ **Add wallets to track** via the dashboard at `http://localhost:3001`
2. ✅ **Monitor the terminal** for status updates and trade notifications
3. ✅ **Check the dashboard** to see tracked wallets and trade history
4. ✅ **Start with small amounts** to test everything works
5. ✅ **Keep the bot running** - it needs to stay online to monitor wallets

---

## Important Reminders

- ⚠️ **This bot uses REAL MONEY** - be careful!
- ⚠️ **NEVER share your private key** with anyone
- ⚠️ **Start with small amounts** to test
- ⚠️ **Builder API credentials are REQUIRED** - trades will fail without them
- ⚠️ **Keep the bot running** - close the terminal to stop it
- ⚠️ **Trades are irreversible** - double-check everything

---

## That's It!

You should now have a fully working Polymarket copytrade bot! 🎉

If you followed all the steps and still have issues, check the [Troubleshooting](#troubleshooting) section above.

**Happy trading!** (But remember: start small and be careful!)
