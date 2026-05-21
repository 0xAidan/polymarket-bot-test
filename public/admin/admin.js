/**
 * Platform admin — Jungle Agents CRUD.
 */

let adminAgents = [];

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

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

const renderTable = () => {
  const tbody = document.getElementById('adminAgentsBody');
  if (!tbody) return;
  tbody.innerHTML = adminAgents.map((agent) => `
    <tr>
      <td>${agent.sortOrder}</td>
      <td>
        <strong>${escapeHtml(agent.displayName)}</strong>
        ${!agent.polymarketAddress ? '<span class="j-badge j-badge-warn" title="Missing address">!</span>' : ''}
      </td>
      <td><code>${agent.polymarketAddress ? `${agent.polymarketAddress.slice(0, 8)}…` : 'pending'}</code></td>
      <td>${agent.enabled ? 'Yes' : 'No'}</td>
      <td>
        <button type="button" class="j-btn j-btn-sm" data-edit-agent="${agent.id}">Edit</button>
        <button type="button" class="j-btn j-btn-sm" data-move-up="${agent.id}">↑</button>
        <button type="button" class="j-btn j-btn-sm" data-move-down="${agent.id}">↓</button>
        <button type="button" class="j-btn j-btn-sm" data-delete-agent="${agent.id}">Delete</button>
      </td>
    </tr>
  `).join('');

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
  updateHealthStrip(adminAgents);
  renderTable();
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
    <label class="j-label">Polymarket address<input id="adminFieldAddress" class="j-input" placeholder="0x…" value="${escapeHtml(agent.polymarketAddress || '')}" /></label>
    <label class="j-label">Olympics profile URL<input id="adminFieldOlympics" class="j-input" value="${escapeHtml(agent.olympicsProfileUrl || '')}" /></label>
    <label class="j-label">Avatar URL<input id="adminFieldAvatar" class="j-input" value="${escapeHtml(agent.avatarUrl || '')}" /></label>
    <label class="j-label"><input type="checkbox" id="adminFieldEnabled" ${agent.enabled !== false ? 'checked' : ''} /> Enabled</label>
  `;

  jungleDialog.openDrawer(isNew ? 'Add Jungle Agent' : `Edit ${agent.displayName}`, formHtml, [
    { label: 'Save', value: 'save', primary: true },
    { label: 'Cancel', value: null },
  ]).then(async (action) => {
    if (action !== 'save') return;
    const payload = {
      displayName: document.getElementById('adminFieldName')?.value.trim(),
      tagline: document.getElementById('adminFieldTagline')?.value.trim(),
      modelLabel: document.getElementById('adminFieldModel')?.value.trim(),
      polymarketAddress: document.getElementById('adminFieldAddress')?.value.trim(),
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
      }
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

document.addEventListener('DOMContentLoaded', () => {
  if (window.__authRequired) return;
  bootAdmin();
});

window.__adminBoot = bootAdmin;
