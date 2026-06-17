/**
 * Hosted CLOB diagnostic — run on server with tenant context.
 * Usage: AUTH_MODE=oidc STORAGE_BACKEND=sqlite DATA_DIR=... AUTH_SESSION_SECRET=... \
 *   node scripts/diagnose-hosted-clob.mjs tenant_7220d227bb12e691 main
 */
import { config } from '../dist/config.js';
import { runWithTenant } from '../dist/tenantContext.js';
import { ensureWalletConfigLoaded, getTradingWallet } from '../dist/walletManager.js';
import { getSigner } from '../dist/secureKeyManager.js';
import { createClobViemWalletClient } from '../dist/clobViemSigner.js';
import { ClobClient } from '@polymarket/clob-client-v2';
import { PolymarketApi } from '../dist/polymarketApi.js';
import { resolveFunderAddress } from '../dist/clobClientFactory.js';

const tenantId = process.argv[2];
const walletId = process.argv[3] || 'main';
if (!tenantId) {
  console.error('Usage: node scripts/diagnose-hosted-clob.mjs <tenantId> [walletId]');
  process.exit(1);
}

await runWithTenant(tenantId, async () => {
  await ensureWalletConfigLoaded();
  const tw = getTradingWallet(walletId);
  if (!tw) {
    console.error('Wallet not found:', walletId);
    process.exit(1);
  }
  console.log('Trading wallet:', { id: tw.id, address: tw.address, proxy: tw.proxyAddress, sig: tw.polymarketSignatureType, hasCreds: tw.hasCredentials });

  const signer = getSigner(walletId);
  const pk = signer.privateKey;
  console.log('ethers signer address:', signer.address);
  console.log('privateKey length:', pk?.length, 'starts with 0x:', pk?.startsWith?.('0x'));

  const wc = createClobViemWalletClient(pk);
  console.log('viem account.address:', wc.account?.address);
  console.log('viem has signTypedData:', typeof wc.signTypedData);

  const api = new PolymarketApi();
  const funder = await resolveFunderAddress(tw, api);
  console.log('funder:', funder);

  const temp = new ClobClient({
    host: config.polymarketClobApiUrl || 'https://clob.polymarket.com',
    chain: 137,
    signer: wc,
  });
  try {
    const creds = await temp.createOrDeriveApiKey();
    console.log('createOrDeriveApiKey: OK', Boolean(creds?.key));
  } catch (e) {
    console.error('createOrDeriveApiKey: FAIL', e.message);
    process.exit(1);
  }
});
