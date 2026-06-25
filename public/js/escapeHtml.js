/**
 * Escape text for safe HTML interpolation.
 */
const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * Allow only https avatar URLs; returns empty string for unsafe values.
 */
const sanitizeHttpsUrl = (value) => {
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

window.escapeHtml = escapeHtml;
window.sanitizeHttpsUrl = sanitizeHttpsUrl;
