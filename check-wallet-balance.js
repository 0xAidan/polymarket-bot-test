#!/usr/bin/env node
/**
 * Quick script to check wallet balance on Polygon
 * Run: node check-wallet-balance.js <wallet-address>
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const WALLET = process.argv[2] || '0x2D43e332aF357CAb0fa1b2692E1e0Fdb0B733010';
const RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

async function main() {
  console.log(`\n🔍 Checking wallet: ${WALLET}`);
  console.log(`📡 Using RPC: ${RPC_URL}\n`);
  
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL, {
      name: 'polygon',
      chainId: 137
    });
    
    // Test connection
    console.log('Testing RPC connection...');
    const blockNumber = await provider.getBlockNumber();
    console.log(`✓ Connected! Block: ${blockNumber}\n`);
    
    // Check native MATIC
    console.log('Checking native MATIC...');
    const maticBalance = await provider.getBalance(WALLET);
    const maticFormatted = ethers.formatEther(maticBalance);
    console.log(`  MATIC: ${parseFloat(maticFormatted).toFixed(6)} MATIC\n`);
    
    // Check USDC Native
    console.log('Checking Native USDC...');
    try {
      const nativeContract = new ethers.Contract(USDC_NATIVE, ERC20_ABI, provider);
      const nativeBalance = await nativeContract.balanceOf(WALLET);
      const nativeDecimals = await nativeContract.decimals();
      const nativeSymbol = await nativeContract.symbol();
      const nativeFormatted = parseFloat(ethers.formatUnits(nativeBalance, nativeDecimals));
      console.log(`  ${nativeSymbol}: ${nativeFormatted.toFixed(6)} ${nativeSymbol}`);
      if (nativeFormatted > 0) {
        console.log(`  ✓ Found ${nativeFormatted} ${nativeSymbol}!`);
      }
    } catch (error) {
      console.log(`  ✗ Error: ${error.message}`);
    }
    
    // Check USDC Bridged
    console.log('\nChecking Bridged USDC...');
    try {
      const bridgedContract = new ethers.Contract(USDC_BRIDGED, ERC20_ABI, provider);
      const bridgedBalance = await bridgedContract.balanceOf(WALLET);
      const bridgedDecimals = await bridgedContract.decimals();
      const bridgedSymbol = await bridgedContract.symbol();
      const bridgedFormatted = parseFloat(ethers.formatUnits(bridgedBalance, bridgedDecimals));
      console.log(`  ${bridgedSymbol}: ${bridgedFormatted.toFixed(6)} ${bridgedSymbol}`);
      if (bridgedFormatted > 0) {
        console.log(`  ✓ Found ${bridgedFormatted} ${bridgedSymbol}!`);
      }
    } catch (error) {
      console.log(`  ✗ Error: ${error.message}`);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('💡 If balance shows 0, check:');
    console.log('   1. Funds might be on a different network (Ethereum, zkEVM)');
    console.log('   2. Funds might be in a different token (USDT, DAI, etc.)');
    console.log('   3. Transaction might not have confirmed yet');
    console.log('   4. Check on PolygonScan: https://polygonscan.com/address/' + WALLET);
    console.log('='.repeat(60) + '\n');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\n💡 Troubleshooting:');
    console.error('   1. Check your RPC URL in .env file');
    console.error('   2. Try a different RPC endpoint (Alchemy, Infura, QuickNode)');
    console.error('   3. Check your internet connection\n');
    process.exit(1);
  }
}

main();
