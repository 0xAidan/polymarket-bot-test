#!/usr/bin/env node

/**
 * Simple setup script to configure your wallet
 * Just run: npm run setup
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENV_EXAMPLE_PATH = join(__dirname, 'ENV_EXAMPLE.txt');
const ENV_PATH = join(__dirname, '.env');

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('\n🚀 Polymarket Bot Setup\n');
  console.log('This script will help you configure your wallet.\n');

  // Check if .env already exists
  if (existsSync(ENV_PATH)) {
    const overwrite = await question('⚠️  .env file already exists. Overwrite? (yes/no): ');
    if (overwrite.toLowerCase() !== 'yes' && overwrite.toLowerCase() !== 'y') {
      console.log('\n✅ Setup cancelled. Your existing .env file is unchanged.\n');
      rl.close();
      return;
    }
  }

  // Read the example file
  let envContent;
  try {
    envContent = readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
  } catch (error) {
    console.error('❌ Error: Could not read ENV_EXAMPLE.txt');
    console.error('Make sure you\'re running this from the project folder.\n');
    rl.close();
    process.exit(1);
  }

  // Get private key
  console.log('\n📝 Enter your wallet private key:');
  console.log('   (This is found in your crypto wallet settings)');
  console.log('   (It should start with "0x" and be 66 characters long)\n');
  
  const privateKey = await question('Private Key: ');
  
  if (!privateKey || !privateKey.trim()) {
    console.log('\n❌ Error: Private key cannot be empty!\n');
    rl.close();
    process.exit(1);
  }

  const trimmedKey = privateKey.trim();
  
  // Basic validation
  if (!trimmedKey.startsWith('0x')) {
    console.log('\n⚠️  Warning: Private key should start with "0x"');
    const continueAnyway = await question('Continue anyway? (yes/no): ');
    if (continueAnyway.toLowerCase() !== 'yes' && continueAnyway.toLowerCase() !== 'y') {
      console.log('\n✅ Setup cancelled.\n');
      rl.close();
      return;
    }
  }

  if (trimmedKey.length !== 66) {
    console.log(`\n⚠️  Warning: Private key length is ${trimmedKey.length}, expected 66`);
    const continueAnyway = await question('Continue anyway? (yes/no): ');
    if (continueAnyway.toLowerCase() !== 'yes' && continueAnyway.toLowerCase() !== 'y') {
      console.log('\n✅ Setup cancelled.\n');
      rl.close();
      return;
    }
  }

  // Ask for Builder API credentials (required for trading)
  console.log('\n🔐 Polymarket Builder API Credentials (REQUIRED for trading):');
  console.log('   Get these from: https://polymarket.com/settings?tab=builder\n');
  
  const builderApiKey = await question('Builder API Key: ');
  const builderSecret = await question('Builder API Secret: ');
  const builderPassphrase = await question('Builder API Passphrase: ');

  // Ask for optional API key
  console.log('\n🔑 Optional: Enter Polymarket API key (press Enter to skip):');
  const apiKey = await question('API Key: ');

  // Ask for optional RPC URL
  console.log('\n🌐 Optional: Enter Polygon RPC URL (press Enter to use default):');
  const rpcUrl = await question('RPC URL: ');

  // Replace placeholders
  envContent = envContent.replace('PRIVATE_KEY=your_private_key_here', `PRIVATE_KEY=${trimmedKey}`);
  
  if (builderApiKey && builderApiKey.trim()) {
    envContent = envContent.replace('POLYMARKET_BUILDER_API_KEY=your_builder_api_key_here', `POLYMARKET_BUILDER_API_KEY=${builderApiKey.trim()}`);
  }
  
  if (builderSecret && builderSecret.trim()) {
    envContent = envContent.replace('POLYMARKET_BUILDER_SECRET=your_builder_secret_here', `POLYMARKET_BUILDER_SECRET=${builderSecret.trim()}`);
  }
  
  if (builderPassphrase && builderPassphrase.trim()) {
    envContent = envContent.replace('POLYMARKET_BUILDER_PASSPHRASE=your_builder_passphrase_here', `POLYMARKET_BUILDER_PASSPHRASE=${builderPassphrase.trim()}`);
  }
  
  if (apiKey && apiKey.trim()) {
    envContent = envContent.replace('POLYMARKET_API_KEY=your_api_key_here_if_needed', `POLYMARKET_API_KEY=${apiKey.trim()}`);
  }

  if (rpcUrl && rpcUrl.trim()) {
    envContent = envContent.replace('POLYGON_RPC_URL=https://polygon-rpc.com', `POLYGON_RPC_URL=${rpcUrl.trim()}`);
  }

  // Write the .env file
  try {
    writeFileSync(ENV_PATH, envContent, 'utf-8');
    console.log('\n✅ Success! Your .env file has been created.');
    console.log('   Wallet configured: ' + trimmedKey.substring(0, 10) + '...' + trimmedKey.substring(trimmedKey.length - 8));
    console.log('\n🎉 Setup complete! You can now run: npm run dev\n');
  } catch (error) {
    console.error('\n❌ Error: Could not write .env file');
    console.error(error.message + '\n');
    rl.close();
    process.exit(1);
  }

  rl.close();
}

main().catch((error) => {
  console.error('\n❌ Setup failed:', error.message);
  rl.close();
  process.exit(1);
});
