/**
 * Auth gate and session bootstrap — runs before app.js.
 */
window.__authRequired = true;

const setAuthGateState = (title, message, hint) => {
  const titleEl = document.getElementById('authGateTitle');
  const messageEl = document.getElementById('authGateMessage');
  const hintEl = document.getElementById('authGateHint');
  if (titleEl && title) titleEl.textContent = title;
  if (messageEl && message) messageEl.textContent = message;
  if (hintEl && hint) hintEl.textContent = hint;
};

const setAuthGateActions = ({ show = false, allowLogin = true, allowLegacy = false } = {}) => {
  const actionsEl = document.getElementById('authGateActions');
  const loginBtn = document.getElementById('authGateLoginBtn');
  const legacyBtn = document.getElementById('authGateLegacyBtn');
  if (!actionsEl) return;
  actionsEl.classList.toggle('hidden', !show);
  if (loginBtn) loginBtn.classList.toggle('hidden', !allowLogin);
  if (legacyBtn) legacyBtn.classList.toggle('hidden', !allowLegacy);
};

window.markAppShellReady = () => {
  document.body.classList.remove('app-loading');
  document.body.classList.add('app-ready');
};

window.showAuthModal = () => {
  setAuthGateActions({ show: false });
  setAuthGateState(
    'Hosted sign-in is unavailable here',
    'This environment is using the local fallback access path instead of the normal hosted Ditto login.',
    'Use the API secret only if you intentionally configured this environment for legacy access.',
  );
  document.getElementById('authModal')?.classList.remove('hidden');
  document.getElementById('authError')?.classList.add('hidden');
  const input = document.getElementById('authTokenInput');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 100);
  }
};

const hideAuthModal = () => {
  document.getElementById('authModal')?.classList.add('hidden');
};

window.redirectToMagicLinkLogin = () => {
  const returnTo = encodeURIComponent('/app');
  window.location.replace(`/login?returnTo=${returnTo}`);
};

const AUTH_FETCH_TIMEOUT_MS = 10000;

const fetchWithTimeout = async (url, options = {}, timeoutMs = AUTH_FETCH_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
};

window.setupTenantSwitcher = (meData) => {
  const sel = document.getElementById('tenantSwitcher');
  if (!sel) return;
  if (!meData.tenants || meData.tenants.length <= 1) {
    sel.classList.add('hidden');
    return;
  }
  sel.classList.remove('hidden');
  sel.innerHTML = meData.tenants.map((m) => {
    const id = window.escapeHtml(m.tenantId);
    const name = window.escapeHtml(m.tenantName || m.tenantSlug || m.tenantId);
    const selected = m.tenantId === meData.activeTenant.tenantId ? ' selected' : '';
    return `<option value="${id}"${selected}>${name}</option>`;
  }).join('');
};

window.handleTenantWorkspaceChange = async (tenantId) => {
  if (!tenantId) return;
  try {
    const r = await fetch('/api/auth/switch-tenant', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Could not switch account');
    sessionStorage.setItem('active_tenant_id', tenantId);
    window.location.reload();
  } catch (err) {
    console.error(err);
    if (typeof jungleDialog !== 'undefined' && jungleDialog.error) {
      await jungleDialog.error(String(err.message || err));
    }
  }
};

const applyPlatformAdminUi = (isPlatformAdmin) => {
  document.body.classList.toggle('platform-admin', !!isPlatformAdmin);
};

window.refreshPlatformAdminUi = (isPlatformAdmin) => {
  applyPlatformAdminUi(isPlatformAdmin);
};

const applyCapabilities = (capabilities) => {
  window.__capabilities = capabilities;
  window.__isPlatformAdmin = !!capabilities?.isPlatformAdmin;
  const adminLink = document.getElementById('topbarAdminLink');
  if (adminLink) {
    adminLink.classList.toggle('hidden', !window.__isPlatformAdmin);
  }
  applyPlatformAdminUi(window.__isPlatformAdmin);
};

const loadCapabilities = async () => {
  try {
    const token = API.getToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/auth/capabilities', {
      credentials: 'same-origin',
      headers,
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) applyCapabilities(data);
  } catch (error) {
    console.warn('Could not load auth capabilities', error);
  }
};

window.maybeStartApp = () => {
  if (typeof window.__adminBoot === 'function') {
    window.markAppShellReady();
    window.__adminBoot();
    return;
  }
  if (typeof initApp === 'function') {
    initApp();
    return;
  }
  window.__startAppOnReady = true;
};

const finishAuthenticatedBoot = async () => {
  window.markAppShellReady();
  window.maybeStartApp();
  void loadCapabilities();
};

window.submitAuthToken = async () => {
  const input = document.getElementById('authTokenInput');
  const token = input?.value.trim();
  if (!token) return;

  try {
    const res = await fetch('/api/auth/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (res.ok) {
      API.setToken(token);
      hideAuthModal();
      window.__authRequired = false;
      await finishAuthenticatedBoot();
    } else {
      document.getElementById('authError')?.classList.remove('hidden');
      input.value = '';
      input.focus();
    }
  } catch (_error) {
    document.getElementById('authError')?.classList.remove('hidden');
  }
};

document.getElementById('authTokenInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') window.submitAuthToken();
});

(async function checkAuth() {
  setAuthGateState(
    'Checking your Ditto session',
    'If you’re not signed in yet, we’ll send you to the secure login screen.',
    'This is the normal sign-in path for hosted Ditto.',
  );

  try {
    const res = await fetchWithTimeout('/api/auth/required', { credentials: 'same-origin' });
    const data = await res.json();
    window.__authMode = data.mode || 'legacy';
    window.__hostedMultiTenant = !!data.hostedMultiTenant;

    if (!data.required) {
      window.__authRequired = false;
      await finishAuthenticatedBoot();
      return;
    }

    if (data.mode === 'oidc') {
      const meResponse = await fetchWithTimeout('/api/auth/me', { credentials: 'same-origin' });
      if (meResponse.ok) {
        const meData = await meResponse.json();
        window.__authRequired = false;
        window.__hostedMultiTenant = meData.hostedMultiTenant !== undefined
          ? !!meData.hostedMultiTenant
          : !!data.hostedMultiTenant;
        window.__currentUser = meData.user;
        window.__currentTenant = meData.activeTenant;
        if (meData.activeTenant?.tenantId) {
          sessionStorage.setItem('active_tenant_id', meData.activeTenant.tenantId);
        }
        window.setupTenantSwitcher(meData);
        window.__oidcSession = true;
        document.getElementById('topbarLogout')?.classList.remove('hidden');
        applyCapabilities({
          isPlatformAdmin: !!meData.isPlatformAdmin,
          mode: 'oidc',
          authenticated: true,
        });
        await finishAuthenticatedBoot();
        return;
      }
      window.redirectToMagicLinkLogin();
      return;
    }

    setAuthGateState(
      'Legacy fallback access',
      'This environment is not using hosted sign-in. If you need to open it locally, use the fallback API secret path.',
      'This is only for internal or technical environments, not the normal Ditto product login.',
    );
    const existingToken = API.getToken();
    if (existingToken) {
      const check = await fetch('/api/auth/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${existingToken}`,
        },
      });
      if (check.ok) {
        window.__authRequired = false;
        await finishAuthenticatedBoot();
        return;
      }
    }

    window.showAuthModal();
  } catch (error) {
    const timedOut = Boolean(
      error && typeof error === 'object' && 'name' in error && error.name === 'AbortError',
    );
    console.warn('Could not check auth status:', error);
    setAuthGateState(
      timedOut ? 'Sign-in check timed out' : 'Sign-in check failed',
      timedOut
        ? 'Ditto could not reach the auth service in time. Open sign in to continue.'
        : 'Ditto could not confirm your hosted sign-in automatically. Retry the check or open the secure sign-in flow.',
      'This usually means your session expired, the auth service is unavailable, or the environment is not fully configured yet.',
    );
    setAuthGateActions({ show: true, allowLogin: true, allowLegacy: false });
  }
})();
