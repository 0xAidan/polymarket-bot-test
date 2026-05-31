/**
 * Jungle Agents public showcase tab.
 */

let jungleAgentsBooted = false;
let trackedAddressSet = new Set();

const formatUsd = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
};

const agentShortAddress = (address) => {
  if (!address) return '—';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
};

const polymarketProfileUrl = (address) => {
  if (!address) return null;
  return `https://polymarket.com/profile/${address.trim().toLowerCase()}`;
};

const refreshTrackedSet = async () => {
  try {
    const data = await API.getWallets();
    trackedAddressSet = new Set(
      (data.wallets || []).map((w) => String(w.address).toLowerCase()),
    );
  } catch {
    trackedAddressSet = new Set();
  }
};

const loadAgentPerformance = async (agentId) => {
  const statEl = document.querySelector(`[data-agent-stat="${agentId}"]`);
  if (!statEl) return;
  try {
    const perf = await API.getJungleAgentPerformance(agentId);
    statEl.innerHTML = `
      <span class="j-stat"><span class="j-stat-label">Portfolio</span><span class="j-stat-value">${formatUsd(perf.portfolioValueUsd)}</span></span>
      <span class="j-stat"><span class="j-stat-label">Positions</span><span class="j-stat-value">${perf.positionCount ?? '—'}</span></span>
    `;
  } catch {
    statEl.innerHTML = `
      <span class="j-stat"><span class="j-stat-label">Portfolio</span><span class="j-stat-value">—</span></span>
      <span class="j-stat"><span class="j-stat-label">Positions</span><span class="j-stat-value">—</span></span>
    `;
  }
};

const handleFollowAgent = async (agent) => {
  if (agent.addressPending || !agent.polymarketAddress) {
    await win95Dialog.alert('This agent does not have a Polymarket address yet.');
    return;
  }
  const address = agent.polymarketAddress.toLowerCase();
  if (trackedAddressSet.has(address)) {
    await win95Dialog.alert('You are already following this wallet. Open Tracked Wallets to configure and enable copying.');
    switchTab('wallets');
    return;
  }
  try {
    await API.addWallet(address, agent.displayName);
    trackedAddressSet.add(address);
    await win95Dialog.success(`Added ${agent.displayName} to Tracked Wallets (inactive until you enable copying).`);
    if (typeof loadWallets === 'function') await loadWallets(true);
    window.initJungleAgentsTab(true);
  } catch (error) {
    await win95Dialog.error(error.message || 'Could not follow agent');
  }
};

const renderAgentRow = (agent) => {
  const address = agent.polymarketAddress?.toLowerCase() || '';
  const isFollowing = address && trackedAddressSet.has(address);
  const followDisabled = agent.addressPending || isFollowing;
  const followLabel = isFollowing ? 'Following' : 'Follow';
  const profileUrl = polymarketProfileUrl(agent.polymarketAddress);
  const avatar = agent.avatarUrl
    ? `<img src="${agent.avatarUrl}" alt="" class="j-agent-avatar-img" />`
    : `<span class="j-agent-avatar-fallback">${agent.displayName.slice(0, 1)}</span>`;

  return `
    <article class="j-agent-row" data-agent-id="${agent.id}">
      <div class="j-agent-row-identity">
        <div class="j-agent-avatar">${avatar}</div>
        <div>
          <h3 class="j-agent-name font-serif">${agent.displayName}</h3>
          <p class="j-agent-tagline text-muted">${agent.tagline || ''}</p>
          ${agent.modelLabel ? `<span class="j-badge">${agent.modelLabel}</span>` : ''}
        </div>
      </div>
      <div class="j-agent-row-stats" data-agent-stat="${agent.id}">
        <span class="j-stat skeleton">Loading stats…</span>
      </div>
      <div class="j-agent-address-row">
        ${agent.addressPending
    ? '<span class="j-badge j-badge-warn">Address pending</span>'
    : `<code class="j-mono">${agentShortAddress(agent.polymarketAddress)}</code>
           <button type="button" class="j-btn j-btn-ghost j-btn-sm" data-copy-address="${agent.polymarketAddress}" aria-label="Copy address">Copy</button>`}
      </div>
      <footer class="j-agent-row-actions">
        ${profileUrl
    ? `<a class="j-btn j-btn-sm" href="${profileUrl}" target="_blank" rel="noopener noreferrer">Polymarket</a>`
    : '<span class="j-btn j-btn-sm" aria-disabled="true" style="opacity:0.45;pointer-events:none">Polymarket</span>'}
        <button type="button" class="j-btn j-btn-primary j-btn-sm" data-follow-agent="${agent.id}" ${followDisabled ? 'disabled' : ''}>${followLabel}</button>
      </footer>
    </article>
  `;
};

/** Card layout alias — roster rows used in the grid */
const renderAgentCard = (agent) => renderAgentRow(agent);

window.initJungleAgentsTab = async (force = false) => {
  const grid = document.getElementById('jungleAgentsGrid');
  const meta = document.getElementById('jungleAgentsMeta');
  if (!grid) return;
  if (jungleAgentsBooted && !force) return;
  jungleAgentsBooted = true;

  grid.innerHTML = '<p class="text-muted">Loading Jungle Agents…</p>';
  await refreshTrackedSet();

  try {
    const data = await API.getJungleAgents();
    const agents = data.agents || [];
    if (meta) {
      meta.textContent = `${data.meta?.totalEnabled ?? agents.length} curated agents · ${data.meta?.missingAddressCount ?? 0} awaiting addresses`;
    }
    if (!agents.length) {
      grid.innerHTML = '<p class="text-muted">No Jungle Agents are enabled yet.</p>';
      return;
    }
    grid.innerHTML = agents.map(renderAgentRow).join('');

    grid.querySelectorAll('[data-copy-address]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const value = btn.getAttribute('data-copy-address');
        if (!value) return;
        try {
          await navigator.clipboard.writeText(value);
          await win95Dialog.success('Address copied');
        } catch {
          await win95Dialog.error('Could not copy address');
        }
      });
    });

    const agentById = new Map(agents.map((a) => [a.id, a]));
    grid.querySelectorAll('[data-follow-agent]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-follow-agent');
        const agent = agentById.get(id);
        if (agent) await handleFollowAgent(agent);
      });
    });

    agents.forEach((agent) => {
      if (!agent.addressPending) void loadAgentPerformance(agent.id);
    });
  } catch (error) {
    grid.innerHTML = `<p class="text-loss">Could not load agents: ${error.message || error}</p>`;
  }
};

window.renderHomeJungleAgentTeaser = async () => {
  const row = document.getElementById('homeJungleAgentsTeaser');
  if (!row) return;
  try {
    const data = await API.getJungleAgents();
    const agents = (data.agents || []).slice(0, 4);
    if (!agents.length) {
      row.classList.add('hidden');
      return;
    }
    row.classList.remove('hidden');
    row.innerHTML = `
      <header class="j-roster-head">
        <h3 class="j-roster-title font-serif">Jungle Agents</h3>
        <button type="button" class="j-btn j-btn-ghost j-btn-sm" onclick="switchTab('jungle-agents')">View all</button>
      </header>
      <div class="j-roster-list">
        ${agents.map((a) => {
    const avatar = a.avatarUrl
      ? `<img src="${a.avatarUrl}" alt="" />`
      : `<span class="j-roster-avatar-fallback">${a.displayName.slice(0, 1)}</span>`;
    return `
          <button type="button" class="j-roster-item" onclick="switchTab('jungle-agents')" aria-label="Open ${a.displayName} in Jungle Agents">
            <div class="j-roster-avatar">${avatar}</div>
            <div class="j-roster-body">
              <div class="j-roster-name">${a.displayName}</div>
              <div class="j-roster-tagline">${a.tagline || a.modelLabel || 'Curated copy agent'}</div>
            </div>
            ${a.modelLabel ? `<span class="j-roster-badge">${a.modelLabel}</span>` : '<span class="j-roster-badge">Agent</span>'}
          </button>`;
  }).join('')}
      </div>
      <footer class="j-roster-foot">
        <button type="button" class="j-btn j-btn-sm" onclick="switchTab('jungle-agents')">Browse full roster →</button>
      </footer>
    `;
  } catch {
    row.classList.add('hidden');
  }
};

const METRICS_EXPANDED_KEY = 'ditto_metrics_expanded';

const initDashboardMetricsToggle = () => {
  const btn = document.getElementById('metricsToggleBtn');
  const panel = document.getElementById('metricsDetailPanel');
  if (!btn || !panel) return;

  const applyExpanded = (expanded) => {
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.querySelector('.j-metrics-toggle-label').textContent = expanded ? 'Hide stats' : 'All stats';
    panel.hidden = !expanded;
    panel.classList.toggle('is-open', expanded);
  };

  const saved = localStorage.getItem(METRICS_EXPANDED_KEY) === 'true';
  applyExpanded(saved);

  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-expanded') !== 'true';
    applyExpanded(next);
    localStorage.setItem(METRICS_EXPANDED_KEY, next ? 'true' : 'false');
  });
};

document.addEventListener('DOMContentLoaded', () => {
  initDashboardMetricsToggle();
});
