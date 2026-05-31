const state = {
  agents: [],
  categories: [],
  activeCategory: 'ALL'
};

const statusMessageEl = document.getElementById('statusMessage');
const agentsBodyEl = document.getElementById('agentsBody');
const categoryFiltersEl = document.getElementById('categoryFilters');
const agentCountPillEl = document.getElementById('agentCountPill');
const missingCountPillEl = document.getElementById('missingCountPill');

const getToken = () => sessionStorage.getItem('api_token') || '';

const setStatus = (message, isError = false) => {
  statusMessageEl.textContent = message;
  statusMessageEl.classList.toggle('status-error', isError);
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const normalizeCategory = (value) => {
  const text = String(value || '').trim();
  return text || 'Uncategorized';
};

const openDialog = ({ title, message, showInput = false, inputValue = '', confirmLabel = 'OK', cancelLabel = 'Cancel' }) => {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'win-modal-overlay';
    overlay.style.zIndex = '9999';
    overlay.innerHTML = `
      <div class="win-modal" style="max-width:440px;">
        <div class="win-titlebar">
          <div class="win-titlebar-text">${escapeHtml(title)}</div>
        </div>
        <div class="win-modal-body">
          <div style="margin-bottom:10px;line-height:1.5;">${escapeHtml(message)}</div>
          ${showInput ? `<input id="adminDialogInput" class="admin-input" value="${escapeHtml(inputValue)}">` : ''}
        </div>
        <div class="win-modal-footer">
          <button type="button" class="win-btn" id="adminDialogCancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="win-btn win-btn-primary" id="adminDialogConfirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const cleanup = (value) => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector('#adminDialogCancel')?.addEventListener('click', () => cleanup(null));
    overlay.querySelector('#adminDialogConfirm')?.addEventListener('click', () => {
      if (!showInput) {
        cleanup(true);
        return;
      }
      const value = overlay.querySelector('#adminDialogInput')?.value ?? '';
      cleanup(value);
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(null);
    });
    if (showInput) {
      setTimeout(() => {
        overlay.querySelector('#adminDialogInput')?.focus();
      }, 10);
    }
  });
};

const fetchApi = async (path, options = {}) => {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
};

const ensureLegacyTokenIfNeeded = async (errorMessage) => {
  if (!/Platform admin required|Unauthorized|Authentication required/i.test(errorMessage)) {
    return false;
  }
  if (window.__authMode === 'oidc') {
    setStatus('You are signed in but not a platform admin account.', true);
    return true;
  }
  const token = await openDialog({
    title: 'Platform Admin Token',
    message: 'Platform admin token required. Paste API secret:',
    showInput: true,
    confirmLabel: 'Use Token'
  });
  if (!token) return true;
  sessionStorage.setItem('api_token', String(token).trim());
  return true;
};

const buildCategoryOptionsHtml = (selected) => {
  const categories = ['Uncategorized', ...state.categories.filter((category) => category !== 'Uncategorized')];
  return categories.map((category) => {
    const selectedAttr = category === selected ? 'selected' : '';
    return `<option value="${escapeHtml(category)}" ${selectedAttr}>${escapeHtml(category)}</option>`;
  }).join('');
};

const renderCategoryFilters = () => {
  const categories = ['ALL', ...state.categories];
  categoryFiltersEl.innerHTML = categories.map((category) => {
    const active = category === state.activeCategory ? 'active' : '';
    return `<button type="button" class="category-chip ${active}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`;
  }).join('');
};

const buildAgentRow = (agent, index) => {
  const category = normalizeCategory(agent.category);
  const checked = agent.enabled ? 'checked' : '';
  const address = agent.polymarketAddress || '';
  return `
    <tr data-id="${escapeHtml(agent.id)}" data-index="${index}" data-category="${escapeHtml(category)}">
      <td>
        <img class="agent-avatar" src="${escapeHtml(agent.avatarUrl || '')}" alt="${escapeHtml(agent.displayName)}" onerror="this.style.opacity='0.25'">
        <input class="admin-input mt-4" data-field="avatarUrl" placeholder="https://..." value="${escapeHtml(agent.avatarUrl || '')}">
      </td>
      <td><input class="admin-input" data-field="displayName" value="${escapeHtml(agent.displayName || '')}"></td>
      <td><input class="admin-input" data-field="modelLabel" value="${escapeHtml(agent.modelLabel || '')}"></td>
      <td>
        <select class="admin-select" data-field="category">
          ${buildCategoryOptionsHtml(category)}
        </select>
      </td>
      <td><input class="admin-input" data-field="polymarketAddress" placeholder="0x..." value="${escapeHtml(address)}"></td>
      <td><input class="admin-input" data-field="tagline" value="${escapeHtml(agent.tagline || '')}"></td>
      <td style="text-align:center;">
        <input type="checkbox" data-field="enabled" ${checked} aria-label="Toggle live state">
      </td>
      <td><button type="button" class="win-btn win-btn-sm" data-action="track">One-Click Track</button></td>
      <td><button type="button" class="win-btn win-btn-sm win-btn-danger" data-action="delete">X</button></td>
    </tr>
  `;
};

const renderAgents = () => {
  const filtered = state.agents.filter((agent) => {
    if (state.activeCategory === 'ALL') return true;
    return normalizeCategory(agent.category) === state.activeCategory;
  });

  agentCountPillEl.textContent = `${state.agents.length} agents`;
  missingCountPillEl.textContent = `${state.agents.filter((agent) => !agent.polymarketAddress).length} missing addresses`;

  if (filtered.length === 0) {
    agentsBodyEl.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No agents in this category yet.</td></tr>';
    return;
  }

  agentsBodyEl.innerHTML = filtered
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((agent, index) => buildAgentRow(agent, index))
    .join('');
};

const rebuildCategoryList = () => {
  const fromAgents = state.agents.map((agent) => normalizeCategory(agent.category));
  state.categories = [...new Set(fromAgents)].sort((a, b) => a.localeCompare(b));
  if (state.categories.length === 0) state.categories = ['Uncategorized'];
};

const loadRoster = async () => {
  try {
    setStatus('Loading roster...');
    const result = await fetchApi('/api/admin/jungle-agents');
    state.agents = result.agents || [];
    rebuildCategoryList();
    if (Array.isArray(result.categories) && result.categories.length > 0) {
      state.categories = [...new Set(['Uncategorized', ...result.categories.map(normalizeCategory)])].sort((a, b) => a.localeCompare(b));
    }
    renderCategoryFilters();
    renderAgents();
    setStatus('Roster loaded.');
  } catch (error) {
    const handled = await ensureLegacyTokenIfNeeded(error.message);
    if (handled) {
      try {
        const retry = await fetchApi('/api/admin/jungle-agents');
        state.agents = retry.agents || [];
        rebuildCategoryList();
        renderCategoryFilters();
        renderAgents();
        setStatus('Roster loaded.');
      } catch (retryError) {
        setStatus(`Could not load roster: ${retryError.message}`, true);
      }
      return;
    }
    setStatus(`Could not load roster: ${error.message}`, true);
  }
};

const readRowsIntoState = () => {
  const rows = [...agentsBodyEl.querySelectorAll('tr[data-id]')];
  rows.forEach((row) => {
    const id = row.getAttribute('data-id');
    const agent = state.agents.find((entry) => entry.id === id);
    if (!agent) return;
    row.querySelectorAll('[data-field]').forEach((el) => {
      const field = el.getAttribute('data-field');
      if (field === 'enabled') {
        agent.enabled = el.checked;
      } else {
        agent[field] = String(el.value || '').trim();
      }
    });
    agent.category = normalizeCategory(agent.category);
  });
  rebuildCategoryList();
};

const saveAllChanges = async () => {
  try {
    readRowsIntoState();
    const updates = state.agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      modelLabel: agent.modelLabel || '',
      category: normalizeCategory(agent.category),
      polymarketAddress: agent.polymarketAddress || '',
      tagline: agent.tagline || '',
      avatarUrl: agent.avatarUrl || '',
      enabled: !!agent.enabled,
      sortOrder: agent.sortOrder
    }));
    await fetchApi('/api/admin/jungle-agents/bulk-save', {
      method: 'POST',
      body: JSON.stringify({ updates })
    });
    renderCategoryFilters();
    renderAgents();
    setStatus('All changes saved.');
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, true);
  }
};

const syncMissing = async () => {
  try {
    setStatus('Syncing missing addresses from Polymarket...');
    const result = await fetchApi('/api/admin/jungle-agents/sync-polymarket', { method: 'POST' });
    state.agents = result.agents || state.agents;
    rebuildCategoryList();
    renderCategoryFilters();
    renderAgents();
    setStatus(`Sync complete. Added ${result.synced || 0}, unresolved ${result.unresolved?.length || 0}.`);
  } catch (error) {
    setStatus(`Sync failed: ${error.message}`, true);
  }
};

const addCategory = () => {
  void (async () => {
    const name = await openDialog({
      title: 'Create Category',
      message: 'New category name:',
      showInput: true,
      confirmLabel: 'Create'
    });
    if (!name) return;
  const category = normalizeCategory(name);
  if (!state.categories.includes(category)) {
    state.categories.push(category);
    state.categories.sort((a, b) => a.localeCompare(b));
  }
  renderCategoryFilters();
  renderAgents();
  setStatus(`Category "${category}" added. Assign it to rows, then Save All Changes.`);
  })();
};

const addAgent = () => {
  const now = Date.now();
  state.agents.push({
    id: `new-${now}-${Math.random().toString(36).slice(2, 7)}`,
    displayName: 'New Agent',
    modelLabel: '',
    category: state.activeCategory !== 'ALL' ? state.activeCategory : 'Uncategorized',
    polymarketAddress: '',
    tagline: '',
    avatarUrl: '',
    olympicsProfileUrl: 'https://olympics.jungle.win/agents',
    enabled: true,
    sortOrder: state.agents.length + 1
  });
  rebuildCategoryList();
  renderCategoryFilters();
  renderAgents();
  setStatus('New row added. Fill details and click Save All Changes.');
};

const deleteAgent = async (id) => {
  const row = state.agents.find((agent) => agent.id === id);
  if (!row) return;
  const confirmDelete = await openDialog({
    title: 'Delete Agent',
    message: `Delete agent "${row.displayName}"?`,
    confirmLabel: 'Delete'
  });
  if (!confirmDelete) return;

  if (!id.startsWith('new-')) {
    try {
      await fetchApi(`/api/admin/jungle-agents/${id}`, { method: 'DELETE' });
    } catch (error) {
      setStatus(`Delete failed: ${error.message}`, true);
      return;
    }
  }

  state.agents = state.agents.filter((agent) => agent.id !== id);
  rebuildCategoryList();
  renderCategoryFilters();
  renderAgents();
  setStatus('Agent removed.');
};

const oneClickTrack = async (id) => {
  readRowsIntoState();
  const agent = state.agents.find((entry) => entry.id === id);
  if (!agent) return;
  if (!agent.polymarketAddress) {
    setStatus('This agent has no wallet address yet.', true);
    return;
  }
  try {
    await fetchApi('/api/wallets', {
      method: 'POST',
      body: JSON.stringify({
        address: agent.polymarketAddress,
        label: agent.displayName,
        tags: [normalizeCategory(agent.category)]
      })
    });
    setStatus(`Tracked wallet added for ${agent.displayName}.`);
  } catch (error) {
    setStatus(`Could not add tracked wallet: ${error.message}`, true);
  }
};

const handleBodyClick = (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const filterBtn = target.closest('.category-chip');
  if (filterBtn) {
    state.activeCategory = filterBtn.getAttribute('data-category') || 'ALL';
    renderCategoryFilters();
    renderAgents();
    return;
  }

  const row = target.closest('tr[data-id]');
  if (!row) return;
  const id = row.getAttribute('data-id');
  const action = target.getAttribute('data-action');
  if (!id || !action) return;
  if (action === 'delete') {
    void deleteAgent(id);
  } else if (action === 'track') {
    void oneClickTrack(id);
  }
};

document.getElementById('backToAppBtn').addEventListener('click', () => {
  window.location.href = '/';
});
document.getElementById('refreshBtn').addEventListener('click', () => {
  void loadRoster();
});
document.getElementById('syncBtn').addEventListener('click', () => {
  void syncMissing();
});
document.getElementById('addCategoryBtn').addEventListener('click', addCategory);
document.getElementById('addAgentBtn').addEventListener('click', addAgent);
document.getElementById('saveBtn').addEventListener('click', () => {
  void saveAllChanges();
});
document.body.addEventListener('click', handleBodyClick);

void loadRoster();
