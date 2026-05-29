/**
 * Platform admin — Jungle Agents CRUD with fast bulk address entry.
 */

let adminAgents = [];
let showMissingOnly = false;
const addressDrafts = new Map();
const perfSnapshots = new Map();

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const isValidAddress = (addr) => !addr || EVM_RE.test(addr.trim());

const sortAgentsForDisplay = (agents) => [...agents].sort((a, b) => {
  const aMissing = !a.polymarketAddress ? 0 : 1;
  const bMissing = !b.polymarketAddress ? 0 : 1;
  if (aMissing !== bMissing) return aMissing - bMissing;
  return a.sortOrder - b.sortOrder;
});

const getDraftAddress = (agent) => {
  if (addressDrafts.has(agent.id)) return addressDrafts.get(agent.id);
  return agent.polymarketAddress || '';
};

const showUnauthorized = () => {
  document.getElementById('adminUnauthorized')?.classList.remove('hidden');
  document.getElementById('adminApp')?.classList.add('hidden');
};

const showAdminApp = () => {
  document.getElementById('adminUnauthorized')?.classList.add('hidden');
  document.getElementById('adminApp')?.classList.remove('hidden');
};

const updateHealthStrip = (agents) => {
  const enabled = agents.filter((a) => a.enabled).length;
  const missing = agents.filter((a) => !a.polymarketAddress).length;
  const updated = agents.reduce((max, a) => Math.max(max, a.updatedAtMs || 0), 0);
  document.getElementById('healthTotal').textContent = String(agents.length);
  document.getElementById('healthEnabled').textContent = String(enabled);
  document.getElementById('healthMissing').textContent = String(missing);
  document.getElementById('healthUpdated').textContent = updated
    ? new Date(updated).toLocaleString()
    : '—';
};

const fetchPerfSnapshot = async (agentId) => {
  try {
    const data = await API.getJungleAgentPerformance(agentId);
    if (data.success && data.portfolioValueUsd != null) {
      perfSnapshots.set(agentId, `$${Number(data.portfolioValueUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })} · ${data.positionCount ?? 0} positions`);
      renderTable();
    }
  } catch {
    perfSnapshots.set(agentId, 'Performance unavailable');
    renderTable();
  }
};

const renderTable = () => {
  const tbody = document.getElementById('adminAgentsBody');
  if (!tbody) return;

  let visible = sortAgentsForDisplay(adminAgents);
  if (showMissingOnly) {
    visible = visible.filter((a) => !a.polymarketAddress);
  }

  tbody.innerHTML = visible.map((agent) => {
    const draft = getDraftAddress(agent);
    const missing = !agent.polymarketAddress;
    const invalid = draft && !isValidAddress(draft);
    const perf = perfSnapshots.get(agent.id);
    return `
    <tr class="${missing ? 'row-missing-address' : ''}" data-agent-row="${agent.id}">
      <td>${agent.sortOrder}</td>
      <td>
        <strong>${escapeHtml(agent.displayName)}</strong>
        ${missing ? '<span class="j-badge j-badge-warn" title="Missing address">pending</span>' : ''}
      </td>
      <td>${escapeHtml(agent.modelLabel || '—')}</td>
      <td>
        <div class="j-admin-address-cell">
          <input
            type="text"
            class="j-input j-admin-address-input${invalid ? ' input-invalid' : ''}"
            data-address-input="${agent.id}"
            value="${escapeHtml(draft)}"
            placeholder="0x… paste Polymarket proxy address"
            aria-label="Polymarket address for ${escapeHtml(agent.displayName)}"
            spellcheck="false"
            autocomplete="off"
          />
          <button type="button" class="j-btn j-btn-sm" data-copy-address="${agent.id}" title="Copy address" ${draft ? '' : 'disabled'}>Copy</button>
        </div>
        ${perf ? `<div class="j-admin-perf">${escapeHtml(perf)}</div>` : ''}
      </td>
      <td>${agent.enabled ? 'Yes' : 'No'}</td>
      <td>
        <button type="button" class="j-btn j-btn-sm" data-edit-agent="${agent.id}">Edit</button>
        <button type="button" class="j-btn j-btn-sm" data-move-up="${agent.id}">↑</button>
        <button type="button" class="j-btn j-btn-sm" data-move-down="${agent.id}">↓</button>
        <button type="button" class="j-btn j-btn-sm" data-delete-agent="${agent.id}">Delete</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-address-input]').forEach((input) => {
    input.addEventListener('input', (e) => {
      const id = e.target.getAttribute('data-address-input');
      addressDrafts.set(id, e.target.value.trim());
      e.target.classList.toggle('input-invalid', e.target.value.trim() && !isValidAddress(e.target.value.trim()));
      const copyBtn = tbody.querySelector(`[data-copy-address="${id}"]`);
      if (copyBtn) copyBtn.disabled = !e.target.value.trim();
    });
  });

  tbody.querySelectorAll('[data-copy-address]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-copy-address');
      const val = getDraftAddress(adminAgents.find((a) => a.id === id) || { id });
      if (!val) return;
      try {
        await navigator.clipboard.writeText(val);
        await win95Dialog.success('Address copied to clipboard');
      } catch {
        await win95Dialog.alert(val, 'Copy manually');
      }
    });
  });

  tbody.querySelectorAll('[data-edit-agent]').forEach((btn) => {
    btn.addEventListener('click', () => openEditDrawer(btn.getAttribute('data-edit-agent')));
  });
  tbody.querySelectorAll('[data-delete-agent]').forEach((btn) => {
    btn.addEventListener('click', () => deleteAgent(btn.getAttribute('data-delete-agent')));
  });
  tbody.querySelectorAll('[data-move-up]').forEach((btn) => {
    btn.addEventListener('click', () => moveAgent(btn.getAttribute('data-move-up'), -1));
  });
  tbody.querySelectorAll('[data-move-down]').forEach((btn) => {
    btn.addEventListener('click', () => moveAgent(btn.getAttribute('data-move-down'), 1));
  });
};

const loadAdminAgents = async () => {
  const data = await API.getAdminJungleAgents();
  adminAgents = data.agents || [];
  addressDrafts.clear();
  updateHealthStrip(adminAgents);
  renderTable();
};

const collectAddressUpdates = () => {
  const updates = [];
  const invalid = [];
  for (const agent of adminAgents) {
    const draft = getDraftAddress(agent).trim();
    if (!isValidAddress(draft)) {
      invalid.push(agent.displayName);
      continue;
    }
    const saved = (agent.polymarketAddress || '').trim();
    if (draft !== saved) {
      updates.push({ id: agent.id, polymarketAddress: draft });
    }
  }
  return { updates, invalid };
};

const saveAllAddresses = async () => {
  const { updates, invalid } = collectAddressUpdates();
  if (invalid.length > 0) {
    await win95Dialog.error(`Invalid address format for: ${invalid.join(', ')}. Use 0x followed by 40 hex characters, or leave blank.`);
    return;
  }
  if (updates.length === 0) {
    await win95Dialog.alert('No address changes to save.');
    return;
  }
  try {
    await API.bulkUpdateAdminJungleAddresses(updates);
    addressDrafts.clear();
    await loadAdminAgents();
    await win95Dialog.success(`Saved ${updates.length} address${updates.length === 1 ? '' : 'es'}.`);
    for (const row of updates) {
      if (row.polymarketAddress) {
        fetchPerfSnapshot(row.id);
      }
    }
  } catch (error) {
    await win95Dialog.error(error.message || 'Save failed');
  }
};

const moveAgent = async (id, direction) => {
  const index = adminAgents.findIndex((a) => a.id === id);
  if (index < 0) return;
  const target = index + direction;
  if (target < 0 || target >= adminAgents.length) return;
  const ordered = [...adminAgents];
  const [item] = ordered.splice(index, 1);
  ordered.splice(target, 0, item);
  await API.reorderAdminJungleAgents(ordered.map((a) => a.id));
  await loadAdminAgents();
};

const deleteAgent = async (id) => {
  const agent = adminAgents.find((a) => a.id === id);
  if (!agent) return;
  const ok = await win95Dialog.confirm(`Delete agent "${agent.displayName}"?`, 'Delete agent');
  if (!ok) return;
  await API.deleteAdminJungleAgent(id);
  await win95Dialog.success('Agent deleted');
  await loadAdminAgents();
};

const openEditDrawer = (id) => {
  const isNew = !id;
  const agent = isNew
    ? {
      displayName: '',
      tagline: '',
      modelLabel: '',
      polymarketAddress: '',
      olympicsProfileUrl: 'https://olympics.jungle.win/agents',
      avatarUrl: '',
      enabled: true,
    }
    : adminAgents.find((a) => a.id === id);

  if (!agent) return;

  const formHtml = `
    <label class="j-label">Display name<input id="adminFieldName" class="j-input" value="${escapeHtml(agent.displayName || '')}" /></label>
    <label class="j-label">Tagline<input id="adminFieldTagline" class="j-input" value="${escapeHtml(agent.tagline || '')}" /></label>
    <label class="j-label">Model label<input id="adminFieldModel" class="j-input" value="${escapeHtml(agent.modelLabel || '')}" /></label>
    <label class="j-label">Polymarket address<input id="adminFieldAddress" class="j-input" placeholder="0x…" value="${escapeHtml(agent.polymarketAddress || getDraftAddress(agent))}" /></label>
    <label class="j-label">Olympics profile URL<input id="adminFieldOlympics" class="j-input" value="${escapeHtml(agent.olympicsProfileUrl || '')}" /></label>
    <label class="j-label">Avatar URL<input id="adminFieldAvatar" class="j-input" value="${escapeHtml(agent.avatarUrl || '')}" /></label>
    <label class="j-label"><input type="checkbox" id="adminFieldEnabled" ${agent.enabled !== false ? 'checked' : ''} /> Enabled</label>
  `;

  jungleDialog.openDrawer(isNew ? 'Add Jungle Agent' : `Edit ${agent.displayName}`, formHtml, [
    { label: 'Save', value: 'save', primary: true },
    { label: 'Cancel', value: null },
  ]).then(async (action) => {
    if (action !== 'save') return;
    const addr = document.getElementById('adminFieldAddress')?.value.trim() || '';
    if (!isValidAddress(addr)) {
      await win95Dialog.error('Invalid Polymarket address. Use 0x followed by 40 hex characters, or leave blank.');
      return;
    }
    const payload = {
      displayName: document.getElementById('adminFieldName')?.value.trim(),
      tagline: document.getElementById('adminFieldTagline')?.value.trim(),
      modelLabel: document.getElementById('adminFieldModel')?.value.trim(),
      polymarketAddress: addr,
      olympicsProfileUrl: document.getElementById('adminFieldOlympics')?.value.trim(),
      avatarUrl: document.getElementById('adminFieldAvatar')?.value.trim(),
      enabled: document.getElementById('adminFieldEnabled')?.checked ?? true,
    };
    try {
      if (isNew) {
        await API.createAdminJungleAgent(payload);
        await win95Dialog.success('Agent created');
      } else {
        await API.updateAdminJungleAgent(id, payload);
        await win95Dialog.success('Agent updated');
        if (addr) fetchPerfSnapshot(id);
      }
      addressDrafts.delete(id);
      await loadAdminAgents();
    } catch (error) {
      await win95Dialog.error(error.message || 'Save failed');
    }
  });
};

const bootAdmin = async () => {
  try {
    const caps = await API.getCapabilities();
    if (!caps.isPlatformAdmin) {
      showUnauthorized();
      return;
    }
    showAdminApp();
    await loadAdminAgents();
  } catch (error) {
    console.error(error);
    showUnauthorized();
  }
};

document.getElementById('adminAddAgentBtn')?.addEventListener('click', () => openEditDrawer(null));
document.getElementById('adminRefreshBtn')?.addEventListener('click', () => loadAdminAgents().catch((e) => win95Dialog.error(e.message)));
document.getElementById('adminSaveAllAddressesBtn')?.addEventListener('click', () => saveAllAddresses());
document.getElementById('adminMissingOnlyFilter')?.addEventListener('change', (e) => {
  showMissingOnly = e.target.checked;
  renderTable();
});

document.addEventListener('DOMContentLoaded', () => {
  if (window.__authRequired) return;
  bootAdmin();
});

window.__adminBoot = bootAdmin;
