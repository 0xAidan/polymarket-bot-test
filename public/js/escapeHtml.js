/**
 * Escape text for safe HTML interpolation.
 * Assigned directly to window to avoid top-level const declarations
 * that pollute the global lexical scope across classic script tags.
 */
window.escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * Allow only https avatar URLs; returns empty string for unsafe values.
 */
window.sanitizeHttpsUrl = (value) => {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith('https://')) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.href;
  } catch {
    return '';
  }
};
