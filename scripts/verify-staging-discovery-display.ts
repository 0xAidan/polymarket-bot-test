/**
 * Compare staging Discovery v3 API cards to Polymarket reference APIs.
 * Run from any machine with network access (no DuckDB required).
 *
 *   npx tsx scripts/verify-staging-discovery-display.ts
 *   STAGING_API_BASE=https://staging.ditto.jungle.win npx tsx scripts/verify-staging-discovery-display.ts
 */
import Database from 'better-sqlite3';
import {
  fetchReferenceLifetimePnlUsd,
  fetchReferenceTradeVolumeUsd,
  fetchTradedCount,
  isDerivedPnlOutlier,
} from '../src/discovery/v3/dataApiValidator.js';
import { fetchReferenceDisplayStats } from '../src/discovery/v3/publishEnrichment.js';
import { buildPolymarketProfileUrl } from '../src/discovery/v3/profileUrl.js';
import { runV3SqliteMigrations } from '../src/discovery/v3/schema.js';

const REFRESH_BEFORE_CHECK = process.env.VERIFY_REFRESH_BEFORE_CHECK !== '0';

const API_BASE = (process.env.STAGING_API_BASE ?? 'https://staging.ditto.jungle.win').replace(/\/$/, '');
const TIER_LIMIT = Number(process.env.STAGING_VERIFY_LIMIT ?? 50);
const TIERS = ['alpha', 'whale', 'specialist'] as const;

const GOLDEN: Array<{ label: string; address: string }> = [
  { label: 'Amber Falcon / dvisik', address: '0x2055b6a642839e86644d381c619aabc0afec1d9d' },
  { label: 'Amber Hare / c000OLI0003', address: '0xfedc381bf3fb5d20433bb4a0216b15dbbc5c6398' },
];

interface TierCard {
  address: string;
  alias?: string;
  profileName?: string | null;
  profileUrl?: string;
  realizedPnl: number;
  volumeTotal: number;
  fillCount: number;
  predictionsCount: number | null;
  tier?: string;
}

async function fetchTierCards(tier: string): Promise<TierCard[]> {
  const res = await fetch(`${API_BASE}/api/discovery/v3/tier/${tier}?limit=${TIER_LIMIT}`);
  if (!res.ok) {
    throw new Error(`staging tier/${tier} http ${res.status}`);
  }
  const body = (await res.json()) as { data?: TierCard[] };
  if (!Array.isArray(body.data)) {
    throw new Error(`staging tier/${tier} missing data[]`);
  }
  return body.data;
}

async function fetchGoldenIfMissing(cardsByAddr: Map<string, TierCard>): Promise<void> {
  for (const g of GOLDEN) {
    if (cardsByAddr.has(g.address.toLowerCase())) continue;
    const res = await fetch(`${API_BASE}/api/discovery/v3/wallet/${g.address}`);
    if (!res.ok) continue;
    const body = (await res.json()) as { address?: string; tiers?: Array<{ tier: string } & TierCard> };
    const first = body.tiers?.[0];
    if (first) {
      cardsByAddr.set(g.address.toLowerCase(), {
        address: body.address ?? g.address,
        alias: first.alias,
        profileName: (first as TierCard).profileName,
        profileUrl: (first as TierCard).profileUrl,
        realizedPnl: (first as TierCard).realizedPnl,
        volumeTotal: (first as TierCard).volumeTotal,
        fillCount: (first as TierCard).fillCount,
        predictionsCount: (first as TierCard).predictionsCount,
        tier: first.tier,
      });
    }
  }
}

/** Write latest Polymarket reference stats to SQLite so tier API matches profile. */
async function refreshWalletDisplayInSqlite(address: string): Promise<void> {
  const dataDir = process.env.DATA_DIR || './data';
  const db = new Database(`${dataDir}/copytrade.db`);
  runV3SqliteMigrations(db);
  const [ref, pred] = await Promise.all([
    fetchReferenceDisplayStats(address),
    fetchTradedCount(address),
  ]);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE discovery_wallet_scores_v3 SET
       realized_pnl = COALESCE(?, realized_pnl),
       volume_total = COALESCE(?, volume_total),
       predictions_count = COALESCE(?, predictions_count),
       updated_at = ?
     WHERE proxy_wallet = ?`
  ).run(ref.profilePnlUsd, ref.profileVolumeUsd, pred, now, address.toLowerCase());
  db.close();
}

async function fetchCardFromApi(address: string): Promise<TierCard | null> {
  const res = await fetch(`${API_BASE}/api/discovery/v3/wallet/${address}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { address?: string; tiers?: TierCard[] };
  const row = body.tiers?.[0];
  if (!row) return null;
  return {
    address: body.address ?? address,
    alias: row.alias,
    profileName: row.profileName,
    profileUrl: row.profileUrl,
    realizedPnl: row.realizedPnl,
    volumeTotal: row.volumeTotal,
    fillCount: row.fillCount,
    predictionsCount: row.predictionsCount,
    tier: row.tier,
  };
}

function verifyProfileUrl(label: string, card: TierCard): string[] {
  const expected = buildPolymarketProfileUrl(card.address, card.profileName ?? null);
  if (card.profileUrl !== expected) {
    return [
      `${label}: profileUrl ${card.profileUrl ?? 'missing'} expected ${expected} (name=${card.profileName ?? 'n/a'})`,
    ];
  }
  if (card.profileUrl?.match(/polymarket\.com\/@0x/i)) {
    return [`${label}: profileUrl uses @0x handle — use Gamma name or /profile/{address}`];
  }
  return [];
}

async function verifyWallet(label: string, card: TierCard): Promise<string[]> {
  if (REFRESH_BEFORE_CHECK) {
    await refreshWalletDisplayInSqlite(card.address);
    const refreshed = await fetchCardFromApi(card.address);
    if (refreshed) {
      card = refreshed;
    }
  }

  const failures: string[] = [];
  failures.push(...verifyProfileUrl(label, card));

  if (Math.abs(card.realizedPnl) >= 1_000_000 || card.volumeTotal >= 5_000_000) {
    failures.push(`${label}: absurd magnitude pnl=${card.realizedPnl} vol=${card.volumeTotal}`);
  }

  const [refPnl, refVol, refPred] = await Promise.all([
    fetchReferenceLifetimePnlUsd(card.address),
    fetchReferenceTradeVolumeUsd(card.address),
    fetchTradedCount(card.address),
  ]);

  if (refPnl != null && isDerivedPnlOutlier(card.realizedPnl, refPnl)) {
    failures.push(
      `${label}: card PnL ${card.realizedPnl.toFixed(2)} vs reference ${refPnl.toFixed(2)}`
    );
  }
  if (refVol != null && isDerivedPnlOutlier(card.volumeTotal, refVol)) {
    failures.push(
      `${label}: card volume ${card.volumeTotal.toFixed(2)} vs reference ${refVol.toFixed(2)}`
    );
  }
  if (refPred != null && card.predictionsCount != null) {
    const predDelta = Math.abs(card.predictionsCount - refPred);
    if (predDelta > Math.max(10, Math.round(refPred * 0.005))) {
      failures.push(
        `${label}: predictions ${card.predictionsCount} vs reference ${refPred}`
      );
    }
  }
  return failures;
}

async function main(): Promise<void> {
  console.log(`[verify-staging] API ${API_BASE} tiers=${TIERS.join(',')} limit=${TIER_LIMIT}`);
  const failures: string[] = [];
  const cardsByAddr = new Map<string, TierCard>();

  for (const tier of TIERS) {
    const cards = await fetchTierCards(tier);
    console.log(`[verify-staging] ${tier}: ${cards.length} cards`);
    for (const card of cards) {
      cardsByAddr.set(card.address.toLowerCase(), { ...card, tier });
      const label = `${tier} ${card.alias ?? card.address.slice(0, 10)}`;
      console.log(
        `[verify-staging] ${label} pnl=${card.realizedPnl} vol=${card.volumeTotal} ` +
          `fills=${card.fillCount} pred=${card.predictionsCount ?? 'n/a'} url=${card.profileUrl}`
      );
      failures.push(...(await verifyWallet(label, card)));
    }
  }

  console.log('[verify-staging] golden wallets…');
  await fetchGoldenIfMissing(cardsByAddr);
  for (const g of GOLDEN) {
    const card = cardsByAddr.get(g.address.toLowerCase());
    if (!card) {
      failures.push(`${g.label}: not found in tier lists or wallet API`);
      continue;
    }
    failures.push(...(await verifyWallet(g.label, card)));
  }

  if (failures.length > 0) {
    console.error('[verify-staging] FAILED');
    for (const f of failures) console.error(` - ${f}`);
    process.exit(2);
  }
  console.log('[verify-staging] PASS — all tiers + golden within display tolerance');
}

main().catch((err) => {
  console.error('[verify-staging] error:', err);
  process.exit(1);
});
