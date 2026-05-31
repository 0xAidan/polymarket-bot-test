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
 * This helper runs once per signer+funder per process (right after the V2 CLOB
 * client initializes) and silently approves the CollateralOnramp + wraps any
 * USDC.e ≥ $1 into pUSD. It is idempotent and never throws — failures are
 * logged at warn level and ignored, because users may already have pUSD via
 * another path (Bridge auto-wrap on deposit, manual wrap, etc.).
 */
import * as ethers from 'ethers';
import { createComponentLogger } from './logger.js';
import { getValidEvmAddress } from './addressUtils.js';

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

// In-memory dedupe so we only attempt once per signer+funder per process
const attempted = new Set<string>();

export interface PusdReadyResult {
  ready: boolean;
  needsManualWrap?: boolean;
  message?: string;
}

export async function ensurePusdReady(
  signer: ethers.Wallet,
  funderAddress: string,
  parentLog: ReturnType<typeof createComponentLogger>,
  signatureType = 0,
): Promise<PusdReadyResult> {
  const log = parentLog;
  const eoa = signer.address;
  const funder = getValidEvmAddress(funderAddress) || eoa;
  const key = `${eoa.toLowerCase()}:${funder.toLowerCase()}`;
  if (attempted.has(key)) {
    return { ready: true };
  }

  try {
    const provider = signer.provider as ethers.providers.Provider;
    if (!provider) {
      log.warn('[pUSD] No provider on signer; skipping auto-wrap');
      attempted.add(key);
      return { ready: false, message: 'No RPC provider on signer' };
    }

    const usdceOnEoa = new ethers.Contract(USDCE_ADDRESS, ERC20_ABI, signer);
    const usdceRead = new ethers.Contract(USDCE_ADDRESS, ERC20_ABI, provider);
    const pusd = new ethers.Contract(PUSD_ADDRESS, ERC20_ABI, provider);

    const minWrap = ethers.utils.parseUnits('1', 6);
    const minPusd = ethers.utils.parseUnits('0.5', 6);
    const wrapTarget = funder.toLowerCase() === eoa.toLowerCase() ? eoa : funder;

    const [eoaUsdceRaw, funderUsdceRaw, funderPusdRaw, allowanceRaw] = await Promise.all([
      usdceOnEoa.balanceOf(eoa),
      usdceRead.balanceOf(funder),
      pusd.balanceOf(funder),
      usdceOnEoa.allowance(eoa, COLLATERAL_ONRAMP_ADDRESS),
    ]);

    if (funderPusdRaw.gte(minPusd)) {
      log.info(
        `[pUSD] Funder ${funder.substring(0, 10)}… already has pUSD (${ethers.utils.formatUnits(funderPusdRaw, 6)}) — no wrap needed`,
      );
      attempted.add(key);
      return { ready: true };
    }

    // EOA holds USDC.e — wrap to funder (proxy) when signature type 2, else to EOA.
    if (eoaUsdceRaw.gte(minWrap)) {
      log.info(
        `[pUSD] Auto-wrapping ${ethers.utils.formatUnits(eoaUsdceRaw, 6)} USDC.e → pUSD for ${wrapTarget}`,
      );

      if (allowanceRaw.lt(eoaUsdceRaw)) {
        log.info('[pUSD] Approving CollateralOnramp to spend USDC.e');
        const approveTx = await usdceOnEoa.approve(COLLATERAL_ONRAMP_ADDRESS, ethers.constants.MaxUint256);
        await approveTx.wait(1);
      }

      const onramp = new ethers.Contract(COLLATERAL_ONRAMP_ADDRESS, ONRAMP_ABI, signer);
      const wrapTx = await onramp.wrap(USDCE_ADDRESS, wrapTarget, eoaUsdceRaw);
      await wrapTx.wait(1);
      log.info(`[pUSD] ✓ Wrapped — tx ${wrapTx.hash}`);
      attempted.add(key);
      return { ready: true };
    }

    // Proxy/funder holds USDC.e but EOA cannot move it — user must wrap via Polymarket UI.
    if (
      funder.toLowerCase() !== eoa.toLowerCase()
      && funderUsdceRaw.gte(minWrap)
      && (signatureType === 2 || signatureType === 1)
    ) {
      const msg =
        `[pUSD] ${ethers.utils.formatUnits(funderUsdceRaw, 6)} USDC.e sits on proxy/funder ${funder.substring(0, 10)}… ` +
        'but the bot signer cannot wrap it on-chain. Open polymarket.com once to convert your balance to pUSD.';
      log.warn(msg);
      return { ready: false, needsManualWrap: true, message: msg };
    }

    log.info(
      `[pUSD] ${eoa.substring(0, 10)}… / ${funder.substring(0, 10)}… holds <$1 USDC.e on EOA — no auto-wrap (pUSD on funder=${funderPusdRaw.toString()})`,
    );
    attempted.add(key);
    return { ready: funderPusdRaw.gt(0) };
  } catch (err: any) {
    log.warn(`[pUSD] Auto-wrap skipped/failed (non-fatal): ${err?.message ?? err}`);
    return { ready: false, message: err?.message ?? String(err) };
  }
}
