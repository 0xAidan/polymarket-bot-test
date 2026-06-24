/**
 * Sanitize post-login redirect paths. Rejects protocol-relative URLs (//evil.com),
 * absolute URLs, and other unsafe values.
 */
const RETURN_TO_PATTERN = /^\/[a-zA-Z0-9/_\-.?=&%]*$/;

const sanitizeReturnTo = (value, fallback = '/app') => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes(':')) {
    return fallback;
  }

  if (!RETURN_TO_PATTERN.test(trimmed)) {
    return fallback;
  }

  return trimmed;
};

window.sanitizeReturnTo = sanitizeReturnTo;
