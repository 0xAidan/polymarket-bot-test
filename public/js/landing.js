/**
 * Ditto landing page — auth handoff, roster preview, session check.
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

const showHandoffOverlay = () => {
  const overlay = document.getElementById('authHandoffOverlay');
  if (overlay) {
    overlay.classList.add('is-active');
    overlay.setAttribute('aria-hidden', 'false');
  }
};

const buildOidcLoginUrl = (mode) => {
  const returnTo = encodeURIComponent(getReturnTo());
  const params = new URLSearchParams({ returnTo });
  if (mode === 'signup') {
    params.set('screen_hint', 'signup');
  }
  return `/auth/login?${params.toString()}`;
};

window.handoffToOidc = (mode) => {
  const resolvedMode = mode === 'signup' ? 'signup' : 'login';
  showHandoffOverlay();
  const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
  window.setTimeout(() => {
    window.location.href = buildOidcLoginUrl(resolvedMode);
  }, delay);
};

const setAuthPanelMode = (mode) => {
  const resolvedMode = mode === 'signup' ? 'signup' : 'login';
  const copy = AUTH_COPY[resolvedMode];
  const titleEl = document.getElementById('authPanelTitle');
  const bodyEl = document.getElementById('authPanelBody');
  const continueBtn = document.getElementById('authPanelContinue');
  const loginTab = document.getElementById('authTabLogin');
  const signupTab = document.getElementById('authTabSignup');

  if (titleEl) titleEl.textContent = copy.title;
  if (bodyEl) bodyEl.textContent = copy.description;
  if (continueBtn) continueBtn.textContent = copy.button;

  if (loginTab) loginTab.setAttribute('aria-selected', resolvedMode === 'login' ? 'true' : 'false');
  if (signupTab) signupTab.setAttribute('aria-selected', resolvedMode === 'signup' ? 'true' : 'false');

  window.__landingAuthMode = resolvedMode;
};

window.scrollToGetStarted = (mode) => {
  if (mode) {
    setAuthPanelMode(mode);
  }
  const section = document.getElementById('get-started');
  if (section) {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

const handleNavAuthClick = (mode) => (event) => {
  event.preventDefault();
  scrollToGetStarted(mode);
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const renderRosterSkeleton = () => {
  const roster = document.getElementById('landingRoster');
  if (!roster) return;
  roster.innerHTML = Array.from({ length: 4 }, () => (
    '<div class="landing-roster-card"><span class="j-skeleton j-skeleton-line"></span></div>'
  )).join('');
};

const renderRoster = (agents) => {
  const roster = document.getElementById('landingRoster');
  if (!roster) return;

  if (!agents.length) {
    roster.innerHTML = '<p class="landing-section-lead">Browse Jungle Agents here — or add any Polymarket wallet address after you sign in.</p>';
    return;
  }

  roster.innerHTML = agents.map((agent) => {
    const initial = escapeHtml((agent.displayName || '?').charAt(0).toUpperCase());
    const name = escapeHtml(agent.displayName || 'Agent');
    const tagline = escapeHtml(agent.tagline || agent.category || 'Polymarket trader');
    const avatar = agent.avatarUrl
      ? `<img src="${escapeHtml(agent.avatarUrl)}" alt="" loading="lazy">`
      : initial;
    return `
      <article class="landing-roster-card glow-border">
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

const loadLandingPreview = async () => {
  renderRosterSkeleton();
  try {
    const res = await fetch('/api/public/landing-preview');
    const data = await res.json();
    if (!res.ok || !data.success) {
      renderRoster([]);
      return;
    }

    renderRoster(data.agents || []);

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
    renderRoster([]);
  }
};

const checkAuthenticatedSession = async () => {
  try {
    const requiredRes = await fetch('/api/auth/required', { credentials: 'same-origin' });
    const required = await requiredRes.json();
    if (!required.required || required.mode !== 'oidc') {
      return;
    }

    const capRes = await fetch('/api/auth/capabilities', { credentials: 'same-origin' });
    if (!capRes.ok) return;
    const cap = await capRes.json();
    if (cap.authenticated) {
      window.location.replace(getReturnTo());
    }
  } catch {
    /* stay on landing */
  }
};

const initLandingFromQuery = () => {
  const params = getQueryParams();
  const mode = getAuthMode();
  setAuthPanelMode(mode);

  if (params.get('section') === 'get-started' || params.has('mode')) {
    window.requestAnimationFrame(() => {
      scrollToGetStarted(mode);
    });
  }
};

const wireLandingUi = () => {
  document.getElementById('navLogin')?.addEventListener('click', handleNavAuthClick('login'));
  document.getElementById('navSignup')?.addEventListener('click', handleNavAuthClick('signup'));
  document.getElementById('heroLogin')?.addEventListener('click', handleNavAuthClick('login'));
  document.getElementById('heroSignup')?.addEventListener('click', handleNavAuthClick('signup'));
  document.getElementById('ctaSignup')?.addEventListener('click', handleNavAuthClick('signup'));

  document.getElementById('authTabLogin')?.addEventListener('click', () => setAuthPanelMode('login'));
  document.getElementById('authTabSignup')?.addEventListener('click', () => setAuthPanelMode('signup'));

  document.getElementById('authPanelContinue')?.addEventListener('click', () => {
    handoffToOidc(window.__landingAuthMode || 'login');
  });
};

document.addEventListener('DOMContentLoaded', () => {
  wireLandingUi();
  initLandingFromQuery();
  loadLandingPreview();
  checkAuthenticatedSession();
});
