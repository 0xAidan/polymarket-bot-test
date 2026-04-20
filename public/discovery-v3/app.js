const API = '/api/discovery/v3';

const state = { tier: 'alpha' };

const statusEl = document.getElementById('status');
const listEl = document.getElementById('wallet-list');

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
  card.querySelector('.cta-copy').addEventListener('click', async () => {
    try {
      const res = await fetch(`${API}/track`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: w.address }),
      });
      const j = await res.json();
      statusEl.textContent = j.success ? `Tracking ${w.alias}` : `Error: ${j.error}`;
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
    }
  });
  return card;
}

async function loadTier(tier) {
  listEl.innerHTML = '';
  statusEl.textContent = `Loading ${tier}...`;
  try {
    const res = await fetch(`${API}/tier/${tier}?limit=50`);
    if (res.status === 404) {
      statusEl.innerHTML = '<span class="error">Discovery v3 is not enabled on this server.</span>';
      return;
    }
    const data = await res.json();
    if (!data.success) {
      statusEl.innerHTML = `<span class="error">${data.error || 'unknown error'}</span>`;
      return;
    }
    if (data.data.length === 0) {
      listEl.innerHTML = '<div class="empty">No wallets scored yet. Run the backfill pipeline.</div>';
      statusEl.textContent = `${tier}: 0 wallets`;
      return;
    }
    for (const w of data.data) listEl.appendChild(walletCard(w));
    statusEl.textContent = `${tier}: ${data.count} wallets`;
  } catch (e) {
    statusEl.innerHTML = `<span class="error">Fetch failed: ${e.message}</span>`;
  }
}

document.querySelectorAll('.tier-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tier-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tier = btn.dataset.tier;
    loadTier(state.tier);
  });
});

loadTier(state.tier);
