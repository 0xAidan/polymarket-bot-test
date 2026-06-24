/**
 * Ditto landing page — composed controllers for auth, roster, and session guard.
 */

const AUTH_COPY = {
  login: {
    title: 'Log in to Ditto',
    description: 'Follow Jungle Agents or paste any Polymarket wallet address into your copy list.',
    button: 'Continue',
  },
  signup: {
    title: 'Create your Ditto account',
    description: 'Start with curated agents — or add any wallet address you want to mirror.',
    button: 'Create account',
  },
};

const getQueryParams = () => new URLSearchParams(window.location.search);

const getReturnTo = () => {
  const fromQuery = getQueryParams().get('returnTo');
  if (fromQuery && fromQuery.startsWith('/')) {
    return fromQuery;
  }
  return '/app';
};

const getAuthMode = () => {
  const mode = getQueryParams().get('mode');
  return mode === 'signup' ? 'signup' : 'login';
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const createAuthPanelController = () => {
  const elements = {
    title: document.getElementById('authPanelTitle'),
    body: document.getElementById('authPanelBody'),
    continueBtn: document.getElementById('authPanelContinue'),
    loginTab: document.getElementById('authTabLogin'),
    signupTab: document.getElementById('authTabSignup'),
    overlay: document.getElementById('authHandoffOverlay'),
  };

  let mode = 'login';

  const applyMode = (nextMode) => {
    const resolvedMode = nextMode === 'signup' ? 'signup' : 'login';
    const copy = AUTH_COPY[resolvedMode];
    mode = resolvedMode;

    const update = () => {
      if (elements.title) elements.title.textContent = copy.title;
      if (elements.body) elements.body.textContent = copy.description;
      if (elements.continueBtn) elements.continueBtn.textContent = copy.button;
      if (elements.loginTab) {
        elements.loginTab.setAttribute('aria-selected', resolvedMode === 'login' ? 'true' : 'false');
      }
      if (elements.signupTab) {
        elements.signupTab.setAttribute('aria-selected', resolvedMode === 'signup' ? 'true' : 'false');
      }
    };

    if (typeof window.landingWithViewTransition === 'function') {
      window.landingWithViewTransition(update);
    } else {
      update();
    }
  };

  const showHandoffOverlay = () => {
    if (!elements.overlay) return;
    elements.overlay.classList.add('is-active');
    elements.overlay.setAttribute('aria-hidden', 'false');
  };

  const buildOidcLoginUrl = (resolvedMode) => {
    const returnTo = encodeURIComponent(getReturnTo());
    const params = new URLSearchParams({ returnTo });
    if (resolvedMode === 'signup') {
      params.set('screen_hint', 'signup');
    }
    return `/auth/login?${params.toString()}`;
  };

  const handoffToOidc = (nextMode) => {
    const resolvedMode = nextMode === 'signup' ? 'signup' : 'login';
    showHandoffOverlay();
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
    window.setTimeout(() => {
      window.location.href = buildOidcLoginUrl(resolvedMode);
    }, delay);
  };

  const scrollToGetStarted = (nextMode) => {
    if (nextMode) {
      applyMode(nextMode);
    }
    const section = document.getElementById('get-started');
    if (section) {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return {
    getMode: () => mode,
    setMode: applyMode,
    scrollToGetStarted,
    handoffToOidc,
  };
};

const createRosterPresenter = () => {
  const roster = document.getElementById('landingRoster');

  const renderSkeleton = () => {
    if (!roster) return;
    roster.innerHTML = Array.from({ length: 4 }, () => (
      '<div class="landing-roster-card"><span class="j-skeleton j-skeleton-line"></span></div>'
    )).join('');
  };

  const renderAgents = (agents) => {
    if (!roster) return;

    const update = () => {
      if (!agents.length) {
        roster.innerHTML = '<p class="landing-section-lead">Browse Jungle Agents here — or add any Polymarket wallet address after you sign in.</p>';
        return;
      }

      roster.innerHTML = agents.map((agent) => {
        const initial = escapeHtml((agent.displayName || '?').charAt(0).toUpperCase());
        const name = escapeHtml(agent.displayName || 'Agent');
        const tagline = escapeHtml(agent.tagline || agent.category || 'Polymarket trader');
        const avatar = agent.avatarUrl
          ? `<img src="${escapeHtml(agent.avatarUrl)}" alt="" loading="lazy" decoding="async">`
          : initial;
        return `
          <article class="landing-roster-card glow-border" role="listitem">
            <div class="landing-roster-card-top">
              <div class="landing-roster-avatar" aria-hidden="true">${avatar}</div>
              <div>
                <div class="landing-roster-name">${name}</div>
              </div>
              <span class="landing-roster-live pulse-dot" title="Live on Polymarket" aria-hidden="true"></span>
            </div>
            <p class="landing-roster-tagline">${tagline}</p>
          </article>
        `;
      }).join('');
    };

    if (typeof window.landingWithViewTransition === 'function') {
      window.landingWithViewTransition(update);
    } else {
      update();
    }
  };

  const animateStat = (el, target) => {
    if (!el) return;
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced || !Number.isFinite(target)) {
      el.textContent = String(target);
      return;
    }
    const duration = 900;
    const start = performance.now();
    const from = 0;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const value = Math.round(from + (target - from) * t);
      el.textContent = String(value);
      if (t < 1) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  };

  const loadPreview = async () => {
    renderSkeleton();
    try {
      const res = await fetch('/api/public/landing-preview');
      const data = await res.json();
      if (!res.ok || !data.success) {
        renderAgents([]);
        return;
      }

      renderAgents(data.agents || []);

      const totalEl = document.getElementById('statAgents');
      const labelEl = document.getElementById('statAgentsLabel');
      const meta = data.meta || {};
      if (totalEl && typeof meta.totalEnabled === 'number' && meta.totalEnabled > 0) {
        animateStat(totalEl, meta.totalEnabled);
        if (labelEl) {
          labelEl.textContent = meta.totalEnabled === 1
            ? 'curated agent — add any wallet too'
            : 'curated agents — add any wallet too';
        }
      }
    } catch {
      renderAgents([]);
    }
  };

  return { loadPreview };
};

const createSessionGuard = () => {
  const check = async () => {
    try {
      const [requiredRes, capRes] = await Promise.all([
        fetch('/api/auth/required', { credentials: 'same-origin' }),
        fetch('/api/auth/capabilities', { credentials: 'same-origin' }),
      ]);

      const required = await requiredRes.json();
      if (!required.required || required.mode !== 'oidc') {
        return;
      }

      if (!capRes.ok) return;
      const cap = await capRes.json();
      if (cap.authenticated) {
        window.location.replace(getReturnTo());
      }
    } catch {
      /* stay on landing */
    }
  };

  const schedule = () => {
    const run = () => { void check(); };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 2000 });
    } else {
      window.setTimeout(run, 0);
    }
  };

  return { schedule };
};

const wireLandingUi = (authPanel) => {
  const main = document.getElementById('main-content');
  if (!main) return;

  const authActions = {
    'nav-login': () => authPanel.scrollToGetStarted('login'),
    'nav-signup': () => authPanel.scrollToGetStarted('signup'),
    'hero-login': () => authPanel.scrollToGetStarted('login'),
    'hero-signup': () => authPanel.scrollToGetStarted('signup'),
    'cta-signup': () => authPanel.scrollToGetStarted('signup'),
    'auth-tab-login': () => authPanel.setMode('login'),
    'auth-tab-signup': () => authPanel.setMode('signup'),
    'auth-continue': () => authPanel.handoffToOidc(authPanel.getMode()),
  };

  main.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const actionEl = target.closest('[data-landing-action]');
    if (!actionEl || !(actionEl instanceof HTMLElement)) return;

    const action = actionEl.dataset.landingAction;
    const handler = action ? authActions[action] : undefined;
    if (!handler) return;

    event.preventDefault();
    handler();
  });
};

const initLandingFromQuery = (authPanel) => {
  const params = getQueryParams();
  const mode = getAuthMode();
  authPanel.setMode(mode);

  if (params.get('section') === 'get-started' || params.has('mode')) {
    window.requestAnimationFrame(() => {
      authPanel.scrollToGetStarted(mode);
    });
  }
};

window.handoffToOidc = (mode) => {
  const authPanel = window.__landingAuthPanel;
  if (authPanel) {
    authPanel.handoffToOidc(mode);
  }
};

window.scrollToGetStarted = (mode) => {
  const authPanel = window.__landingAuthPanel;
  if (authPanel) {
    authPanel.scrollToGetStarted(mode);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const authPanel = createAuthPanelController();
  const roster = createRosterPresenter();
  const sessionGuard = createSessionGuard();

  window.__landingAuthPanel = authPanel;

  wireLandingUi(authPanel);
  initLandingFromQuery(authPanel);

  void roster.loadPreview();
  sessionGuard.schedule();
});
