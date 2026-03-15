#!/usr/bin/env node

/**
 * Startup script that handles setup if needed, then starts the bot
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ENV_PATH = path.join(__dirname, '.env');

// Check if .env exists
if (!fs.existsSync(ENV_PATH)) {
  console.log('\n🔧 No configuration found. Running setup first...\n');

  // Run setup synchronously and wait for it to complete
  const result = spawnSync('node', [path.join(__dirname, 'setup.cjs')], {
    stdio: 'inherit',
    cwd: __dirname
  });

  if (result.status !== 0) {
    console.log('\n❌ Setup failed or was cancelled.\n');
    process.exit(1);
  }

  // Check if .env was created
  if (!fs.existsSync(ENV_PATH)) {
    console.log('\n❌ Setup did not create .env file. Please try again.\n');
    process.exit(1);
  }

  console.log('\n✨ Setup complete! Starting bot...\n');
}

// Start the main app and the isolated discovery worker sidecar.
const bot = spawn('npx', ['tsx', 'watch', 'src/index.ts'], {
  stdio: 'inherit',
  cwd: __dirname
});

const discoveryWorker = spawn('npx', ['tsx', 'watch', 'src/discovery/discoveryWorker.ts'], {
  stdio: 'inherit',
  cwd: __dirname
});

const shutdownChildren = () => {
  if (!bot.killed) bot.kill('SIGTERM');
  if (!discoveryWorker.killed) discoveryWorker.kill('SIGTERM');
};

process.on('SIGINT', shutdownChildren);
process.on('SIGTERM', shutdownChildren);

bot.on('close', (code) => {
  if (!discoveryWorker.killed) discoveryWorker.kill('SIGTERM');
  process.exit(code);
});

discoveryWorker.on('close', (code) => {
  if (!bot.killed) {
    console.error(`\n[DiscoveryWorker] exited with code ${code}. Stopping dev runner.\n`);
    bot.kill('SIGTERM');
  }
});
