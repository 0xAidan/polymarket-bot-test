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
  const result = spawnSync('node', [path.join(__dirname, 'setup.js')], {
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

// Now start the actual bot with tsx
const bot = spawn('npx', ['tsx', 'watch', 'src/index.ts'], {
  stdio: 'inherit',
  cwd: __dirname
});

bot.on('close', (code) => {
  process.exit(code);
});
