import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENV_EXAMPLE_PATH = path.join(__dirname, 'ENV_EXAMPLE.txt');
const ENV_PATH = path.join(__dirname, '.env');

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
  console.log('═'.repeat(60));
  console.log('   🚀 POLYMARKET COPYTRADE BOT - SETUP WIZARD');
  console.log('═'.repeat(60));
  console.log('\nI\'ll guide you through setting up your bot step by step.\n');

  // Check if .env already exists
  if (fs.existsSync(ENV_PATH)) {
    const overwrite = await question('⚠️  .env file already exists. Overwrite? (yes/no): ');
    if (overwrite.toLowerCase() !== 'yes' && overwrite.toLowerCase() !== 'y') {
      console.log('\n✅ Setup cancelled. Your existing .env file is unchanged.\n');
      rl.close();
      return;
    }
    console.log('');
  }

  // Read the example file
  let envContent;
  try {
    envContent = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
  } catch (error) {
    console.error('❌ Error: Could not read ENV_EXAMPLE.txt');
    console.error('Make sure you\'re running this from the project folder.\n');
    rl.close();
    process.exit(1);
  }

  // ========== STEP 1: Private Key ==========
  console.log('─'.repeat(60));
  console.log('STEP 1 of 4: Your Wallet Private Key');
  console.log('─'.repeat(60));
  console.log('\nThis is the private key from your crypto wallet.');
  console.log('It should start with "0x" and be 66 characters long.');
  console.log('\n⚠️  IMPORTANT: Never share this with anyone!\n');

  const privateKey = await question('Enter your private key: ');

  if (!privateKey || !privateKey.trim()) {
    console.log('\n❌ Error: Private key cannot be empty!\n');
    rl.close();
    process.exit(1);
  }

  const trimmedKey = privateKey.trim();

  // Basic validation with option to continue
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

  // ========== STEP 2: Builder API Key ==========
  console.log('\n');
  console.log('─'.repeat(60));
  console.log('STEP 2 of 4: Polymarket Builder API Key');
  console.log('─'.repeat(60));
  console.log('\nGo to: https://polymarket.com/settings?tab=builder');
  console.log('Click "Create API Key" and copy the API Key here.');
  console.log('\n(This is REQUIRED for trading to work)\n');

  const builderApiKey = await question('Enter your Builder API Key: ');

  if (!builderApiKey || !builderApiKey.trim()) {
    console.log('\n⚠️  Warning: Without Builder API credentials, trading will fail!');
  }

  // ========== STEP 3: Builder Secret ==========
  console.log('\n');
  console.log('─'.repeat(60));
  console.log('STEP 3 of 4: Polymarket Builder API Secret');
  console.log('─'.repeat(60));
  console.log('\nThis is shown once when you create the API key.');
  console.log('If you didn\'t save it, you may need to create a new key.\n');

  const builderSecret = await question('Enter your Builder API Secret: ');

  // ========== STEP 4: Builder Passphrase ==========
  console.log('\n');
  console.log('─'.repeat(60));
  console.log('STEP 4 of 4: Polymarket Builder API Passphrase');
  console.log('─'.repeat(60));
  console.log('\nThis is the passphrase you created with your API key.\n');

  const builderPassphrase = await question('Enter your Builder API Passphrase: ');

  // Replace placeholders in env content
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

  // Write the .env file
  try {
    fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
    console.log('\n');
    console.log('═'.repeat(60));
    console.log('   ✅ SETUP COMPLETE!');
    console.log('═'.repeat(60));
    console.log('\nYour .env file has been created.');
    console.log('Wallet configured: ' + trimmedKey.substring(0, 10) + '...' + trimmedKey.substring(trimmedKey.length - 8));
    console.log('');
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
