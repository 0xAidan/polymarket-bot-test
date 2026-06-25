/**
 * Ditto landing — hero showcase autoplay + Jungle Agents preview loader.
 */
(() => {
  const SHOWCASE_TABS = ['dashboard', 'copy-list', 'jungle-agents'];

  const RADIO_BY_TAB = {
    dashboard: 'showcase-radio-dashboard',
    'copy-list': 'showcase-radio-copy-list',
    'jungle-agents': 'showcase-radio-jungle-agents',
  };

  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const buildAgentTagline = (agent) => {
    const parts = [agent.category, agent.tagline || agent.modelLabel].filter(Boolean);
    return parts.join(' · ') || 'Curated trader';
  };

  const renderAgentAvatar = (agent) => {
    const initial = escapeHtml((agent.displayName || '?').charAt(0).toUpperCase());
    if (agent.avatarUrl) {
      return `<img src="${escapeHtml(agent.avatarUrl)}" alt="" class="l-preview-avatar-img" loading="lazy" decoding="async">`;
    }
    return `<span class="l-preview-avatar">${initial}</span>`;
  };

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

  const loadShowcaseAgentStats = async (agents) => {
    await Promise.all(agents.map(async (agent) => {
      if (!agent.id || agent.addressPending || !agent.polymarketAddress) return;
      const card = document.querySelector(`[data-showcase-agent-id="${agent.id}"]`);
      if (!card) return;

      try {
        const res = await fetch(`/api/public/jungle-agents/${encodeURIComponent(agent.id)}/performance`);
        const perf = await res.json();
        if (!res.ok || perf.success === false) return;

        const pnlEl = card.querySelector('[data-stat="pnl"]');
        const winEl = card.querySelector('[data-stat="win"]');
        const roiEl = card.querySelector('[data-stat="roi"]');
        if (pnlEl) pnlEl.textContent = formatCompactSignedUsd(perf.lifetimePnlUsd);
        if (winEl) winEl.textContent = formatWinRate(perf.winRatePct);
        if (roiEl) roiEl.textContent = formatSignedPercent(perf.roiPct);
      } catch {
        /* keep placeholder stats */
      }
    }));
  };

  const renderLandingShowcaseAgents = (agents) => {
    const grid = document.getElementById('showcaseJungleAgents');
    if (!grid) return false;

    const showcaseAgents = (agents || [])
      .filter((agent) => !agent.addressPending && agent.polymarketAddress)
      .slice(0, 6);

    if (!showcaseAgents.length) {
      grid.innerHTML = '<p class="l-preview-agents-status">Sign up to browse the full trader roster.</p>';
      grid.dataset.showcaseLoaded = 'true';
      return true;
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

    grid.dataset.showcaseLoaded = 'true';
    void loadShowcaseAgentStats(showcaseAgents);
    return true;
  };

  let showcaseAgentsPromise;

  const ensureLandingShowcaseAgents = async () => {
    const grid = document.getElementById('showcaseJungleAgents');
    if (!grid || grid.dataset.showcaseLoaded === 'true') return;
    if (!showcaseAgentsPromise) {
      showcaseAgentsPromise = (async () => {
        try {
          const res = await fetch('/api/public/landing-preview');
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || 'preview failed');
          }
          renderLandingShowcaseAgents(data.agents || []);
        } catch {
          grid.innerHTML = '<p class="l-preview-agents-status">Could not load traders preview.</p>';
          grid.dataset.showcaseLoaded = 'error';
        }
      })();
    }
    await showcaseAgentsPromise;
  };

  window.renderLandingShowcaseAgents = renderLandingShowcaseAgents;
  window.ensureLandingShowcaseAgents = ensureLandingShowcaseAgents;

  const selectShowcaseTab = (tabId) => {
    const radioId = RADIO_BY_TAB[tabId];
    if (!radioId) return false;
    const radio = document.getElementById(radioId);
    if (!(radio instanceof HTMLInputElement) || radio.type !== 'radio') return false;
    radio.checked = true;
    if (tabId === 'jungle-agents') {
      void ensureLandingShowcaseAgents();
    }
    return true;
  };

  const initLandingShowcase = () => {
    const root = document.querySelector('.landing-hero-showcase');
    if (!root) return;

    void ensureLandingShowcaseAgents();

    let activeIndex = 0;
    let autoplayId;

    const startAutoplay = () => {
      if (prefersReducedMotion() || autoplayId) return;

      autoplayId = window.setInterval(() => {
        if (root.matches(':hover') || root.matches(':focus-within')) return;
        activeIndex = (activeIndex + 1) % SHOWCASE_TABS.length;
        selectShowcaseTab(SHOWCASE_TABS[activeIndex]);
      }, 6000);
    };

    const stopAutoplay = () => {
      if (!autoplayId) return;
      window.clearInterval(autoplayId);
      autoplayId = undefined;
    };

    root.querySelectorAll('[data-showcase-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const tabId = tab.dataset.showcaseTab;
        if (!tabId) return;
        const nextIndex = SHOWCASE_TABS.indexOf(tabId);
        if (nextIndex >= 0) activeIndex = nextIndex;
        if (tabId === 'jungle-agents') {
          void ensureLandingShowcaseAgents();
        }
      });
    });

    root.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.classList.contains('landing-showcase-radio')) return;
      const tabId = SHOWCASE_TABS.find((id) => RADIO_BY_TAB[id] === target.id);
      if (!tabId) return;
      const nextIndex = SHOWCASE_TABS.indexOf(tabId);
      if (nextIndex >= 0) activeIndex = nextIndex;
      if (tabId === 'jungle-agents') {
        void ensureLandingShowcaseAgents();
      }
    });

    root.addEventListener('mouseenter', stopAutoplay);
    root.addEventListener('mouseleave', startAutoplay);

    startAutoplay();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLandingShowcase);
  } else {
    initLandingShowcase();
  }
})();
