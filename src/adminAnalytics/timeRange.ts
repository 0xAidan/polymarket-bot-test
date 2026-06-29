import type { ResolvedTimeRange, TimeRangePreset } from './adminAnalyticsTypes.js';

const PRESETS: TimeRangePreset[] = ['24h', '7d', '30d', 'all'];

const parseTimestamp = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

export const resolveTimeRange = (query: {
  range?: unknown;
  from?: unknown;
  to?: unknown;
}): ResolvedTimeRange => {
  const now = Date.now();
  const fromMsRaw = parseTimestamp(query.from);
  const toMsRaw = parseTimestamp(query.to);

  if (fromMsRaw !== null && toMsRaw !== null && fromMsRaw <= toMsRaw) {
    return {
      preset: 'custom',
      fromMs: fromMsRaw,
      toMs: toMsRaw,
      from: new Date(fromMsRaw).toISOString(),
      to: new Date(toMsRaw).toISOString(),
    };
  }

  const rangeRaw = typeof query.range === 'string' ? query.range : '7d';
  const preset = PRESETS.includes(rangeRaw as TimeRangePreset)
    ? (rangeRaw as TimeRangePreset)
    : '7d';

  if (preset === 'all') {
    return {
      preset: 'all',
      fromMs: 0,
      toMs: now,
      from: new Date(0).toISOString(),
      to: new Date(now).toISOString(),
    };
  }

  const hoursByPreset: Record<Exclude<TimeRangePreset, 'all'>, number> = {
    '24h': 24,
    '7d': 24 * 7,
    '30d': 24 * 30,
  };
  const hours = hoursByPreset[preset];
  const fromMs = now - hours * 60 * 60 * 1000;

  return {
    preset,
    fromMs,
    toMs: now,
    from: new Date(fromMs).toISOString(),
    to: new Date(now).toISOString(),
  };
};

export const tradeInRange = (timestampMs: number, range: ResolvedTimeRange): boolean => {
  if (range.preset === 'all' && range.fromMs === 0) {
    return timestampMs <= range.toMs;
  }
  return timestampMs >= range.fromMs && timestampMs <= range.toMs;
};
