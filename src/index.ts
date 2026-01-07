import { config } from './config.js';
import { CopyTrader } from './copyTrader.js';
import { createServer, startServer } from './server.js';
import { Storage } from './storage.js';

/**
 * Main entry point for the Polymarket Copytrade Bot
 */
async function main() {
  let copyTrader: CopyTrader | null = null;
  
  try {
    // Ensure data directory exists (always do this, even if config fails)
    await Storage.ensureDataDir();

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
      console.error('⚠️  Please configure PRIVATE_KEY and restart.');
      // Don't exit - let the server keep running so user can see the error
      return;
    }

    // Initialize copy trader
    console.log('🚀 Initializing copy trader...');
    try {
      await copyTrader.initialize();

      // Start the copy trading bot
      console.log('🤖 Starting copy trading bot...');
      await copyTrader.start();
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
