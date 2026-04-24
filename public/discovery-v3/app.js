const API = '/api/discovery/v3';

const state = {
  tier: 'alpha',
  retryTimer: null,
  lastWallets: [],
  authed: false, // filled in by refreshAuthStatus()
};

const statusEl = document.getElementById('status');
const listEl = document.getElementById('wallet-list');

// Build the auth bar once. We keep the reference so we can re-render when
// auth state changes (e.g. after a 401 on a mutation).
const authBarEl = document.createElement('div');
authBarEl.className = 'auth-bar';
document.querySelector('.v3-header')?.appendChild(authBarEl);

function renderAuthBar() {
  if (state.authed) {
    authBarEl.innerHTML = `
      <span class="auth-status">Signed in</span>
      <a class="auth-link" href="/auth/logout">Log out</a>
    `;
  } else {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    authBarEl.innerHTML = `
      <span class="auth-status">Viewing as guest — sign in to copy trade</span>
      <a class="auth-link primary" href="/auth/login?returnTo=${returnTo}">Sign in</a>
    `;
  }
}

async function refreshAuthStatus() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    state.authed = res.ok;
  } catch (_e) {
    state.authed = false;
  }
  renderAuthBar();
}

function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtPct(n) {
  if (n == null) return '—';
  return (n * 100).toFixed(1) + '%';
}

function fmtAge(ts) {
  if (!ts) return '—';
  const ageSec = Math.floor(Date.now() / 1000) - Number(ts);
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

function walletCard(w) {
  const card = document.createElement('div');
  card.className = 'wallet-card';
  card.innerHTML = `
    <div class="rank">#${w.tierRank}</div>
    <div>
      <div class="alias">${w.alias}</div>
      <div class="address">${w.address}</div>
      <div class="metrics">
        <span>Vol <strong>$${fmtNum(w.volumeTotal)}</strong></span>
        <span>Trades <strong>${fmtNum(w.tradeCount)}</strong></span>
        <span>Markets <strong>${fmtNum(w.distinctMarkets)}</strong></span>
        <span>Hit rate <strong>${fmtPct(w.hitRate)}</strong></span>
        <span>PnL <strong>$${fmtNum(w.realizedPnl)}</strong></span>
        <span class="last-active">Last active ${fmtAge(w.lastActiveTs)}</span>
      </div>
      <div class="chips">
        <span class="chip eligible">eligible</span>
        ${(w.reasons || []).map((r) => `<span class="chip">${r}</span>`).join('')}
      </div>
    </div>
    <button class="cta-copy" data-address="${w.address}">Copy Trade</button>
  `;
  const copyBtn = card.querySelector('.cta-copy');
  if (!state.authed) {
    copyBtn.textContent = 'Sign in to Copy';
    copyBtn.classList.add('needs-auth');
  }
  copyBtn.addEventListener('click', async () => {
    if (!state.authed) {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/auth/login?returnTo=${returnTo}`;
      return;
    }
    try {
      const result = await safeFetch(`${API}/track`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: w.address }),
      });
      if (result.ok) {
        const j = result.data;
        statusEl.textContent = j.success ? `Tracking ${w.alias}` : `Error: ${j.error}`;
      } else if (result.kind === 'auth_required') {
        const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `${result.loginUrl}?returnTo=${returnTo}`;
      } else {
        statusEl.textContent = result.message || 'Error tracking wallet';
      }
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
    }
  });
  return card;
}

/**
 * Fetch wrapper that:
 * - Always inspects status + content-type BEFORE trying JSON parse
 * - Returns a discriminated result instead of throwing on HTTP errors
 * - Surfaces 429 as a structured result so callers can show a retry banner
 */
async function safeFetch(url, options = {}) {
  let res;
  try {
    // Always include cookies so the Auth0 session is seen by the server when
    // the user is signed in. Read endpoints don't need it, but mutations do.
    res = await fetch(url, { credentials: 'same-origin', ...options });
  } catch (e) {
    return { ok: false, kind: 'network', message: `Network error: ${e.message}` };
  }

  // 401 → auth needed. For reads this should never happen (public). For
  // mutations, surface a structured result so the caller can prompt login
  // instead of the raw server message.
  if (res.status === 401) {
    let loginUrl = '/auth/login';
    try {
      const body = await res.json();
      if (body && typeof body.loginUrl === 'string') loginUrl = body.loginUrl;
    } catch (_) { /* swallow */ }
    state.authed = false;
    renderAuthBar();
    return { ok: false, kind: 'auth_required', loginUrl, message: 'Sign in to continue' };
  }

  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');

  if (res.status === 429) {
    let retryAfterSec = Number(res.headers.get('Retry-After')) || 0;
    let message = 'Rate-limited by server';
    if (isJson) {
      try {
        const body = await res.json();
        retryAfterSec = Number(body.retryAfterSec) || retryAfterSec;
        message = body.message || body.error || message;
      } catch (_) {
        // non-fatal — use defaults
      }
    } else {
      try { await res.text(); } catch (_) { /* swallow */ }
    }
    if (!retryAfterSec || retryAfterSec < 1) retryAfterSec = 15;
    return { ok: false, kind: 'rate_limited', retryAfterSec, message };
  }

  if (!res.ok) {
    let bodyText = '';
    try { bodyText = isJson ? JSON.stringify(await res.json()) : await res.text(); } catch (_) { /* swallow */ }
    return {
      ok: false,
      kind: 'http_error',
      status: res.status,
      message: `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`
    };
  }

  if (!isJson) {
    const text = await res.text().catch(() => '');
    return { ok: false, kind: 'bad_content_type', message: `Unexpected response: ${text.slice(0, 120)}` };
  }

  try {
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, kind: 'parse_error', message: `Invalid JSON: ${e.message}` };
  }
}

function renderWallets(wallets) {
  listEl.innerHTML = '';
  for (const w of wallets) listEl.appendChild(walletCard(w));
}

function scheduleRetry(tier, delaySec) {
  if (state.retryTimer) clearTimeout(state.retryTimer);
  let remaining = delaySec;
  const tick = () => {
    if (remaining <= 0) {
      loadTier(tier);
      return;
    }
    // Preserve previously-loaded wallets so the UI never goes blank.
    statusEl.innerHTML = `<span class="warn">Rate-limited, retrying in ${remaining}s...</span>`;
    remaining -= 1;
    state.retryTimer = setTimeout(tick, 1000);
  };
  tick();
}

async function loadTier(tier) {
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  // Only clear the list on first load — if we already have wallets, keep them
  // visible while we re-fetch, so transient errors don't produce a blank UI.
  if (state.lastWallets.length === 0) {
    listEl.innerHTML = '';
  }
  statusEl.textContent = `Loading ${tier}...`;

  const result = await safeFetch(`${API}/tier/${tier}?limit=50`);

  if (result.ok) {
    const data = result.data;
    if (!data.success) {
      statusEl.innerHTML = `<span class="error">${data.error || 'unknown error'}</span>`;
      return;
    }
    if (!Array.isArray(data.data) || data.data.length === 0) {
      state.lastWallets = [];
      listEl.innerHTML = '<div class="empty">No wallets scored yet. Run the backfill pipeline.</div>';
      statusEl.textContent = `${tier}: 0 wallets`;
      return;
    }
    state.lastWallets = data.data;
    renderWallets(data.data);
    statusEl.textContent = `${tier}: ${data.count} wallets`;
    return;
  }

  if (result.kind === 'rate_limited') {
    scheduleRetry(tier, result.retryAfterSec);
    return;
  }

  if (result.kind === 'http_error' && result.status === 404) {
    statusEl.innerHTML = '<span class="error">Discovery v3 is not enabled on this server.</span>';
    return;
  }

  // Any other error: keep prior wallets visible if we have them.
  statusEl.innerHTML = `<span class="error">${result.message || 'Fetch failed'}</span>`;
}

document.querySelectorAll('.tier-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tier-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tier = btn.dataset.tier;
    state.lastWallets = [];
    loadTier(state.tier);
  });
});

// Render the auth bar immediately (as guest), then refresh from the server.
renderAuthBar();
refreshAuthStatus().finally(() => loadTier(state.tier));
