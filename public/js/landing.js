/**
 * Ditto landing page — composed controllers for auth, roster, and session guard.
 */

const AUTH_COPY = {
  login: {
    title: 'Welcome back',
    description: 'Log in to manage your copy list, trading wallet, and copied trades.',
    button: 'Log in',
  },
  signup: {
    title: 'Start copying trades',
    description: 'Create your account, pick traders to follow, and connect your wallet.',
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

const revealGetStartedSection = () => {
  document.querySelectorAll('#get-started .landing-reveal').forEach((el) => {
    el.classList.add('is-visible');
  });
};

const getScrollBehavior = (preferred) => {
  if (preferred) return preferred;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const formatCompactSignedUsd = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1000) {
    return `${sign}$${(abs / 1000).toFixed(1)}k`;
  }
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
};

const formatWinRate = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(0)}%`;
};

const formatSignedPercent = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (n > 0) return `+${n.toFixed(0)}%`;
  if (n < 0) return `${n.toFixed(0)}%`;
  return '0%';
};

const buildAgentTagline = (agent) => {
  const parts = [agent.category, agent.tagline || agent.modelLabel].filter(Boolean);
  return parts.join(' · ') || 'Jungle Agent';
};

const renderAgentAvatar = (agent) => {
  const initial = escapeHtml((agent.displayName || '?').charAt(0).toUpperCase());
  if (agent.avatarUrl) {
    return `<img src="${escapeHtml(agent.avatarUrl)}" alt="" class="l-preview-avatar-img" loading="lazy" decoding="async">`;
  }
  return `<span class="l-preview-avatar">${initial}</span>`;
};

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

  const scrollToGetStarted = (nextMode, options = {}) => {
    if (nextMode) {
      applyMode(nextMode);
    }
    revealGetStartedSection();
    const section = document.getElementById('get-started');
    if (section) {
      section.scrollIntoView({
        behavior: getScrollBehavior(options.behavior),
        block: 'start',
      });
    }
  };

  return {
    getMode: () => mode,
    setMode: applyMode,
    scrollToGetStarted,
    handoffToOidc,
  };
};

const loadAgentPerformanceStats = async (agents, getCard) => {
  await Promise.all(agents.map(async (agent) => {
    if (!agent.id || agent.addressPending || !agent.polymarketAddress) return;
    const card = getCard(agent);
    if (!card) return;

    try {
      const res = await fetch(`/api/public/jungle-agents/${encodeURIComponent(agent.id)}/performance`);
      const perf = await res.json();
      if (!res.ok || perf.success === false) return;

      const pnlEl = card.querySelector('[data-stat="pnl"]');
      const winEl = card.querySelector('[data-stat="win"]');
      const roiEl = card.querySelector('[data-stat="roi"]');
      if (pnlEl) {
        pnlEl.textContent = formatCompactSignedUsd(perf.lifetimePnlUsd);
        const pnl = Number(perf.lifetimePnlUsd);
        pnlEl.classList.toggle('is-win', Number.isFinite(pnl) && pnl > 0);
        pnlEl.classList.toggle('is-loss', Number.isFinite(pnl) && pnl < 0);
      }
      if (winEl) winEl.textContent = formatWinRate(perf.winRatePct);
      if (roiEl) roiEl.textContent = formatSignedPercent(perf.roiPct);
    } catch {
      /* keep placeholder stats */
    }
  }));
};

const loadShowcaseAgentStats = (agents) => loadAgentPerformanceStats(
  agents,
  (agent) => document.querySelector(`[data-showcase-agent-id="${agent.id}"]`),
);

const loadRosterAgentStats = (agents) => loadAgentPerformanceStats(
  agents,
  (agent) => document.querySelector(`[data-roster-agent-id="${agent.id}"]`),
);

const createShowcaseAgentsPresenter = () => {
  const grid = document.getElementById('showcaseJungleAgents');
  if (!grid) {
    return { renderAgents: () => {} };
  }

  const renderAgents = (agents) => {
    const showcaseAgents = (agents || [])
      .filter((agent) => !agent.addressPending && agent.polymarketAddress)
      .slice(0, 6);

    if (!showcaseAgents.length) {
      grid.innerHTML = '<p class="l-preview-agents-status">Create an account to browse the full roster.</p>';
      return;
    }

    grid.innerHTML = showcaseAgents.map((agent, index) => {
      const name = escapeHtml(agent.displayName || 'Agent');
      const tag = escapeHtml(buildAgentTagline(agent));
      const avatar = renderAgentAvatar(agent);
      const pulseClass = index === 0 ? ' l-preview-trade-new' : '';
      const liveDot = index === 0
        ? '<span class="l-preview-live pulse-dot landing-showcase-live-blink" aria-hidden="true"></span>'
        : '';

      return `
        <article class="l-preview-agent glow-border${pulseClass}" data-showcase-agent-id="${escapeHtml(agent.id)}">
          <div class="l-preview-agent-top">
            ${avatar}
            <div>
              <strong>${name}</strong>
              <span class="l-preview-agent-tag">${tag}</span>
            </div>
            ${liveDot}
          </div>
          <div class="l-preview-agent-stats">
            <span><em>PnL</em> <span data-stat="pnl">…</span></span>
            <span><em>Win</em> <span data-stat="win">…</span></span>
            <span><em>ROI</em> <span data-stat="roi">…</span></span>
          </div>
        </article>
      `;
    }).join('');

    void loadShowcaseAgentStats(showcaseAgents);
  };

  return { renderAgents };
};

const createRosterPresenter = (showcaseAgents) => {
  const roster = document.getElementById('landingRoster');

  const renderSkeleton = () => {
    if (!roster) return;
    if (roster.querySelector('.landing-roster-card')) return;
    roster.innerHTML = Array.from({ length: 4 }, () => (
      '<div class="landing-roster-card"><span class="j-skeleton j-skeleton-line"></span></div>'
    )).join('');
  };

  const renderAgents = (agents) => {
    if (!roster) return;

    const update = () => {
      if (!agents.length) {
        roster.innerHTML = '<p class="landing-section-lead">Create an account to follow Jungle Agents or add any Polymarket wallet.</p>';
        return;
      }

      roster.innerHTML = agents.map((agent) => {
        const initial = escapeHtml((agent.displayName || '?').charAt(0).toUpperCase());
        const name = escapeHtml(agent.displayName || 'Agent');
        const tagline = escapeHtml(buildAgentTagline(agent));
        const avatar = agent.avatarUrl
          ? `<img src="${escapeHtml(agent.avatarUrl)}" alt="" loading="lazy" decoding="async">`
          : initial;
        return `
          <article class="landing-roster-card glow-border" role="listitem" data-roster-agent-id="${escapeHtml(agent.id)}">
            <div class="landing-roster-card-top">
              <div class="landing-roster-avatar" aria-hidden="true">${avatar}</div>
              <div>
                <div class="landing-roster-name">${name}</div>
              </div>
              <span class="landing-roster-live pulse-dot" title="Live on Polymarket" aria-hidden="true"></span>
            </div>
            <p class="landing-roster-tagline">${tagline}</p>
            <div class="landing-roster-stats" aria-label="Live Polymarket stats">
              <span><em>PnL</em> <span data-stat="pnl">…</span></span>
              <span><em>Win</em> <span data-stat="win">…</span></span>
              <span><em>ROI</em> <span data-stat="roi">…</span></span>
            </div>
          </article>
        `;
      }).join('');

      void loadRosterAgentStats(agents);
      document.dispatchEvent(new CustomEvent('landing-roster-updated'));
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
        showcaseAgents.renderAgents([]);
        return;
      }

      const agents = data.agents || [];
      renderAgents(agents);
      showcaseAgents.renderAgents(agents);

      const totalEl = document.getElementById('statAgents');
      const labelEl = document.getElementById('statAgentsLabel');
      const meta = data.meta || {};
      if (totalEl && typeof meta.totalEnabled === 'number' && meta.totalEnabled > 0) {
        animateStat(totalEl, meta.totalEnabled);
        if (labelEl) {
          labelEl.textContent = meta.totalEnabled === 1
            ? 'agent ready to follow'
            : 'agents ready to follow';
        }
      }
    } catch {
      renderAgents([]);
      showcaseAgents.renderAgents([]);
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

  if (params.get('section') === 'get-started') {
    window.requestAnimationFrame(() => {
      authPanel.scrollToGetStarted(mode, { behavior: 'auto' });
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
  const showcaseAgents = createShowcaseAgentsPresenter();
  const roster = createRosterPresenter(showcaseAgents);
  const sessionGuard = createSessionGuard();

  window.__landingAuthPanel = authPanel;

  wireLandingUi(authPanel);
  initLandingFromQuery(authPanel);

  void roster.loadPreview();
  sessionGuard.schedule();
});
