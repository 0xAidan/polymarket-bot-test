/**
 * pUSD auto-wrap helper for hosted multi-tenant trading.
 *
 * WHY THIS EXISTS
 * ---------------
 * Polymarket's web UI runs a one-time "convert balance to pUSD + approve new
 * exchange contracts" flow on first load after the V2 cutover (Apr 28 2026).
 * Hosted bot users may NEVER touch polymarket.com — they only interact through
 * our app. Without this auto-wrap, their first post-cutover trade would fail
 * with "insufficient pUSD balance" even though they have plenty of USDC.e.
 *
 * This helper runs once per signer per process (right after the V2 CLOB client
 * initializes) and silently approves the CollateralOnramp + wraps any USDC.e
 * ≥ $1 sitting on the EOA into pUSD. It is idempotent and never throws —
 * failures are logged at warn level and ignored, because users may already
 * have pUSD via another path (Bridge auto-wrap on deposit, manual wrap, etc.).
 */
import * as ethers from 'ethers';
import { createComponentLogger } from './logger.js';

// V2 collateral plumbing on Polygon
const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const COLLATERAL_ONRAMP_ADDRESS = '0x93070a847efEf7F70739046A929D47a521F5B8ee';
const USDCE_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // bridged USDC on Polygon

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ONRAMP_ABI = [
  'function wrap(address _asset, address _to, uint256 _amount) external',
];

// In-memory dedupe so we only attempt once per signer per process
const attempted = new Set<string>();

export async function ensurePusdReady(
  signer: ethers.Wallet,
  _funderAddress: string,
  parentLog: ReturnType<typeof createComponentLogger>,
): Promise<void> {
  const log = parentLog;
  // Auto-wrap targets the EOA's USDC.e, not the proxy. Proxies on Polymarket
  // are wallet-factory deployed and typically don't hold USDC.e directly when
  // API trading from a magic/EOA path. If users keep funds on a proxy, their
  // proxy is managed by Polymarket's UI wrap path on first interaction.
  const eoa = signer.address;
  const key = eoa.toLowerCase();
  if (attempted.has(key)) return;
  attempted.add(key);

  try {
    const provider = signer.provider as ethers.providers.Provider;
    if (!provider) { log.warn('[pUSD] No provider on signer; skipping auto-wrap'); return; }

    const usdce = new ethers.Contract(USDCE_ADDRESS, ERC20_ABI, signer);
    const pusd = new ethers.Contract(PUSD_ADDRESS, ERC20_ABI, provider);

    const [usdceBalRaw, pusdBalRaw, allowanceRaw] = await Promise.all([
      usdce.balanceOf(eoa),
      pusd.balanceOf(eoa),
      usdce.allowance(eoa, COLLATERAL_ONRAMP_ADDRESS),
    ]);

    // Only wrap if we have meaningful USDC.e (>= $1) sitting on the EOA
    const minWrap = ethers.utils.parseUnits('1', 6);
    if (usdceBalRaw.lt(minWrap)) {
      log.info(`[pUSD] EOA ${eoa.substring(0, 10)}… holds <$1 USDC.e — no auto-wrap needed (pUSD bal=${pusdBalRaw.toString()})`);
      return;
    }

    log.info(`[pUSD] Auto-wrapping ${ethers.utils.formatUnits(usdceBalRaw, 6)} USDC.e → pUSD for ${eoa}`);

    if (allowanceRaw.lt(usdceBalRaw)) {
      log.info(`[pUSD] Approving CollateralOnramp to spend USDC.e`);
      const approveTx = await usdce.approve(COLLATERAL_ONRAMP_ADDRESS, ethers.constants.MaxUint256);
      await approveTx.wait(1);
    }

    const onramp = new ethers.Contract(COLLATERAL_ONRAMP_ADDRESS, ONRAMP_ABI, signer);
    const wrapTx = await onramp.wrap(USDCE_ADDRESS, eoa, usdceBalRaw);
    await wrapTx.wait(1);
    log.info(`[pUSD] ✓ Wrapped — tx ${wrapTx.hash}`);
  } catch (err: any) {
    log.warn(`[pUSD] Auto-wrap skipped/failed (non-fatal): ${err?.message ?? err}`);
  }
}
