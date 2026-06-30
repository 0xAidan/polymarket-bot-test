/**
 * Platform admin — session bootstrap (admin page only).
 */
(() => {
  const AUTH_FETCH_TIMEOUT_MS = 10000;

  const getAuthReturnTo = () => {
    const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (typeof window.sanitizeReturnTo === 'function') {
      return window.sanitizeReturnTo(path, '/admin');
    }
    return path.startsWith('/') && !path.startsWith('//') ? path : '/admin';
  };

  const escapeAuthText = (value) => (
    typeof window.escapeHtml === 'function'
      ? window.escapeHtml(value)
      : String(value)
  );

  const redirectToLogin = () => {
    const returnTo = encodeURIComponent(getAuthReturnTo());
    window.location.replace(`/login?returnTo=${returnTo}`);
  };

  const showAdminAuthGate = ({ title, message, showSignIn = true } = {}) => {
    const loading = document.getElementById('adminLoading');
    if (!loading) {
      redirectToLogin();
      return;
    }

    document.body.classList.remove('app-loading');
    document.body.classList.add('app-ready');
    loading.classList.remove('hidden');
    loading.innerHTML = `
      <h1 class="font-serif j-admin-auth-title">${escapeAuthText(title || 'Sign-in required')}</h1>
      <p class="text-muted j-admin-auth-message">${escapeAuthText(message || '')}</p>
      ${showSignIn ? '<button type="button" class="j-btn j-btn-primary j-admin-auth-signin" id="adminAuthSignInBtn">Sign in</button>' : ''}
    `;

    if (showSignIn) {
      document.getElementById('adminAuthSignInBtn')?.addEventListener('click', () => {
        redirectToLogin();
      });
    }
  };

  const fetchWithTimeout = async (url, options = {}, timeoutMs = AUTH_FETCH_TIMEOUT_MS) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
  };

  const bootPlatformAdmin = () => {
    document.body.classList.remove('app-loading');
    document.body.classList.add('app-ready');

    if (typeof window.__adminBoot === 'function') {
      void window.__adminBoot();
      return;
    }

    showAdminAuthGate({
      title: 'Admin failed to load',
      message: 'The admin scripts did not finish loading. Refresh the page and try again.',
      showSignIn: false,
    });
  };

  const finishAuthenticatedSession = (meData) => {
    window.__authRequired = false;
    window.__hostedMultiTenant = meData.hostedMultiTenant !== undefined
      ? !!meData.hostedMultiTenant
      : !!window.__hostedMultiTenant;
    window.__currentUser = meData.user;
    window.__currentTenant = meData.activeTenant;
    if (meData.activeTenant?.tenantId) {
      sessionStorage.setItem('active_tenant_id', meData.activeTenant.tenantId);
    }
    window.__oidcSession = true;
    window.__isPlatformAdmin = !!meData.isPlatformAdmin;
    window.__capabilities = {
      isPlatformAdmin: !!meData.isPlatformAdmin,
      mode: 'oidc',
      authenticated: true,
    };
    document.body.classList.toggle('platform-admin', !!meData.isPlatformAdmin);
    bootPlatformAdmin();
  };

  const checkLegacyToken = async () => {
    const existingToken = typeof API !== 'undefined' ? API.getToken() : '';
    if (!existingToken) return false;

    const check = await fetch('/api/auth/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${existingToken}`,
      },
    });
    if (!check.ok) return false;

    window.__authRequired = false;
    bootPlatformAdmin();
    return true;
  };

  (async function checkPlatformAdminAuth() {
    try {
      const res = await fetchWithTimeout('/api/auth/required', { credentials: 'same-origin' });
      const data = await res.json();
      window.__authMode = data.mode || 'legacy';
      window.__hostedMultiTenant = !!data.hostedMultiTenant;

      if (!data.required) {
        window.__authRequired = false;
        bootPlatformAdmin();
        return;
      }

      if (data.mode === 'oidc') {
        const meResponse = await fetchWithTimeout('/api/auth/me', { credentials: 'same-origin' });
        if (meResponse.ok) {
          const meData = await meResponse.json();
          finishAuthenticatedSession(meData);
          return;
        }
        redirectToLogin();
        return;
      }

      if (await checkLegacyToken()) {
        return;
      }

      showAdminAuthGate({
        title: 'Legacy fallback access',
        message: 'Platform Admin requires hosted sign-in in production. Use the API secret only on internal environments.',
        showSignIn: false,
      });
    } catch (error) {
      const timedOut = Boolean(
        error && typeof error === 'object' && 'name' in error && error.name === 'AbortError',
      );
      console.warn('Platform admin auth check failed:', error);
      showAdminAuthGate({
        title: timedOut ? 'Sign-in check timed out' : 'Could not verify sign-in',
        message: timedOut
          ? 'Ditto could not reach the auth service in time. Sign in to open Platform Admin.'
          : 'Ditto could not confirm your session. Sign in to open Platform Admin.',
      });
    }
  })();
})();
