/**
 * Compare staging Discovery v3 API cards to Polymarket reference APIs.
 * Run from any machine with network access (no DuckDB required).
 *
 *   npx tsx scripts/verify-staging-discovery-display.ts
 *   STAGING_API_BASE=https://staging.ditto.jungle.win npx tsx scripts/verify-staging-discovery-display.ts
 */
import {
  validateWalletPromotionGate,
  type PromotionGateDerived,
} from '../src/discovery/v3/dataApiValidator.js';
import { corruptionHeuristicReason } from '../src/discovery/v3/publishQualityGate.js';

const API_BASE = (process.env.STAGING_API_BASE ?? 'https://staging.ditto.jungle.win').replace(/\/$/, '');
const TIER_LIMIT = Number(process.env.STAGING_VERIFY_LIMIT ?? 10);

const GOLDEN: Array<{ label: string; address: string }> = [
  { label: 'Amber Falcon / dvisik', address: '0x2055b6a642839e86644d381c619aabc0afec1d9d' },
  { label: 'Amber Hare / c000OLI0003', address: '0xfedc381bf3fb5d20433bb4a0216b15dbbc5c6398' },
];

interface TierCard {
  address: string;
  alias?: string;
  realizedPnl: number;
  volumeTotal: number;
  fillCount: number;
  predictionsCount: number | null;
}

async function fetchAlphaCards(): Promise<TierCard[]> {
  const res = await fetch(`${API_BASE}/api/discovery/v3/tier/alpha?limit=${TIER_LIMIT}`);
  if (!res.ok) {
    throw new Error(`staging tier API http ${res.status}`);
  }
  const body = (await res.json()) as { data?: TierCard[] };
  if (!Array.isArray(body.data)) {
    throw new Error('staging tier API missing data[]');
  }
  return body.data;
}

async function verifyWallet(label: string, card: TierCard): Promise<string[]> {
  const failures: string[] = [];
  const heuristic = corruptionHeuristicReason({
    proxy_wallet: card.address,
    tier: 'alpha',
    volume_total: card.volumeTotal,
    trade_count: card.fillCount,
    realized_pnl: card.realizedPnl,
    predictions_count: card.predictionsCount,
  });
  if (heuristic) {
    failures.push(`${label}: heuristic — ${heuristic}`);
  }

  const derived: PromotionGateDerived = {
    volume_total: card.volumeTotal,
    trade_count: card.fillCount,
    realized_pnl: card.realizedPnl,
  };
  const gate = await validateWalletPromotionGate(card.address, derived);
  if (!gate.ok) {
    failures.push(`${label}: api-gate — ${gate.reason ?? 'failed'}`);
  }
  return failures;
}

async function main(): Promise<void> {
  console.log(`[verify-staging] API ${API_BASE} alpha limit=${TIER_LIMIT}`);
  const cards = await fetchAlphaCards();
  const failures: string[] = [];

  for (const card of cards) {
    const label = card.alias ?? card.address.slice(0, 10);
    console.log(
      `[verify-staging] ${label} pnl=${card.realizedPnl} vol=${card.volumeTotal} ` +
        `fills=${card.fillCount} pred=${card.predictionsCount ?? 'n/a'}`
    );
    failures.push(...(await verifyWallet(label, card)));
  }

  console.log('[verify-staging] golden wallets…');
  const byAddr = new Map(cards.map((c) => [c.address.toLowerCase(), c]));
  for (const g of GOLDEN) {
    const card = byAddr.get(g.address.toLowerCase());
    if (card) {
      failures.push(...(await verifyWallet(g.label, card)));
    } else {
      console.log(`[verify-staging] ${g.label} not in alpha top ${TIER_LIMIT} — check /tier/whale or run 06_promotion_gate on server`);
    }
  }

  if (failures.length > 0) {
    console.error('[verify-staging] FAILED');
    for (const f of failures) console.error(` - ${f}`);
    process.exit(2);
  }
  console.log('[verify-staging] PASS — staging cards within promotion-gate tolerance');
}

main().catch((err) => {
  console.error('[verify-staging] error:', err);
  process.exit(1);
});
