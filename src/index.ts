import { config } from './config.js';
import { CopyTrader } from './copyTrader.js';
import { createServer, startServer } from './server.js';
import { Storage } from './storage.js';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

/**
 * Run the setup script and wait for it to complete
 */
function runSetup(): Promise<boolean> {
  return new Promise((resolve) => {
    console.log('\n🔧 No configuration found. Starting setup wizard...\n');
    
    const setupPath = join(process.cwd(), 'setup.js');
    
    // Run setup.js with stdio inherited so user can interact
    const child = spawn('node', [setupPath], {
      stdio: 'inherit',
      cwd: process.cwd()
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    
    child.on('error', (err) => {
      console.error('Failed to run setup:', err.message);
      resolve(false);
    });
  });
}

/**
 * Check if .env file exists with a private key configured
 */
function isConfigured(): boolean {
  const envPath = join(process.cwd(), '.env');
  return existsSync(envPath);
}

/**
 * Main entry point for the Polymarket Copytrade Bot
 */
async function main() {
  let copyTrader: CopyTrader | null = null;
  
  try {
    // Ensure data directory exists (always do this, even if config fails)
    await Storage.ensureDataDir();

    // Check if configuration exists - if not, run setup
    if (!isConfigured()) {
      const setupSuccess = await runSetup();
      
      if (!setupSuccess) {
        console.log('\n❌ Setup was not completed. Please try again.\n');
        process.exit(1);
      }
      
      console.log('\n✨ Setup complete! Starting bot...\n');
      
      // Re-load environment variables from the new .env file
      const dotenv = await import('dotenv');
      dotenv.config({ override: true });
      
      // Update config with new values
      config.privateKey = process.env.PRIVATE_KEY || '';
      config.polymarketBuilderApiKey = process.env.POLYMARKET_BUILDER_API_KEY || '';
      config.polymarketBuilderSecret = process.env.POLYMARKET_BUILDER_SECRET || '';
      config.polymarketBuilderPassphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE || '';
    }

    // Create and start web server first (so it's accessible even if bot init fails)
    console.log('🌐 Starting web server...');
    copyTrader = new CopyTrader();
    const app = await createServer(copyTrader);
    await startServer(app);

    // Validate configuration
    console.log('🔧 Validating configuration...');
    try {
      config.validate();
    } catch (error: any) {
      console.error('⚠️  Configuration validation failed:', error.message);
      console.error('⚠️  Bot will not start, but web server is running.');
      console.error('⚠️  Delete your .env file and restart to run setup again.');
      // Don't exit - let the server keep running so user can see the error
      return;
    }

    // Initialize copy trader
    console.log('🚀 Initializing copy trader...');
    try {
      await copyTrader.initialize();

      // Check if there are any tracked wallets
      const trackedWallets = await Storage.getActiveWallets();
      const activeWallets = trackedWallets.filter(w => w.active);
      
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📊 BOT STATUS`);
      console.log(`${'='.repeat(60)}`);
      
      if (trackedWallets.length === 0) {
        console.log('\n⚠️  WARNING: No wallets are being tracked!');
        console.log('   To start copy trading:');
        console.log('   1. Open the web dashboard at http://localhost:' + config.port);
        console.log('   2. Add wallet addresses to track');
        console.log('   3. The bot will automatically start monitoring them\n');
      } else {
        console.log(`\n📋 Tracked Wallets: ${trackedWallets.length} total, ${activeWallets.length} active`);
        console.log(`${'─'.repeat(60)}`);
        for (const wallet of trackedWallets) {
          const status = wallet.active ? '✅ ACTIVE' : '⏸️  INACTIVE';
          console.log(`   • ${wallet.address.substring(0, 10)}...${wallet.address.substring(wallet.address.length - 8)} - ${status}`);
        }
        console.log(`${'='.repeat(60)}\n`);
      }

      // Start the copy trading bot
      console.log('🤖 Starting copy trading bot...');
      await copyTrader.start();
      
      // Get status after starting
      const status = copyTrader.getStatus();
      const wsStatus = status.websocketStatus;
      
      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ BOT STARTED SUCCESSFULLY`);
      console.log(`${'='.repeat(60)}`);
      console.log(`Monitoring Methods:`);
      console.log(`   📡 WebSocket: ${wsStatus.isConnected ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
      if (wsStatus.isConnected && wsStatus.lastConnectionTime) {
        const connectionAge = Math.floor((Date.now() - wsStatus.lastConnectionTime.getTime()) / 1000);
        console.log(`      Last connected: ${connectionAge}s ago`);
      }
      console.log(`      Tracked wallets: ${wsStatus.trackedWalletsCount}`);
      console.log(`   🔄 Polling: ${status.running ? '✅ ACTIVE' : '⏸️  INACTIVE'}`);
      console.log(`      Fallback mode: ${!wsStatus.isConnected && status.running ? 'Yes (WebSocket unavailable)' : 'No'}`);
      console.log(`\n💡 Status: ${wsStatus.isConnected ? 'Real-time monitoring active' : 'Polling mode (fallback)'}`);
      console.log(`${'='.repeat(60)}\n`);
    } catch (error: any) {
      console.error('⚠️  Failed to initialize or start bot:', error.message);
      console.error('⚠️  Bot will not run, but web server is accessible.');
      console.error('⚠️  Check your configuration and logs.');
      // Don't exit - let the server keep running
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down...');
      if (copyTrader) {
        copyTrader.stop();
      }
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 Shutting down...');
      if (copyTrader) {
        copyTrader.stop();
      }
      process.exit(0);
    });

  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

// Run the bot
main().catch(console.error);
