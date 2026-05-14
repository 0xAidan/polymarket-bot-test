const API = '/api/discovery/v3';

const state = {
  tier: 'alpha',
  retryTimer: null,
  lastWallets: [],
  authed: false,
};

const statusEl = document.getElementById('status');
const listEl   = document.getElementById('wallet-list');

// ── Auth bar ─────────────────────────────────────────────────────────────────

const authBarMount = document.getElementById('auth-bar-mount');

function renderAuthBar() {
  if (state.authed) {
    authBarMount.innerHTML = `
      <div class="auth-bar">
        <span class="auth-status">Signed in</span>
        <a class="auth-link" href="/auth/logout">Sign out</a>
      </div>`;
  } else {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    authBarMount.innerHTML = `
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
  } catch {
    state.authed = false;
  }
  renderAuthBar();
}

// ── Mobile guide toggle ───────────────────────────────────────────────────────

const mobileToggle = document.getElementById('guideMobileToggle');
const guideEl      = document.querySelector('.tier-guide');

mobileToggle?.addEventListener('click', () => {
  const open = guideEl.classList.toggle('open');
  mobileToggle.setAttribute('aria-expanded', String(open));
  mobileToggle.textContent = open ? 'Hide guide' : 'Tier guide';
});

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt$(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1_000)     return sign + '$' + (abs / 1_000).toFixed(1) + 'K';
  return sign + '$' + Math.round(abs);
}

function fmtN(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtAge(ts) {
  if (!ts) return '—';
  const sec = Math.floor(Date.now() / 1000) - Number(ts);
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function fmtScore(n) {
  return n != null ? Math.round(n).toString() : '—';
}

// ── Ditto chip ────────────────────────────────────────────────────────────────

function dittoChipHtml(s) {
  let cls = 'chip ditto-state';
  let label = s.replace(/_/g, ' ');
  if (s === 'HOT_STREAK')           { cls += ' hot';        label = 'HOT STREAK'; }
  else if (s === 'COOLDOWN_PAUSED') { cls += ' cooldown';   label = 'COOLDOWN'; }
  else if (s === 'SLOWING_REVERTING') { cls += ' slowing';  label = 'SLOWING'; }
  else if (s === 'CONSISTENT_PERFORMER') { cls += ' consistent'; label = 'CONSISTENT'; }
  else if (s === 'NEW_UNRANKED')    { cls += ' unranked';   label = 'NEW'; }
  return `<span class="${cls}">${label}</span>`;
}

// ── Wallet row ────────────────────────────────────────────────────────────────

function walletRow(w, tier) {
  const tierScore = w.tierScore ?? w.compositeScore ?? null;
  const scorePct  = tierScore != null ? Math.min(100, Math.max(0, tierScore)) : 0;
  const pnlClass  = (w.realizedPnl ?? 0) >= 0 ? 'pos' : 'neg';

  // Pillar pills — only render if data exists
  const pillars = [
    w.momentumScore    != null ? `<span class="p"><span>Heat</span> <strong>${fmtScore(w.momentumScore)}</strong></span>` : '',
    w.consistencyScore != null ? `<span class="p"><span>Risk DNA</span> <strong>${fmtScore(w.consistencyScore)}</strong></span>` : '',
    w.brierScore       != null ? `<span class="p"><span>Brier</span> <strong>${fmtScore(w.brierScore)}</strong></span>` : '',
    w.avgClv1h         != null ? `<span class="p"><span>CLV</span> <strong>${(w.avgClv1h * 100).toFixed(1)}%</strong></span>` : '',
    w.nicheScore       != null ? `<span class="p"><span>Niche</span> <strong>${fmtScore(w.nicheScore)}</strong></span>` : '',
  ].filter(Boolean).join('');

  const reasonChips = (w.reasons || [])
    .map((r) => `<span class="chip reason">${r}</span>`)
    .join('');

  const row = document.createElement('div');
  row.className = `wallet-row tier-${tier}`;

  row.innerHTML = `
    <div class="row-rank">${w.tierRank}</div>

    <div class="row-body">
      <div class="row-head">
        <span class="row-alias">${w.alias}</span>
        <span class="row-address">${w.address}</span>
      </div>

      <div class="row-score-line">
        <span class="row-score-num">${fmtScore(tierScore)}</span>
        <div class="row-bar"><div class="row-bar-fill" style="width:${scorePct}%"></div></div>
        ${w.compositeScore != null && w.compositeScore !== tierScore
          ? `<span class="row-composite-label">composite ${fmtScore(w.compositeScore)}</span>`
          : ''}
      </div>

      <div class="row-metrics">
        <div class="m"><span class="m-label">Volume</span><span class="m-val">${fmt$(w.volumeTotal)}</span></div>
        <div class="m"><span class="m-label">Trades</span><span class="m-val">${fmtN(w.tradeCount)}</span></div>
        <div class="m"><span class="m-label">Markets</span><span class="m-val">${fmtN(w.distinctMarkets)}</span></div>
        <div class="m"><span class="m-label">Realized PnL</span><span class="m-val ${pnlClass}">${fmt$(w.realizedPnl)}</span></div>
        <div class="m"><span class="m-label">Last active</span><span class="m-val">${fmtAge(w.lastActiveTs)}</span></div>
      </div>

      ${pillars ? `<div class="row-pillars">${pillars}</div>` : ''}

      <div class="row-chips">
        ${w.dittoState ? dittoChipHtml(w.dittoState) : ''}
        <span class="chip eligible">eligible</span>
        ${reasonChips}
      </div>
    </div>

    <div class="row-cta">
      <button class="cta-copy" data-address="${w.address}">Copy Trade</button>
    </div>
  `;

  const btn = row.querySelector('.cta-copy');
  if (!state.authed) {
    btn.textContent = 'Sign in to Copy';
    btn.classList.add('needs-auth');
  } else {
    btn.classList.add('primary');
  }

  btn.addEventListener('click', async () => {
    if (!state.authed) {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/auth/login?returnTo=${returnTo}`;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Tracking…';
    try {
      const result = await safeFetch(`${API}/track`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: w.address }),
      });
      if (result.ok) {
        const j = result.data;
        if (j.success) {
          btn.textContent = 'Tracking';
          statusEl.textContent = `Now tracking ${w.alias}`;
        } else {
          btn.disabled = false;
          btn.textContent = 'Copy Trade';
          statusEl.innerHTML = `<span class="error">${j.error || 'Error'}</span>`;
        }
      } else if (result.kind === 'auth_required') {
        const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `${result.loginUrl}?returnTo=${returnTo}`;
      } else {
        btn.disabled = false;
        btn.textContent = 'Copy Trade';
        statusEl.innerHTML = `<span class="error">${result.message || 'Error tracking wallet'}</span>`;
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Copy Trade';
      statusEl.innerHTML = `<span class="error">${e.message}</span>`;
    }
  });

  return row;
}

// ── Safe fetch ────────────────────────────────────────────────────────────────

async function safeFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...options });
  } catch (e) {
    return { ok: false, kind: 'network', message: `Network error: ${e.message}` };
  }

  if (res.status === 401) {
    let loginUrl = '/auth/login';
    try { const b = await res.json(); if (b?.loginUrl) loginUrl = b.loginUrl; } catch { /* swallow */ }
    state.authed = false; renderAuthBar();
    return { ok: false, kind: 'auth_required', loginUrl };
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');

  if (res.status === 429) {
    let sec = Number(res.headers.get('Retry-After')) || 0;
    let msg = 'Rate-limited';
    if (isJson) { try { const b = await res.json(); sec = Number(b.retryAfterSec) || sec; msg = b.message || msg; } catch { /* swallow */ } }
    if (sec < 1) sec = 15;
    return { ok: false, kind: 'rate_limited', retryAfterSec: sec, message: msg };
  }

  if (!res.ok) {
    let txt = '';
    try { txt = isJson ? JSON.stringify(await res.json()) : await res.text(); } catch { /* swallow */ }
    return { ok: false, kind: 'http_error', status: res.status, message: `HTTP ${res.status}${txt ? ': ' + txt.slice(0, 200) : ''}` };
  }

  if (!isJson) {
    const text = await res.text().catch(() => '');
    return { ok: false, kind: 'bad_content_type', message: `Unexpected response: ${text.slice(0, 120)}` };
  }

  try { return { ok: true, data: await res.json() }; }
  catch (e) { return { ok: false, kind: 'parse_error', message: `Invalid JSON: ${e.message}` }; }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderWallets(wallets, tier) {
  listEl.innerHTML = '';
  for (const w of wallets) listEl.appendChild(walletRow(w, tier));
}

// ── Retry ─────────────────────────────────────────────────────────────────────

function scheduleRetry(tier, delaySec) {
  if (state.retryTimer) clearTimeout(state.retryTimer);
  let rem = delaySec;
  const tick = () => {
    if (rem <= 0) { loadTier(tier); return; }
    statusEl.innerHTML = `<span class="warn">Rate-limited — retrying in ${rem}s</span>`;
    rem--;
    state.retryTimer = setTimeout(tick, 1000);
  };
  tick();
}

// ── Load tier ─────────────────────────────────────────────────────────────────

async function loadTier(tier) {
  if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
  if (state.lastWallets.length === 0) listEl.innerHTML = '';
  statusEl.textContent = `Loading ${tier}…`;

  const result = await safeFetch(`${API}/tier/${tier}?limit=50`);

  if (result.ok) {
    const { success, error, data, count } = result.data;
    if (!success) { statusEl.innerHTML = `<span class="error">${error || 'Unknown error'}</span>`; return; }
    if (!Array.isArray(data) || data.length === 0) {
      state.lastWallets = [];
      listEl.innerHTML = `<div class="empty-state"><strong>No wallets scored yet</strong><p>Run the backfill pipeline to populate this tier.</p></div>`;
      statusEl.textContent = `${tier} · 0 wallets`;
      return;
    }
    state.lastWallets = data;
    renderWallets(data, tier);
    statusEl.textContent = `${tier} · ${count} wallets`;
    return;
  }

  if (result.kind === 'rate_limited') { scheduleRetry(tier, result.retryAfterSec); return; }
  if (result.kind === 'http_error' && result.status === 404) {
    statusEl.innerHTML = '<span class="error">Discovery v3 is not enabled on this server.</span>';
    return;
  }
  statusEl.innerHTML = `<span class="error">${result.message || 'Fetch failed'}</span>`;
}

// ── Tier nav ──────────────────────────────────────────────────────────────────

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

// ── Boot ──────────────────────────────────────────────────────────────────────
renderAuthBar();
refreshAuthStatus().finally(() => loadTier(state.tier));
