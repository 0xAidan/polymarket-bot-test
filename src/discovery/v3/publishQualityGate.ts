/**
 * Pre-publish quality gate — prevents corrupted harvest stats from reaching
 * the SQLite read model / Discovery UI. Complements offline dedup scripts;
 * does not replace them.
 */
import {
  validateWalletPromotionGate,
  type PromotionGateDerived,
} from './dataApiValidator.js';

export interface PublishScoreCandidate {
  proxy_wallet: string;
  tier: string;
  volume_total: number;
  trade_count: number;
  realized_pnl: number;
  predictions_count?: number | null;
  /** When true, PnL/volume already replaced with Polymarket reference at publish. */
  reference_display?: boolean;
}

export interface PublishFilterResult {
  kept: PublishScoreCandidate[];
  excluded: Array<{ wallet: string; tier: string; reason: string }>;
}

/** Fast sync checks — no network. Catches obvious duplicate-harvest corruption. */
export function corruptionHeuristicReason(candidate: PublishScoreCandidate): string | null {
  const { volume_total: vol, trade_count: fills, realized_pnl: pnl } = candidate;
  const predictions = candidate.predictions_count;

  if (!Number.isFinite(vol) || !Number.isFinite(pnl) || !Number.isFinite(fills)) {
    return 'non-finite display stat';
  }

  if (Math.abs(pnl) >= 1_000_000 || vol >= 5_000_000) {
    return `absurd magnitude pnl=${pnl.toFixed(0)} vol=${vol.toFixed(0)}`;
  }

  if (predictions != null && predictions > 0 && fills > predictions * 20) {
    return `fillCount ${fills} >> predictions ${predictions} (likely duplicate rows)`;
  }

  if (predictions != null && predictions > 0 && vol > 0) {
    const volPerPrediction = vol / predictions;
    if (volPerPrediction > 50_000) {
      return `volume/predictions ${volPerPrediction.toFixed(0)} too high`;
    }
  }

  if (Math.abs(pnl) > 500_000 && Math.abs(pnl) > vol * 3) {
    return `PnL ${pnl.toFixed(0)} >> volume ${vol.toFixed(0)}`;
  }

  return null;
}

const DISPLAY_TIERS = new Set(['alpha', 'whale', 'specialist']);

/**
 * Filter tier scores before SQLite publish. Wallets in alpha/whale/specialist
 * must pass heuristics and (optionally) async Data API promotion gate.
 */
export async function filterScoresForPublish(
  scores: PublishScoreCandidate[],
  opts: {
    runApiGate?: boolean;
    apiGateConcurrency?: number;
    apiGateMaxPerTier?: number;
  } = {}
): Promise<PublishFilterResult> {
  const runApiGate = opts.runApiGate ?? process.env.SKIP_PUBLISH_API_GATE !== '1';
  const concurrency = opts.apiGateConcurrency ?? Number(process.env.PUBLISH_GATE_CONCURRENCY ?? 6);
  const maxPerTier = opts.apiGateMaxPerTier ?? Number(process.env.PUBLISH_GATE_MAX_PER_TIER ?? 80);

  const excluded: PublishFilterResult['excluded'] = [];
  const afterHeuristic: PublishScoreCandidate[] = [];

  for (const s of scores) {
    if (s.reference_display) {
      afterHeuristic.push(s);
      continue;
    }
    const reason = corruptionHeuristicReason(s);
    if (reason) {
      excluded.push({ wallet: s.proxy_wallet, tier: s.tier, reason: `heuristic: ${reason}` });
      continue;
    }
    afterHeuristic.push(s);
  }

  if (!runApiGate) {
    return { kept: afterHeuristic, excluded };
  }

  const tierRank = new Map<string, number>();
  const apiCandidates = afterHeuristic.filter((s) => {
    if (!DISPLAY_TIERS.has(s.tier)) return false;
    const n = tierRank.get(s.tier) ?? 0;
    if (n >= maxPerTier) return false;
    tierRank.set(s.tier, n + 1);
    return true;
  });
  const apiSet = new Set(apiCandidates.map((s) => s.proxy_wallet));

  const failedApi = new Set<string>();
  for (let i = 0; i < apiCandidates.length; i += concurrency) {
    const batch = apiCandidates.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (s) => {
        const derived: PromotionGateDerived = {
          volume_total: s.volume_total,
          trade_count: s.trade_count,
          realized_pnl: s.realized_pnl,
        };
        const gate = await validateWalletPromotionGate(s.proxy_wallet, derived);
        return { wallet: s.proxy_wallet, tier: s.tier, gate };
      })
    );
    for (const { wallet, tier, gate } of results) {
      if (!gate.ok) {
        failedApi.add(wallet);
        excluded.push({
          wallet,
          tier,
          reason: `api-gate: ${gate.reason ?? 'promotion gate failed'}`,
        });
      }
    }
  }

  const kept = afterHeuristic.filter((s) => {
    if (!apiSet.has(s.proxy_wallet)) return true;
    return !failedApi.has(s.proxy_wallet);
  });

  return { kept, excluded };
}
