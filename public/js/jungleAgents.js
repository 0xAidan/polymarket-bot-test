/**
 * Jungle Agents public showcase tab.
 */

let jungleAgentsBooted = false;
let cachedAgents = [];
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

const updateAgentStatCells = (agentId, portfolio, positions) => {
  const portfolioEl = document.querySelector(`[data-agent-portfolio="${agentId}"]`);
  const positionsEl = document.querySelector(`[data-agent-positions="${agentId}"]`);
  if (portfolioEl) portfolioEl.textContent = portfolio;
  if (positionsEl) positionsEl.textContent = positions;
};

const loadAgentPerformance = async (agentId) => {
  try {
    const perf = await API.getJungleAgentPerformance(agentId);
    updateAgentStatCells(
      agentId,
      formatUsd(perf.portfolioValueUsd),
      String(perf.positionCount ?? '—'),
    );
  } catch {
    updateAgentStatCells(agentId, '—', '—');
  }
};

const bindAgentGridEvents = (grid, agents) => {
  grid.querySelectorAll('[data-copy-address]').forEach((btn) => {
    if (btn.dataset.bound === 'true') return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const value = btn.getAttribute('data-copy-address');
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        await jungleDialog.success('Address copied');
      } catch {
        await jungleDialog.error('Could not copy address');
      }
    });
  });

  const agentById = new Map(agents.map((a) => [a.id, a]));
  grid.querySelectorAll('[data-follow-agent]').forEach((btn) => {
    if (btn.dataset.bound === 'true') return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute('data-follow-agent');
      const agent = agentById.get(id);
      if (agent) await handleFollowAgent(agent);
    });
  });
};

const syncFollowButtons = (agents) => {
  agents.forEach((agent) => {
    const btn = document.querySelector(`[data-follow-agent="${agent.id}"]`);
    if (!btn) return;
    const address = agent.polymarketAddress?.toLowerCase() || '';
    const isFollowing = address && trackedAddressSet.has(address);
    btn.disabled = agent.addressPending || isFollowing;
    btn.textContent = isFollowing ? 'Following' : 'Follow';
  });
};

const renderAgentTableRow = (agent) => {
  const address = agent.polymarketAddress?.toLowerCase() || '';
  const isFollowing = address && trackedAddressSet.has(address);
  const followDisabled = agent.addressPending || isFollowing;
  const followLabel = isFollowing ? 'Following' : 'Follow';
  const profileUrl = polymarketProfileUrl(agent.polymarketAddress);
  const avatar = agent.avatarUrl
    ? `<img src="${agent.avatarUrl}" alt="" class="j-agents-avatar-img" />`
    : `<span class="j-agents-avatar-fallback">${agent.displayName.slice(0, 1)}</span>`;
  const metaLine = [agent.tagline, agent.modelLabel].filter(Boolean).join(' · ');
  const categoryBadge = agent.category
    ? `<span class="j-badge j-agents-category">${agent.category}</span>`
    : '';

  return `
    <tr data-agent-id="${agent.id}">
      <td class="j-agents-cell-agent">
        <span class="j-agents-avatar-sm">${avatar}</span>
        <span class="j-agents-cell-text">
          <span class="j-agents-name font-serif">${agent.displayName} ${categoryBadge}</span>
          ${metaLine ? `<span class="j-agents-meta">${metaLine}</span>` : ''}
        </span>
      </td>
      <td class="j-agents-num" data-agent-portfolio="${agent.id}">—</td>
      <td class="j-agents-num" data-agent-positions="${agent.id}">—</td>
      <td class="j-agents-wallet">
        ${agent.addressPending
    ? '<span class="j-badge j-badge-warn">Pending</span>'
    : `<code class="j-mono">${agentShortAddress(agent.polymarketAddress)}</code>
           <button type="button" class="j-btn j-btn-ghost j-btn-sm j-agents-copy" data-copy-address="${agent.polymarketAddress}" aria-label="Copy address">⧉</button>`}
      </td>
      <td class="j-agents-actions">
        ${profileUrl
    ? `<a class="j-btn j-btn-sm" href="${profileUrl}" target="_blank" rel="noopener noreferrer">View</a>`
    : ''}
        <button type="button" class="j-btn j-btn-primary j-btn-sm" data-follow-agent="${agent.id}" ${followDisabled ? 'disabled' : ''}>${followLabel}</button>
      </td>
    </tr>
  `;
};

/** Group agents by their (optional) admin-curated collection, preserving roster order. */
const groupAgentsByCollection = (agents) => {
  const groups = [];
  const byName = new Map();
  for (const agent of agents) {
    const name = (agent.collection || '').trim();
    if (!byName.has(name)) {
      const group = { name, agents: [] };
      byName.set(name, group);
      groups.push(group);
    }
    byName.get(name).agents.push(agent);
  }
  // Ungrouped agents always render last so curated collections lead the page.
  return groups.sort((a, b) => (a.name === '' ? 1 : 0) - (b.name === '' ? 1 : 0));
};

const renderAgentTable = (agents) => {
  const groups = groupAgentsByCollection(agents);
  const hasCollections = groups.some((g) => g.name !== '');

  const body = groups.map((group) => {
    const header = hasCollections
      ? `<tr class="j-agents-collection-row"><td colspan="5">${group.name || 'More agents'}</td></tr>`
      : '';
    return header + group.agents.map(renderAgentTableRow).join('');
  }).join('');

  return `
  <div class="j-panel j-agents-table-panel">
    <div class="j-agents-table-scroll">
      <table class="jw-listview j-agents-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Portfolio</th>
            <th>Pos</th>
            <th>Wallet</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${body}
        </tbody>
      </table>
    </div>
  </div>
`;
};

const handleFollowAgent = async (agent) => {
  if (agent.addressPending || !agent.polymarketAddress) {
    await jungleDialog.alert('This agent does not have a Polymarket address yet.');
    return;
  }
  const addr = agent.polymarketAddress.toLowerCase();
  if (trackedAddressSet.has(addr)) {
    await jungleDialog.alert('You are already following this wallet. Open Tracked Wallets to configure and enable copying.');
    switchTab('wallets');
    return;
  }
  try {
    await API.addWallet(addr, agent.displayName);
    try {
      const tw = await API.getTradingWallets();
      const wallets = tw.wallets || [];
      const credentialed = wallets.filter((w) => w.hasCredentials && w.active !== false);
      if (credentialed.length === 1) {
        await API.addCopyAssignment(addr, credentialed[0].id);
      }
    } catch {
      // Non-fatal — user can assign manually under Trading Wallets
    }
    trackedAddressSet.add(addr);
    await jungleDialog.success(`Added ${agent.displayName} to Tracked Wallets (inactive until you enable copying).`);
    if (typeof loadWallets === 'function') await loadWallets(true);
    syncFollowButtons(cachedAgents);
  } catch (error) {
    await jungleDialog.error(error.message || 'Could not follow agent');
  }
};

window.initJungleAgentsTab = async (force = false) => {
  const grid = document.getElementById('jungleAgentsGrid');
  const meta = document.getElementById('jungleAgentsMeta');
  if (!grid) return;

  if (jungleAgentsBooted && !force && grid.querySelector('.j-agents-table tbody tr')) {
    await refreshTrackedSet();
    syncFollowButtons(cachedAgents);
    return;
  }

  if (!grid.querySelector('.j-agents-table')) {
    grid.innerHTML = renderAgentTable([]);
  }

  await refreshTrackedSet();

  try {
    const data = await API.getJungleAgents();
    const agents = data.agents || [];
    cachedAgents = agents;
    jungleAgentsBooted = true;

    if (meta) {
      meta.textContent = `${data.meta?.totalEnabled ?? agents.length} agents · ${data.meta?.missingAddressCount ?? 0} pending addresses`;
    }

    if (!agents.length) {
      grid.innerHTML = '<p class="text-muted j-agents-empty-msg">No Jungle Agents are enabled yet.</p>';
      return;
    }

    grid.innerHTML = renderAgentTable(agents);
    bindAgentGridEvents(grid, agents);

    agents.forEach((agent) => {
      if (!agent.addressPending) void loadAgentPerformance(agent.id);
    });
  } catch (error) {
    grid.innerHTML = `<p class="text-loss j-agents-empty-msg">Could not load agents: ${error.message || error}</p>`;
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
