const API = '/api/discovery/v3';

const state = {
  tier: 'alpha',
  retryTimer: null,
  lastWallets: [],
  authed: false,
};

const statusEl = document.getElementById('status');
const gridEl   = document.getElementById('wallet-grid');

// ── Auth bar ──────────────────────────────────────────────────────────────────

const authBarMount = document.getElementById('auth-bar-mount');

function renderAuthBar() {
  const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
  authBarMount.innerHTML = state.authed
    ? `<div class="auth-bar">
         <span class="auth-status">Signed in</span>
         <a class="auth-link" href="/auth/logout">Sign out</a>
       </div>`
    : `<div class="auth-bar">
         <span class="auth-status">Viewing as guest</span>
         <a class="auth-link primary" href="/auth/login?returnTo=${returnTo}">Sign in</a>
       </div>`;
}

async function refreshAuthStatus() {
  try {
    state.authed = (await fetch('/api/auth/me', { credentials: 'same-origin' })).ok;
  } catch { state.authed = false; }
  renderAuthBar();
}

// ── Mobile guide toggle ───────────────────────────────────────────────────────

document.getElementById('guideToggle')?.addEventListener('click', (e) => {
  const guide = document.querySelector('.guide');
  const open = guide.classList.toggle('open');
  e.currentTarget.textContent = open ? 'Hide guide' : 'Guide';
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt$(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000)     return sign + '$' + (abs / 1_000).toFixed(1) + 'K';
  return sign + '$' + Math.round(abs);
}

function fmtN(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtAge(ts) {
  if (!ts) return '—';
  const s = Math.floor(Date.now() / 1000) - Number(ts);
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtScore(n) { return n != null ? Math.round(n).toString() : '—'; }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Ditto chip ────────────────────────────────────────────────────────────────

function dittoChip(s) {
  const map = {
    HOT_STREAK:           ['hot',        'HOT STREAK'],
    COOLDOWN_PAUSED:      ['cooldown',   'COOLDOWN'],
    SLOWING_REVERTING:    ['slowing',    'SLOWING'],
    CONSISTENT_PERFORMER: ['consistent', 'CONSISTENT'],
    NEW_UNRANKED:         ['unranked',   'NEW'],
  };
  const [cls, label] = map[s] ?? ['unranked', s.replace(/_/g, ' ')];
  return `<span class="chip ${cls}">${label}</span>`;
}

// ── Score ring SVG ────────────────────────────────────────────────────────────

function scoreRingSvg(score) {
  // Circle r=21 → circumference = 2π×21 ≈ 132
  const circ = 132;
  const pct  = score != null ? Math.min(100, Math.max(0, score)) : 0;
  const offset = circ * (1 - pct / 100);
  return `
    <div class="score-ring-wrap">
      <svg class="score-ring" viewBox="0 0 52 52" aria-hidden="true">
        <circle class="ring-track" cx="26" cy="26" r="21"/>
        <circle class="ring-fill"  cx="26" cy="26" r="21"
                data-offset="${offset}"
                style="stroke-dashoffset:${circ}"/>
      </svg>
      <span class="ring-label">${score != null ? Math.round(score) : '?'}</span>
    </div>`;
}

// Animate rings after insertion
function animateRings(container) {
  // rAF to let the browser paint the initial state first
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.querySelectorAll('.ring-fill[data-offset]').forEach((el) => {
      el.style.strokeDashoffset = el.dataset.offset;
    });
  }));
}

// ── Wallet card ───────────────────────────────────────────────────────────────

function walletCard(w, tier, displayScore) {
  const score   = displayScore ?? w.score ?? w.compositeScore ?? null;
  const pnlCls  = (w.realizedPnl ?? 0) >= 0 ? 'pos' : 'neg';
  const profileUrl = w.profileUrl
    || (w.profileName && !String(w.profileName).startsWith('0x')
      ? `https://polymarket.com/@${w.profileName}`
      : `https://polymarket.com/profile/${w.address}`);
  const profileSub = w.profileName
    ? `<span class="cprofile">@${escapeHtml(w.profileName)}</span>`
    : '';

  const showFills = w.predictionsCount != null && w.fillCount != null;
  const predictionsVal = w.predictionsCount ?? w.tradeCount;
  const predictionsLbl = w.predictionsCount != null ? 'Predictions' : 'Fills';

  const pillars = [
    w.momentumScore    != null && `<div class="cpillar"><span class="cpillar-lbl">Heat</span><span class="cpillar-val">${fmtScore(w.momentumScore)}</span></div>`,
    w.consistencyScore != null && `<div class="cpillar"><span class="cpillar-lbl">Risk DNA</span><span class="cpillar-val">${fmtScore(w.consistencyScore)}</span></div>`,
    w.brierScore       != null && `<div class="cpillar"><span class="cpillar-lbl">Brier</span><span class="cpillar-val">${fmtScore(w.brierScore)}</span></div>`,
    w.avgClv1h         != null && `<div class="cpillar"><span class="cpillar-lbl">CLV</span><span class="cpillar-val">${(w.avgClv1h * 100).toFixed(1)}%</span></div>`,
    w.nicheScore       != null && `<div class="cpillar"><span class="cpillar-lbl">Niche</span><span class="cpillar-val">${fmtScore(w.nicheScore)}</span></div>`,
  ].filter(Boolean).join('');

  const reasonChips = (w.reasons || []).map((r) => `<span class="chip reason">${r}</span>`).join('');

  const card = document.createElement('div');
  card.className = `wcard tier-${tier}`;
  card.innerHTML = `
    <div class="chead">
      ${scoreRingSvg(score)}
      <div class="cident">
        <div class="cident-row1">
          <span class="cname">${w.alias}</span>
          <span class="crank">#${w.tierRank}</span>
        </div>
        <span class="caddr">${w.address}</span>
        ${profileSub}
      </div>
    </div>

    <div class="cstats">
      <div class="cstat">
        <span class="cstat-lbl">Volume</span>
        <span class="cstat-val">${fmt$(w.volumeTotal)}</span>
      </div>
      <div class="cstat">
        <span class="cstat-lbl">${predictionsLbl}</span>
        <span class="cstat-val">${fmtN(predictionsVal)}</span>
      </div>
      ${showFills ? `<div class="cstat">
        <span class="cstat-lbl">Fills</span>
        <span class="cstat-val">${fmtN(w.fillCount)}</span>
      </div>` : ''}
      <div class="cstat">
        <span class="cstat-lbl">Markets</span>
        <span class="cstat-val">${fmtN(w.distinctMarkets)}</span>
      </div>
      <div class="cstat">
        <span class="cstat-lbl">Lifetime PnL</span>
        <span class="cstat-val ${pnlCls}">${fmt$(w.realizedPnl)}</span>
      </div>
    </div>

    ${pillars ? `<div class="cpillars">${pillars}</div>` : ''}

    <div class="cchips">
      ${w.dittoState ? dittoChip(w.dittoState) : ''}
      <span class="chip eligible">eligible</span>
      ${reasonChips}
    </div>

    <div class="ccta">
      <span class="ccta-meta">Last active: ${fmtAge(w.lastActiveTs)}</span>
      <div class="ccta-btns">
        <a class="cta-btn secondary profile-link" href="${profileUrl}" target="_blank" rel="noopener noreferrer" aria-label="View ${w.alias} on Polymarket">View on Polymarket</a>
        <button class="cta-btn" data-address="${w.address}">Copy Trade</button>
      </div>
    </div>
  `;

  const btn = card.querySelector('button.cta-btn[data-address]');
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
    btn.textContent = 'Adding…';
    try {
      const r = await safeFetch(`${API}/track`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: w.address }),
      });
      if (r.ok && r.data.success) {
        btn.textContent = 'Tracking';
        statusEl.textContent = `Now tracking ${w.alias}`;
      } else if (r.kind === 'auth_required') {
        const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `${r.loginUrl}?returnTo=${returnTo}`;
      } else {
        btn.disabled = false;
        btn.textContent = 'Copy Trade';
        statusEl.innerHTML = `<span class="error">${r.data?.error || r.message || 'Error'}</span>`;
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Copy Trade';
      statusEl.innerHTML = `<span class="error">${e.message}</span>`;
    }
  });

  return card;
}

// ── Safe fetch ────────────────────────────────────────────────────────────────

async function safeFetch(url, opts = {}) {
  let res;
  try { res = await fetch(url, { credentials: 'same-origin', ...opts }); }
  catch (e) {
    const msg = e?.name === 'TimeoutError' ? 'Request timed out — try again' : e.message;
    return { ok: false, kind: 'network', message: msg };
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
    if (isJson) { try { const b = await res.json(); sec = Number(b.retryAfterSec) || sec; } catch { /* swallow */ } }
    return { ok: false, kind: 'rate_limited', retryAfterSec: Math.max(sec, 15) };
  }

  if (!res.ok) {
    let txt = '';
    try { txt = isJson ? JSON.stringify(await res.json()) : await res.text(); } catch { /* swallow */ }
    return { ok: false, kind: 'http_error', status: res.status, message: `HTTP ${res.status}${txt ? ': ' + txt.slice(0, 200) : ''}` };
  }

  if (!isJson) return { ok: false, kind: 'bad_content_type', message: 'Unexpected response' };
  try { return { ok: true, data: await res.json() }; }
  catch (e) { return { ok: false, kind: 'parse_error', message: e.message }; }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderWallets(wallets, tier) {
  gridEl.innerHTML = '';

  // Scores within a tier batch are tightly clustered (all top wallets land near
  // the same percentile × dormancy multiplier). Normalize within the visible
  // batch so the ring visually reflects rank rather than absolute score.
  // #1 → 96, last → 20, to keep rings meaningfully filled and distinct.
  const scores = wallets.map((w) => w.score ?? w.compositeScore ?? 0);
  const maxS = Math.max(...scores) || 1;
  const minS = Math.min(...scores);
  const range = maxS - minS || 1;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < wallets.length; i++) {
    const raw = scores[i];
    // Normalize to 20–96 so even the last card shows a meaningful ring arc.
    const normalized = Math.round(20 + ((raw - minS) / range) * 76);
    frag.appendChild(walletCard(wallets[i], tier, normalized));
  }
  gridEl.appendChild(frag);
  animateRings(gridEl);
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
  if (!state.lastWallets.length) gridEl.innerHTML = '';
  statusEl.textContent = `Loading ${tier}…`;

  const result = await safeFetch(`${API}/tier/${tier}?limit=50`, {
    signal: AbortSignal.timeout(45_000),
  });

  if (result.ok) {
    const { success, error, data, count } = result.data;
    if (!success) { statusEl.innerHTML = `<span class="error">${error || 'Unknown error'}</span>`; return; }
    if (!Array.isArray(data) || !data.length) {
      state.lastWallets = [];
      gridEl.innerHTML = `<div class="empty-state"><strong>No wallets scored yet</strong><p>Run the backfill pipeline to populate this tier.</p></div>`;
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
