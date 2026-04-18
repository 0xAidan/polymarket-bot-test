const getErrorTextSnippet = (text) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.slice(0, 160);
};

const buildApiErrorMessage = ({ status, data, text }) => {
  if (data && typeof data.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }

  const snippet = getErrorTextSnippet(text);
  if (status === 429 || /too many requests|rate limit/i.test(snippet)) {
    return 'Request rate limited. Please wait a moment and try again.';
  }

  if (snippet) {
    return snippet;
  }

  return `HTTP ${status}`;
};

const readApiResponse = async (response) => {
  const rawBody = await response.text();
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  let data = null;

  if (rawBody && contentType.includes('application/json')) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = null;
    }
  }

  const ok = response.ok && (!data || data.success !== false);
  if (ok) {
    return {
      ok: true,
      status: response.status,
      data,
      error: null,
    };
  }

  return {
    ok: false,
    status: response.status,
    data,
    error: buildApiErrorMessage({
      status: response.status,
      data,
      text: rawBody,
    }),
  };
};

globalThis.ApiCore = {
  ...(globalThis.ApiCore || {}),
  readApiResponse,
};
