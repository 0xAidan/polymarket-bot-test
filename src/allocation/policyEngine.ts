import { getDatabase } from '../database.js';
import { DiscoveryConfidenceBucket, DiscoveryStrategyClass } from '../discovery/types.js';

export type AllocationPolicyState = 'NEW' | 'CONSISTENT' | 'HOT_STREAK' | 'COOLDOWN' | 'PAUSED';
export type AllocationPolicyAction = 'monitor' | 'hold' | 'upsize' | 'derisk' | 'pause' | 'resume';

export type AllocationPolicyConfig = {
  consistentEnterScore: number;
  consistentExitScore: number;
  hotEnterScore: number;
  hotExitScore: number;
  resumeScoreThreshold: number;
  pausedTrustThreshold: number;
  pausedCopyabilityThreshold: number;
  resumeTrustThreshold: number;
  maxHotWeight: number;
  consistentWeight: number;
  cooldownWeight: number;
};

export type AllocationPolicyInput = {
  address: string;
  discoveryScore: number;
  trustScore: number;
  copyabilityScore: number;
  confidenceBucket: DiscoveryConfidenceBucket;
  strategyClass: DiscoveryStrategyClass;
  cautionFlags: string[];
  updatedAt: number;
};

type StoredPolicyState = {
  address: string;
  state: AllocationPolicyState;
  targetWeight: number;
  action: AllocationPolicyAction;
  hysteresisScore: number;
  stableCycles: number;
  lastTransitionAt?: number;
  pauseReason?: string;
  riskFlags: string[];
  metrics: Record<string, unknown>;
  updatedAt: number;
};

type AllocationTransition = {
  address: string;
  previousState: AllocationPolicyState;
  nextState: AllocationPolicyState;
  action: AllocationPolicyAction;
  reason: string;
  targetWeight: number;
  riskFlags: string[];
  metrics: Record<string, unknown>;
  createdAt: number;
};

const DEFAULT_CONFIG: AllocationPolicyConfig = {
  consistentEnterScore: 62,
  consistentExitScore: 52,
  hotEnterScore: 78,
  hotExitScore: 68,
  resumeScoreThreshold: 56,
  pausedTrustThreshold: 35,
  pausedCopyabilityThreshold: 35,
  resumeTrustThreshold: 45,
  maxHotWeight: 1.75,
  consistentWeight: 1,
  cooldownWeight: 0.5,
};

const parseConfigValue = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const loadConfigFromDb = (): Partial<AllocationPolicyConfig> => {
  const db = getDatabase();
  const rows = db.prepare('SELECT key, value FROM allocation_policy_config').all() as Array<{
    key: string;
    value: string;
  }>;
  const partial: Partial<AllocationPolicyConfig> = {};
  for (const row of rows) {
    const key = row.key as keyof AllocationPolicyConfig;
    if (!(key in DEFAULT_CONFIG)) continue;
    partial[key] = parseConfigValue(row.value, DEFAULT_CONFIG[key]);
  }
  return partial;
};

export const getAllocationPolicyConfig = (): AllocationPolicyConfig => {
  return {
    ...DEFAULT_CONFIG,
    ...loadConfigFromDb(),
  };
};

export const updateAllocationPolicyConfig = (updates: Partial<AllocationPolicyConfig>): AllocationPolicyConfig => {
  const db = getDatabase();
  const upsert = db.prepare(`
    INSERT INTO allocation_policy_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      if (!(key in DEFAULT_CONFIG)) continue;
      upsert.run(key, String(value));
    }
  });
  tx();
  return getAllocationPolicyConfig();
};

const confidenceScore = (bucket: DiscoveryConfidenceBucket): number => {
  if (bucket === 'high') return 8;
  if (bucket === 'medium') return 4;
  return 0;
};

const buildRiskFlags = (input: AllocationPolicyInput): string[] => {
  const flags: string[] = [];
  if (input.strategyClass === 'suspicious') flags.push('suspicious_strategy');
  if (input.cautionFlags.length >= 2) flags.push('multiple_caution_flags');
  if (input.copyabilityScore < 45) flags.push('low_copyability');
  if (input.trustScore < 45) flags.push('low_trust');
  return flags;
};

const getDefaultState = (address: string): StoredPolicyState => ({
  address,
  state: 'NEW',
  targetWeight: 0,
  action: 'monitor',
  hysteresisScore: 0,
  stableCycles: 0,
  riskFlags: [],
  metrics: {},
  updatedAt: 0,
});

const weightForState = (
  state: AllocationPolicyState,
  config: AllocationPolicyConfig,
  compositeScore: number,
): number => {
  if (state === 'NEW') return 0;
  if (state === 'PAUSED') return 0;
  if (state === 'COOLDOWN') return config.cooldownWeight;
  if (state === 'CONSISTENT') return config.consistentWeight;
  const hotBase = config.consistentWeight + Math.max(0, (compositeScore - config.hotEnterScore) / 100);
  return Math.min(config.maxHotWeight, hotBase);
};

const evaluateOne = (
  previous: StoredPolicyState,
  input: AllocationPolicyInput,
  config: AllocationPolicyConfig,
  nowSeconds: number,
): { next: StoredPolicyState; transition?: AllocationTransition } => {
  const riskFlags = buildRiskFlags(input);
  const compositeScore =
    input.discoveryScore * 0.55 +
    input.trustScore * 0.25 +
    input.copyabilityScore * 0.2 +
    confidenceScore(input.confidenceBucket);
  const hysteresisScore = previous.hysteresisScore > 0
    ? previous.hysteresisScore * 0.6 + compositeScore * 0.4
    : compositeScore;
  const shouldPause = input.strategyClass === 'suspicious' ||
    input.trustScore < config.pausedTrustThreshold ||
    input.copyabilityScore < config.pausedCopyabilityThreshold;

  let nextState: AllocationPolicyState = previous.state;
  let reason = 'No state transition.';

  if (shouldPause) {
    nextState = 'PAUSED';
    reason = 'Paused because trust/copyability/suspicion risk exceeded safety bounds.';
  } else if (previous.state === 'NEW') {
    if (hysteresisScore >= config.consistentEnterScore && input.confidenceBucket !== 'low') {
      nextState = 'CONSISTENT';
      reason = 'Promoted to CONSISTENT after crossing quality and confidence thresholds.';
    }
  } else if (previous.state === 'CONSISTENT') {
    if (hysteresisScore >= config.hotEnterScore && input.confidenceBucket === 'high') {
      nextState = 'HOT_STREAK';
      reason = 'Promoted to HOT_STREAK after sustained high score with high confidence.';
    } else if (hysteresisScore < config.consistentExitScore) {
      nextState = 'COOLDOWN';
      reason = 'Moved to COOLDOWN after score fell below consistent hysteresis floor.';
    }
  } else if (previous.state === 'HOT_STREAK') {
    if (hysteresisScore < config.hotExitScore) {
      nextState = 'CONSISTENT';
      reason = 'De-escalated from HOT_STREAK as momentum cooled below hysteresis floor.';
    }
  } else if (previous.state === 'COOLDOWN') {
    if (hysteresisScore >= config.consistentEnterScore) {
      nextState = 'CONSISTENT';
      reason = 'Recovered to CONSISTENT after score re-crossed consistency threshold.';
    }
  } else if (previous.state === 'PAUSED') {
    if (
      hysteresisScore >= config.resumeScoreThreshold &&
      input.trustScore >= config.resumeTrustThreshold &&
      input.copyabilityScore >= config.pausedCopyabilityThreshold
    ) {
      nextState = 'COOLDOWN';
      reason = 'Resumed from PAUSED into COOLDOWN with guarded exposure.';
    }
  }

  const transitioned = nextState !== previous.state;
  const stableCycles = transitioned ? 0 : previous.stableCycles + 1;
  const targetWeight = weightForState(nextState, config, compositeScore);
  const action: AllocationPolicyAction = transitioned
    ? nextState === 'PAUSED'
      ? 'pause'
      : nextState === 'HOT_STREAK'
        ? 'upsize'
        : nextState === 'COOLDOWN'
          ? 'derisk'
          : nextState === 'CONSISTENT'
            ? previous.state === 'PAUSED' ? 'resume' : 'hold'
            : 'monitor'
    : nextState === 'HOT_STREAK'
      ? 'upsize'
      : nextState === 'COOLDOWN'
        ? 'derisk'
        : nextState === 'PAUSED'
          ? 'pause'
          : nextState === 'NEW'
            ? 'monitor'
            : 'hold';

  const next: StoredPolicyState = {
    address: previous.address,
    state: nextState,
    targetWeight,
    action,
    hysteresisScore,
    stableCycles,
    lastTransitionAt: transitioned ? nowSeconds : previous.lastTransitionAt,
    pauseReason: nextState === 'PAUSED' ? reason : undefined,
    riskFlags,
    metrics: {
      discoveryScore: input.discoveryScore,
      trustScore: input.trustScore,
      copyabilityScore: input.copyabilityScore,
      confidenceBucket: input.confidenceBucket,
      strategyClass: input.strategyClass,
      compositeScore,
      updatedAt: input.updatedAt,
    },
    updatedAt: nowSeconds,
  };

  if (!transitioned) {
    return { next };
  }

  return {
    next,
    transition: {
      address: previous.address,
      previousState: previous.state,
      nextState,
      action,
      reason,
      targetWeight,
      riskFlags,
      metrics: next.metrics,
      createdAt: nowSeconds,
    },
  };
};

const loadExistingStates = (addresses: string[]): Map<string, StoredPolicyState> => {
  if (addresses.length === 0) return new Map();
  const db = getDatabase();
  const placeholders = addresses.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM allocation_policy_states
    WHERE tracked_wallet_address IN (${placeholders})
  `).all(...addresses) as Array<Record<string, unknown>>;
  const map = new Map<string, StoredPolicyState>();
  for (const row of rows) {
    const address = String(row.tracked_wallet_address);
    map.set(address, {
      address,
      state: String(row.state) as AllocationPolicyState,
      targetWeight: Number(row.target_weight ?? 0),
      action: String(row.action) as AllocationPolicyAction,
      hysteresisScore: Number(row.hysteresis_score ?? 0),
      stableCycles: Number(row.stable_cycles ?? 0),
      lastTransitionAt: row.last_transition_at ? Number(row.last_transition_at) : undefined,
      pauseReason: row.pause_reason ? String(row.pause_reason) : undefined,
      riskFlags: parseJsonArray(row.risk_flags_json),
      metrics: parseJsonObject(row.metrics_json),
      updatedAt: Number(row.updated_at ?? 0),
    });
  }
  return map;
};

const persistStateBatch = (states: StoredPolicyState[]): void => {
  if (states.length === 0) return;
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO allocation_policy_states (
      tracked_wallet_address, state, target_weight, action, hysteresis_score,
      stable_cycles, last_transition_at, pause_reason, risk_flags_json, metrics_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tracked_wallet_address) DO UPDATE SET
      state = excluded.state,
      target_weight = excluded.target_weight,
      action = excluded.action,
      hysteresis_score = excluded.hysteresis_score,
      stable_cycles = excluded.stable_cycles,
      last_transition_at = excluded.last_transition_at,
      pause_reason = excluded.pause_reason,
      risk_flags_json = excluded.risk_flags_json,
      metrics_json = excluded.metrics_json,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction(() => {
    for (const state of states) {
      stmt.run(
        state.address,
        state.state,
        state.targetWeight,
        state.action,
        state.hysteresisScore,
        state.stableCycles,
        state.lastTransitionAt ?? null,
        state.pauseReason ?? null,
        JSON.stringify(state.riskFlags),
        JSON.stringify(state.metrics),
        state.updatedAt,
      );
    }
  });
  tx();
};

const persistTransitions = (transitions: AllocationTransition[]): void => {
  if (transitions.length === 0) return;
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO allocation_policy_transitions (
      tracked_wallet_address, previous_state, next_state, action, reason,
      target_weight, risk_flags_json, metrics_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const transition of transitions) {
      stmt.run(
        transition.address,
        transition.previousState,
        transition.nextState,
        transition.action,
        transition.reason,
        transition.targetWeight,
        JSON.stringify(transition.riskFlags),
        JSON.stringify(transition.metrics),
        transition.createdAt,
      );
    }
  });
  tx();
};

export const evaluateAndPersistAllocationPolicies = (
  inputs: AllocationPolicyInput[],
  nowSeconds = Math.floor(Date.now() / 1000),
): { evaluatedCount: number; transitionedCount: number } => {
  if (inputs.length === 0) return { evaluatedCount: 0, transitionedCount: 0 };
  const config = getAllocationPolicyConfig();
  const addresses = inputs.map((input) => input.address.toLowerCase());
  const existing = loadExistingStates(addresses);

  const nextStates: StoredPolicyState[] = [];
  const transitions: AllocationTransition[] = [];

  for (const input of inputs) {
    const normalizedAddress = input.address.toLowerCase();
    const previous = existing.get(normalizedAddress) ?? getDefaultState(normalizedAddress);
    const { next, transition } = evaluateOne(previous, { ...input, address: normalizedAddress }, config, nowSeconds);
    nextStates.push(next);
    if (transition) transitions.push(transition);
  }

  persistStateBatch(nextStates);
  persistTransitions(transitions);

  return {
    evaluatedCount: nextStates.length,
    transitionedCount: transitions.length,
  };
};

export const getAllocationPolicyState = (address: string): StoredPolicyState | null => {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT *
    FROM allocation_policy_states
    WHERE tracked_wallet_address = ?
  `).get(address.toLowerCase()) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    address: String(row.tracked_wallet_address),
    state: String(row.state) as AllocationPolicyState,
    targetWeight: Number(row.target_weight ?? 0),
    action: String(row.action) as AllocationPolicyAction,
    hysteresisScore: Number(row.hysteresis_score ?? 0),
    stableCycles: Number(row.stable_cycles ?? 0),
    lastTransitionAt: row.last_transition_at ? Number(row.last_transition_at) : undefined,
    pauseReason: row.pause_reason ? String(row.pause_reason) : undefined,
    riskFlags: parseJsonArray(row.risk_flags_json),
    metrics: parseJsonObject(row.metrics_json),
    updatedAt: Number(row.updated_at ?? 0),
  };
};

export const getAllocationTargetWeight = (address: string): number => {
  const state = getAllocationPolicyState(address);
  if (!state) return 1;
  if (state.state === 'NEW') return 0;
  return Math.max(0, state.targetWeight);
};

export const getAllocationPolicyStates = (limit = 100, offset = 0): StoredPolicyState[] => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT *
    FROM allocation_policy_states
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    address: String(row.tracked_wallet_address),
    state: String(row.state) as AllocationPolicyState,
    targetWeight: Number(row.target_weight ?? 0),
    action: String(row.action) as AllocationPolicyAction,
    hysteresisScore: Number(row.hysteresis_score ?? 0),
    stableCycles: Number(row.stable_cycles ?? 0),
    lastTransitionAt: row.last_transition_at ? Number(row.last_transition_at) : undefined,
    pauseReason: row.pause_reason ? String(row.pause_reason) : undefined,
    riskFlags: parseJsonArray(row.risk_flags_json),
    metrics: parseJsonObject(row.metrics_json),
    updatedAt: Number(row.updated_at ?? 0),
  }));
};

export const getAllocationPolicyTransitions = (
  limit = 100,
  offset = 0,
  address?: string,
): AllocationTransition[] => {
  const db = getDatabase();
  const params: Array<number | string> = [];
  let where = '';
  if (address) {
    where = 'WHERE tracked_wallet_address = ?';
    params.push(address.toLowerCase());
  }
  params.push(limit, offset);
  const rows = db.prepare(`
    SELECT *
    FROM allocation_policy_transitions
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    address: String(row.tracked_wallet_address),
    previousState: String(row.previous_state) as AllocationPolicyState,
    nextState: String(row.next_state) as AllocationPolicyState,
    action: String(row.action) as AllocationPolicyAction,
    reason: String(row.reason),
    targetWeight: Number(row.target_weight ?? 0),
    riskFlags: parseJsonArray(row.risk_flags_json),
    metrics: parseJsonObject(row.metrics_json),
    createdAt: Number(row.created_at ?? 0),
  }));
};

const parseJsonArray = (value: unknown): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
};

const parseJsonObject = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
};
