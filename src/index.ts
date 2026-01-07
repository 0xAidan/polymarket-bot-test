import { config } from './config.js';
import { CopyTrader } from './copyTrader.js';
import { createServer, startServer } from './server.js';
import { Storage } from './storage.js';

/**
 * Main entry point for the Polymarket Copytrade Bot
 */
async function main() {
  try {
    // Validate configuration
    console.log('🔧 Validating configuration...');
    config.validate();

    // Ensure data directory exists
    await Storage.ensureDataDir();

    // Initialize copy trader
    console.log('🚀 Initializing copy trader...');
    const copyTrader = new CopyTrader();
    await copyTrader.initialize();

    // Start the copy trading bot
    console.log('🤖 Starting copy trading bot...');
    await copyTrader.start();

    // Create and start web server
    console.log('🌐 Starting web server...');
    const app = await createServer(copyTrader);
    await startServer(app);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down...');
      copyTrader.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 Shutting down...');
      copyTrader.stop();
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
