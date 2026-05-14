const API = '/api/discovery/v3';

const state = {
  tier: 'alpha',
  retryTimer: null,
  lastWallets: [],
  authed: false,
};

const statusEl = document.getElementById('status');
const listEl   = document.getElementById('wallet-list');

// ─── Auth bar ─────────────────────────────────────────────────────────────────

const authBarEl = document.getElementById('auth-bar-mount');

function renderAuthBar() {
  if (state.authed) {
    authBarEl.innerHTML = `
      <div class="auth-bar">
        <span class="auth-status">Signed in</span>
        <a class="auth-link" href="/auth/logout">Log out</a>
      </div>`;
  } else {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    authBarEl.innerHTML = `
      <div class="auth-bar">
        <span class="auth-status">Viewing as guest</span>
        <a class="auth-link primary" href="/auth/login?returnTo=${returnTo}">Sign in</a>
      </div>`;
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

// ─── Tier guide toggle ─────────────────────────────────────────────────────────

const guideToggleBtn = document.getElementById('guideToggle');
const guidePanel     = document.getElementById('tierGuide');

guideToggleBtn.addEventListener('click', () => {
  const open = !guidePanel.hidden;
  guidePanel.hidden = open;
  guideToggleBtn.setAttribute('aria-expanded', String(!open));
  guideToggleBtn.textContent = open ? 'What do these mean?' : 'Hide guide';
});

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(1) + 'K';
  return '$' + String(Math.round(n));
}

function fmtCount(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtAge(ts) {
  if (!ts) return '—';
  const ageSec = Math.floor(Date.now() / 1000) - Number(ts);
  if (ageSec < 3600)  return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

function fmtScore(n) {
  if (n == null) return '—';
  return Math.round(n).toString();
}

// ─── Ditto state chip ─────────────────────────────────────────────────────────

function getDittoHtml(stateStr) {
  let cls = 'chip ditto-state';
  let label = stateStr.replace(/_/g, ' ');
  if (stateStr === 'HOT_STREAK')           cls += ' hot';
  else if (stateStr === 'COOLDOWN_PAUSED') cls += ' cooldown';
  else if (stateStr === 'SLOWING_REVERTING') cls += ' slowing';
  else if (stateStr === 'CONSISTENT_PERFORMER') cls += ' consistent';
  else if (stateStr === 'NEW_UNRANKED')    cls += ' unranked';
  return `<span class="${cls}">${label}</span>`;
}

// ─── Wallet card ──────────────────────────────────────────────────────────────

function walletCard(w, tier) {
  const tierScore = w.tierScore ?? w.compositeScore ?? null;
  const scorePct  = tierScore != null ? Math.min(100, Math.max(0, tierScore)) : 0;

  const card = document.createElement('div');
  card.className = `wallet-card tier-${tier}`;

  // Pillar row (show only non-null values)
  const pillars = [
    w.momentumScore    != null ? `<span>Heat <strong>${fmtScore(w.momentumScore)}</strong></span>`    : '',
    w.consistencyScore != null ? `<span>Risk DNA <strong>${fmtScore(w.consistencyScore)}</strong></span>` : '',
    w.brierScore       != null ? `<span>Brier <strong>${fmtScore(w.brierScore)}</strong></span>`      : '',
    w.avgClv1h         != null ? `<span>CLV <strong>${(w.avgClv1h * 100).toFixed(1)}%</strong></span>` : '',
    w.nicheScore       != null ? `<span>Niche <strong>${fmtScore(w.nicheScore)}</strong></span>`      : '',
  ].filter(Boolean).join('');

  card.innerHTML = `
    <div class="rank">#${w.tierRank}</div>

    <div class="wallet-info">
      <div class="wallet-head">
        <span class="alias">${w.alias}</span>
        <span class="address">${w.address}</span>
      </div>

      <div class="score-strip">
        <span class="score-main">${fmtScore(tierScore)}</span>
        <div class="score-bar-wrap">
          <div class="score-bar-fill" style="width:${scorePct}%"></div>
        </div>
        ${w.compositeScore != null ? `<span style="font-size:0.75rem;color:var(--muted)">Composite ${fmtScore(w.compositeScore)}</span>` : ''}
      </div>

      <div class="metrics">
        <span>Vol <strong>${fmtNum(w.volumeTotal)}</strong></span>
        <span>Trades <strong>${fmtCount(w.tradeCount)}</strong></span>
        <span>Markets <strong>${fmtCount(w.distinctMarkets)}</strong></span>
        <span>PnL <strong>${fmtNum(w.realizedPnl)}</strong></span>
        <span>Last active <strong>${fmtAge(w.lastActiveTs)}</strong></span>
      </div>

      ${pillars ? `<div class="metrics metrics-secondary">${pillars}</div>` : ''}

      <div class="chips">
        ${w.dittoState ? getDittoHtml(w.dittoState) : ''}
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

// ─── Safe fetch ───────────────────────────────────────────────────────────────

async function safeFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...options });
  } catch (e) {
    return { ok: false, kind: 'network', message: `Network error: ${e.message}` };
  }

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
      } catch (_) { /* ignore */ }
    } else {
      try { await res.text(); } catch (_) { /* ignore */ }
    }
    if (!retryAfterSec || retryAfterSec < 1) retryAfterSec = 15;
    return { ok: false, kind: 'rate_limited', retryAfterSec, message };
  }

  if (!res.ok) {
    let bodyText = '';
    try { bodyText = isJson ? JSON.stringify(await res.json()) : await res.text(); } catch (_) { /* ignore */ }
    return { ok: false, kind: 'http_error', status: res.status,
      message: `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}` };
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

// ─── Render ───────────────────────────────────────────────────────────────────

function renderWallets(wallets, tier) {
  listEl.innerHTML = '';
  for (const w of wallets) listEl.appendChild(walletCard(w, tier));
}

// ─── Retry scheduling ─────────────────────────────────────────────────────────

function scheduleRetry(tier, delaySec) {
  if (state.retryTimer) clearTimeout(state.retryTimer);
  let remaining = delaySec;
  const tick = () => {
    if (remaining <= 0) { loadTier(tier); return; }
    statusEl.innerHTML = `<span class="warn">Rate-limited, retrying in ${remaining}s...</span>`;
    remaining -= 1;
    state.retryTimer = setTimeout(tick, 1000);
  };
  tick();
}

// ─── Load tier ────────────────────────────────────────────────────────────────

async function loadTier(tier) {
  if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
  if (state.lastWallets.length === 0) listEl.innerHTML = '';
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
    renderWallets(data.data, tier);
    statusEl.textContent = `${tier}: ${data.count} wallets`;
    return;
  }

  if (result.kind === 'rate_limited') { scheduleRetry(tier, result.retryAfterSec); return; }

  if (result.kind === 'http_error' && result.status === 404) {
    statusEl.innerHTML = '<span class="error">Discovery v3 is not enabled on this server.</span>';
    return;
  }

  statusEl.innerHTML = `<span class="error">${result.message || 'Fetch failed'}</span>`;
}

// ─── Tier nav ─────────────────────────────────────────────────────────────────

document.querySelectorAll('.tier-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tier-btn').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    state.tier = btn.dataset.tier;
    state.lastWallets = [];
    loadTier(state.tier);
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

renderAuthBar();
refreshAuthStatus().finally(() => loadTier(state.tier));
