export function parseNullableBooleanInput(v: unknown): boolean | null | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const normalized = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  }
  return Boolean(v);
}
