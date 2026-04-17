import { getDatabase } from '../database.js';
import { classifyDiscoveryMarket } from './marketClassifier.js';
import { DiscoveredTrade, DiscoveryMarketPoolEntry, DiscoverySignal } from './types.js';

type AlertFilters = {
  severity?: string;
  signalType?: string;
  walletAddress?: string;
  onlyUndismissed?: boolean;
};

export const upsertMarketUniverseV2Entries = (entries: DiscoveryMarketPoolEntry[]): void => {
  if (entries.length === 0) return;

  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO discovery_market_universe_v2 (
      condition_id, title, slug, category, primary_discovery_eligible, high_information_priority,
      liquidity, volume_24h, open_interest, token_ids_json, outcomes_json, source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(condition_id) DO UPDATE SET
      title = excluded.title,
      slug = excluded.slug,
      category = excluded.category,
      primary_discovery_eligible = excluded.primary_discovery_eligible,
      high_information_priority = excluded.high_information_priority,
      liquidity = excluded.liquidity,
      volume_24h = excluded.volume_24h,
      open_interest = excluded.open_interest,
      token_ids_json = excluded.token_ids_json,
      outcomes_json = excluded.outcomes_json,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction(() => {
    for (const entry of entries) {
      const classification = classifyDiscoveryMarket({
        title: entry.title,
        slug: entry.slug,
      });
      stmt.run(
        entry.conditionId,
        entry.title ?? null,
        entry.slug ?? null,
        classification.category,
        classification.primaryDiscoveryEligible ? 1 : 0,
        classification.highInformationPriority ? 1 : 0,
        entry.liquidity ?? null,
        entry.volume24h ?? null,
        entry.openInterest ?? null,
        JSON.stringify(entry.tokenIds ?? []),
        JSON.stringify(entry.outcomes ?? []),
        'category-seeder',
        entry.updatedAt,
      );
    }
  });

  tx();
};

export const insertTradeFactsV2 = (trades: DiscoveredTrade[]): number => {
  if (trades.length === 0) return 0;

  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO discovery_trade_facts_v2 (
      tx_hash, event_key, maker, taker, condition_id, asset_id, market_title, market_slug,
      side, price, shares, notional_usd, fee_usd, source, detected_at, category,
      primary_discovery_eligible, high_information_priority
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const trade of trades) {
      const classification = classifyDiscoveryMarket({
        title: trade.marketTitle,
        slug: trade.marketSlug,
      });
      const result = stmt.run(
        trade.txHash,
        trade.eventKey ?? null,
        trade.maker,
        trade.taker,
        trade.conditionId ?? null,
        trade.assetId,
        trade.marketTitle ?? null,
        trade.marketSlug ?? null,
        trade.side ?? null,
        trade.price ?? null,
        trade.size,
        trade.notionalUsd ?? (trade.price !== undefined ? trade.price * trade.size : null),
        trade.fee,
        trade.source,
        trade.detectedAt,
        classification.category,
        classification.primaryDiscoveryEligible ? 1 : 0,
        classification.highInformationPriority ? 1 : 0,
      );
      if (result.changes > 0) inserted += 1;
    }
  });

  tx();
  return inserted;
};

export const upsertWalletFeatureSnapshotV2 = (input: {
  address: string;
  runTimestamp: number;
  focusCategory?: string;
  strategyClass?: string;
  confidenceBucket?: string;
  featureSnapshot: {
    marketSelectionScore: number;
    categoryFocusScore: number;
    consistencyScore: number;
    convictionScore: number;
    trustScore: number;
    integrityPenalty: number;
    confidenceEvidenceCount: number;
    cautionFlags: string[];
  };
  metrics: {
    averageSpreadBps: number;
    averageTopOfBookUsd: number;
    latestTradePrice?: number;
    currentPrice?: number;
  };
}): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_wallet_features_v2 (
      address, snapshot_at, focus_category, strategy_class, confidence_bucket,
      market_selection_score, category_focus_score, consistency_score, conviction_score,
      trust_score, integrity_penalty, confidence_evidence_count, average_spread_bps,
      average_top_of_book_usd, latest_trade_price, current_price, caution_flags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      snapshot_at = excluded.snapshot_at,
      focus_category = excluded.focus_category,
      strategy_class = excluded.strategy_class,
      confidence_bucket = excluded.confidence_bucket,
      market_selection_score = excluded.market_selection_score,
      category_focus_score = excluded.category_focus_score,
      consistency_score = excluded.consistency_score,
      conviction_score = excluded.conviction_score,
      trust_score = excluded.trust_score,
      integrity_penalty = excluded.integrity_penalty,
      confidence_evidence_count = excluded.confidence_evidence_count,
      average_spread_bps = excluded.average_spread_bps,
      average_top_of_book_usd = excluded.average_top_of_book_usd,
      latest_trade_price = excluded.latest_trade_price,
      current_price = excluded.current_price,
      caution_flags_json = excluded.caution_flags_json
  `).run(
    input.address,
    input.runTimestamp,
    input.focusCategory ?? null,
    input.strategyClass ?? null,
    input.confidenceBucket ?? null,
    input.featureSnapshot.marketSelectionScore,
    input.featureSnapshot.categoryFocusScore,
    input.featureSnapshot.consistencyScore,
    input.featureSnapshot.convictionScore,
    input.featureSnapshot.trustScore,
    input.featureSnapshot.integrityPenalty,
    input.featureSnapshot.confidenceEvidenceCount,
    input.metrics.averageSpreadBps,
    input.metrics.averageTopOfBookUsd,
    input.metrics.latestTradePrice ?? null,
    input.metrics.currentPrice ?? null,
    JSON.stringify(input.featureSnapshot.cautionFlags ?? []),
  );
};

export const insertDiscoveryAlertV2 = (signal: Omit<DiscoverySignal, 'id' | 'dismissed'>): void => {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO discovery_alerts_v2 (
      signal_type, severity, wallet_address, condition_id, market_title,
      title, description, metadata_json, source, status, detected_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    signal.signalType,
    signal.severity,
    signal.address,
    signal.conditionId ?? null,
    signal.marketTitle ?? null,
    signal.title,
    signal.description,
    signal.metadata ? JSON.stringify(signal.metadata) : null,
    'signal-engine',
    signal.detectedAt,
    Math.floor(Date.now() / 1000),
  );
};

export const getDiscoveryAlertsV2 = (
  limit: number,
  offset: number,
  filters: AlertFilters = {},
): Array<Record<string, unknown>> => {
  const db = getDatabase();
  let where = 'WHERE 1=1';
  const params: Array<string | number> = [];

  if (filters.onlyUndismissed !== false) {
    where += " AND status != 'dismissed'";
  }
  if (filters.severity) {
    where += ' AND severity = ?';
    params.push(filters.severity);
  }
  if (filters.signalType) {
    where += ' AND signal_type = ?';
    params.push(filters.signalType);
  }
  if (filters.walletAddress) {
    where += ' AND wallet_address = ?';
    params.push(filters.walletAddress.toLowerCase());
  }

  params.push(limit, offset);
  const rows = db.prepare(`
    SELECT *
    FROM discovery_alerts_v2
    ${where}
    ORDER BY detected_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    signalType: String(row.signal_type),
    severity: String(row.severity),
    address: String(row.wallet_address),
    conditionId: row.condition_id ? String(row.condition_id) : undefined,
    marketTitle: row.market_title ? String(row.market_title) : undefined,
    title: String(row.title),
    description: String(row.description),
    metadata: parseJsonObject(row.metadata_json),
    status: String(row.status),
    source: String(row.source),
    detectedAt: Number(row.detected_at),
    createdAt: Number(row.created_at),
  }));
};

const parseJsonObject = (value: unknown): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
};
