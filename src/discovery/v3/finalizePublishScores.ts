/**
 * Shared publish pipeline: profile enrichment, quality gate, reference display
 * fallback. Used by backfill 05 and the hourly refresh worker so SQLite cards
 * stay aligned with Polymarket profile stats.
 */
import {
  fetchPublishProfileMetaLite,
  fetchReferenceDisplayStats,
  type PublishProfileMeta,
} from './publishEnrichment.js';
import { isDerivedPnlOutlier } from './dataApiValidator.js';
import { filterScoresForPublish, type PublishScoreCandidate } from './publishQualityGate.js';
import type { V3WalletScore } from './types.js';

export interface FinalizePublishOptions {
  log?: (msg: string) => void;
  skipPredictions?: boolean;
}

export interface FinalizePublishResult {
  scores: V3WalletScore[];
  profileMeta: Map<string, PublishProfileMeta>;
  excluded: Array<{ wallet: string; tier: string; reason: string }>;
}

/**
 * Apply the same display-accuracy steps as scripts/backfill/05_score_and_publish.ts
 * before writing discovery_wallet_scores_v3.
 */
export async function finalizeScoresForPublish(
  scores: V3WalletScore[],
  options: FinalizePublishOptions = {}
): Promise<FinalizePublishResult> {
  const log = options.log ?? (() => {});
  const skipPredictions =
    options.skipPredictions ?? process.env.SKIP_PUBLISH_PREDICTIONS === '1';

  const profileMeta = new Map<string, PublishProfileMeta>();
  if (!skipPredictions) {
    const enrichConcurrency = Number(process.env.PUBLISH_ENRICH_CONCURRENCY ?? 8);
    log(`[publish] enriching ${scores.length} wallets (predictions + profile name)…`);
    for (let i = 0; i < scores.length; i += enrichConcurrency) {
      const batch = scores.slice(i, i + enrichConcurrency);
      const metas = await Promise.all(batch.map((s) => fetchPublishProfileMetaLite(s.proxy_wallet)));
      for (let j = 0; j < batch.length; j++) {
        profileMeta.set(batch[j].proxy_wallet, metas[j]);
      }
    }
  }

  const pipelineSnapshot = new Map(
    scores.map((s) => [s.proxy_wallet, { volume_total: s.volume_total, realized_pnl: s.realized_pnl }])
  );

  const gateInput: PublishScoreCandidate[] = scores.map((s) => {
    const meta = profileMeta.get(s.proxy_wallet);
    return {
      proxy_wallet: s.proxy_wallet,
      tier: s.tier,
      volume_total: s.volume_total,
      trade_count: s.trade_count,
      realized_pnl: s.realized_pnl,
      predictions_count: meta?.predictionsCount ?? null,
    };
  });

  const { kept: keptKeys, excluded: gateExcluded } = await filterScoresForPublish(gateInput);

  const keptSetFirst = new Set(keptKeys.map((k) => k.proxy_wallet));
  const failedForFallback = scores.filter((s) => !keptSetFirst.has(s.proxy_wallet));
  if (failedForFallback.length > 0) {
    log(`[publish] reference fallback for ${failedForFallback.length} wallet(s)…`);
  }

  const fallbackConcurrency = Number(process.env.PUBLISH_FALLBACK_CONCURRENCY ?? 6);
  for (let i = 0; i < failedForFallback.length; i += fallbackConcurrency) {
    const batch = failedForFallback.slice(i, i + fallbackConcurrency);
    await Promise.all(
      batch.map(async (s) => {
        const meta = profileMeta.get(s.proxy_wallet) ?? {
          predictionsCount: null,
          profileName: null,
          profilePnlUsd: null,
          profileVolumeUsd: null,
        };
        if (!profileMeta.has(s.proxy_wallet)) {
          profileMeta.set(s.proxy_wallet, meta);
        }
        const pipe = pipelineSnapshot.get(s.proxy_wallet);
        if (!pipe) return;

        const ref = await fetchReferenceDisplayStats(s.proxy_wallet);
        meta.profilePnlUsd = ref.profilePnlUsd;
        meta.profileVolumeUsd = ref.profileVolumeUsd;

        let changed = false;
        if (meta.profileVolumeUsd != null && Number.isFinite(meta.profileVolumeUsd)) {
          s.volume_total = meta.profileVolumeUsd;
          changed = true;
        }
        if (meta.profilePnlUsd != null && Number.isFinite(meta.profilePnlUsd)) {
          s.realized_pnl = meta.profilePnlUsd;
          changed = true;
        }
        if (!changed) return;

        const retry = await filterScoresForPublish([
          {
            proxy_wallet: s.proxy_wallet,
            tier: s.tier,
            volume_total: s.volume_total,
            trade_count: s.trade_count,
            realized_pnl: s.realized_pnl,
            predictions_count: meta.predictionsCount ?? null,
            reference_display: true,
          },
        ]);
        if (retry.kept.length > 0) {
          keptKeys.push(retry.kept[0]);
          gateExcluded = gateExcluded.filter((ex) => ex.wallet !== s.proxy_wallet);
        } else {
          s.volume_total = pipe.volume_total;
          s.realized_pnl = pipe.realized_pnl;
        }
      })
    );
  }

  const keptSet = new Set(keptKeys.map((k) => k.proxy_wallet));
  let publishScores = scores.filter((s) => keptSet.has(s.proxy_wallet));

  const rerankByTier = new Map<string, V3WalletScore[]>();
  for (const s of publishScores) {
    const list = rerankByTier.get(s.tier) ?? [];
    list.push(s);
    rerankByTier.set(s.tier, list);
  }
  publishScores = [];
  for (const [, list] of rerankByTier) {
    list.sort((a, b) => a.tier_rank - b.tier_rank);
    list.forEach((s, i) => {
      s.tier_rank = i + 1;
      publishScores.push(s);
    });
  }

  if (gateExcluded.length > 0) {
    log(`[publish] excluded ${gateExcluded.length} wallet(s) after quality gate`);
  }
  log(`[publish] keeping ${publishScores.length}/${scores.length} wallets`);

  const displayTiers = ['alpha', 'whale', 'specialist'] as const;
  const patchTop = Number(process.env.PUBLISH_DISPLAY_PATCH_TOP ?? 50);
  const patchConcurrency = Number(process.env.PUBLISH_DISPLAY_PATCH_CONCURRENCY ?? 6);
  const toPatch: V3WalletScore[] = [];
  for (const tier of displayTiers) {
    const top = publishScores
      .filter((s) => s.tier === tier)
      .sort((a, b) => a.tier_rank - b.tier_rank)
      .slice(0, patchTop);
    toPatch.push(...top);
  }
  if (toPatch.length > 0) {
    log(`[publish] reference display patch for ${toPatch.length} tier card(s)…`);
    for (let i = 0; i < toPatch.length; i += patchConcurrency) {
      const batch = toPatch.slice(i, i + patchConcurrency);
      await Promise.all(
        batch.map(async (s) => {
          let ref = await fetchReferenceDisplayStats(s.proxy_wallet);
          for (let attempt = 0; attempt < 3 && ref.profilePnlUsd == null; attempt++) {
            await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
            ref = await fetchReferenceDisplayStats(s.proxy_wallet);
          }
          if (ref.profilePnlUsd != null && Number.isFinite(ref.profilePnlUsd)) {
            s.realized_pnl = ref.profilePnlUsd;
          }
          if (ref.profileVolumeUsd != null && Number.isFinite(ref.profileVolumeUsd)) {
            s.volume_total = ref.profileVolumeUsd;
          }
        })
      );
    }
  }

  const requireRef = process.env.DISCOVERY_V3_REQUIRE_REFERENCE_PNL !== '0';
  if (requireRef) {
    const before = publishScores.length;
    const verified: V3WalletScore[] = [];
    for (const s of publishScores) {
      if (!displayTiers.includes(s.tier as (typeof displayTiers)[number])) {
        verified.push(s);
        continue;
      }
      const ref = await fetchReferenceDisplayStats(s.proxy_wallet);
      if (ref.profilePnlUsd == null || !Number.isFinite(ref.profilePnlUsd)) {
        gateExcluded.push({
          wallet: s.proxy_wallet,
          tier: s.tier,
          reason: 'display-tier: no Polymarket reference PnL (rate limit or API error)',
        });
        continue;
      }
      if (isDerivedPnlOutlier(s.realized_pnl, ref.profilePnlUsd)) {
        s.realized_pnl = ref.profilePnlUsd;
      }
      verified.push(s);
    }
    publishScores = verified;
    if (before !== publishScores.length) {
      log(`[publish] removed ${before - publishScores.length} display-tier row(s) without reference PnL`);
    }
  }

  return { scores: publishScores, profileMeta, excluded: gateExcluded };
}
