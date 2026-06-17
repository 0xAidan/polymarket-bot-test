/**
 * Ditto onboarding tutorial — ENGINE.
 *
 * Renders the guided, step-by-step setup walkthrough defined in
 * onboarding-steps.js: centered card with numbered actions, progress bar,
 * spotlighted UI targets, live "Detected" completion badges, and progress
 * persistence (resume where you left off).
 *
 * Entry points:
 *   - Auto-launches on first login (no saved progress + no trading wallet yet)
 *   - window.startOnboarding(true) — "Tutorial" button in the topbar (replay)
 */
(function () {
  'use strict';

  const STORAGE_PREFIX = 'ditto_onboarding_v1';
  const CHECK_POLL_MS = 3000;

  let overlayEl = null;
  let cardEl = null;
  let spotlightEl = null;
  let currentIndex = 0;
  let checkTimer = null;
  let keydownHandler = null;
  let resizeHandler = null;

  /* ── Live completion checks ─────────────────────────────────────────────
     Each returns true (done), false (not yet) or null (unknown / API error).
     Checks NEVER block navigation — they only power the "Detected" badge. */
  const CHECKS = {
    tradingWalletExists: async () => {
      const data = await API.getTradingWallets();
      const wallets = data.wallets || data.tradingWallets || [];
      return wallets.length > 0;
    },
    tradingWalletHasCredentials: async () => {
      const data = await API.getTradingWallets();
      const wallets = data.wallets || data.tradingWallets || [];
      return wallets.some((w) => w.hasCredentials);
    },
    walletFunded: async () => {
      const data = await API.get('/wallet/balance');
      const balance = parseFloat(data.currentBalance ?? data.balance ?? data.usdcBalance ?? '0');
      return Number.isFinite(balance) && balance > 0;
    },
    botRunning: async () => {
      const data = await API.getStatus();
      return !!data.running;
    }
  };

  const getSteps = () => {
    const base = window.DITTO_ONBOARDING_STEPS || [];
    if (!window.__hostedMultiTenant) return base;
    return base.map((step) => {
      if (step.id !== 'add-key-to-bot') return step;
      return {
        ...step,
        actions: [
          'Open the Trading Wallets tab, paste your private key, and name the wallet',
          'In hosted Ditto your key is encrypted when you sign in — no vault password',
          'When the wallet appears in your list, you\'ll see a green Detected badge',
        ],
      };
    });
  };

  /* ── Progress persistence (per workspace) ─────────────────────────────── */
  const storageKey = () => {
    let tenant = 'default';
    try {
      tenant = (typeof API !== 'undefined' && API.getTenantId && API.getTenantId()) || 'default';
    } catch { /* default */ }
    return `${STORAGE_PREFIX}::${tenant}`;
  };

  const loadProgress = () => {
    try {
      const raw = localStorage.getItem(storageKey());
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const saveProgress = (patch) => {
    try {
      const next = { ...(loadProgress() || {}), ...patch, updatedAt: Date.now() };
      localStorage.setItem(storageKey(), JSON.stringify(next));
    } catch { /* private mode etc. — non-fatal */ }
  };

  /* ── Rendering ──────────────────────────────────────────────────────── */
  const renderActionList = (actions) => {
    const items = (actions || []).map((action) => '<li>' + action + '</li>').join('');
    return '<ol class="onb-action-list">' + items + '</ol>';
  };

  const positionSpotlight = (selector) => {
    if (!spotlightEl) return;
    const el = selector ? document.querySelector(selector) : null;
    if (!el) {
      spotlightEl.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    spotlightEl.style.display = 'block';
    spotlightEl.style.left = rect.left + 'px';
    spotlightEl.style.top = rect.top + 'px';
    spotlightEl.style.width = rect.width + 'px';
    spotlightEl.style.height = rect.height + 'px';
  };

  const stopCheckPolling = () => {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
  };

  const runCompletionCheck = async (step) => {
    const badge = cardEl && cardEl.querySelector('.onb-detected');
    if (!badge) return;
    const checker = step.completionCheck && CHECKS[step.completionCheck];
    if (!checker) {
      badge.className = 'onb-detected hidden';
      return;
    }
    try {
      const done = await checker();
      if (done === true) {
        badge.className = 'onb-detected onb-detected-yes';
        badge.textContent = '✓ Detected — this step is complete';
      } else {
        badge.className = 'onb-detected onb-detected-waiting';
        badge.textContent = 'Watching for this step to complete…';
      }
    } catch {
      // API unreachable — hide rather than alarm the user.
      badge.className = 'onb-detected hidden';
    }
  };

  const renderStep = () => {
    const steps = getSteps();
    const step = steps[currentIndex];
    if (!step || !cardEl) return;

    if (step.tab && typeof switchTab === 'function') {
      try { switchTab(step.tab); } catch { /* tab may not exist */ }
    }

    const pct = Math.round(((currentIndex + 1) / steps.length) * 100);
    cardEl.innerHTML =
      '<div class="onb-progress"><div class="onb-progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="onb-step-count">Step ' + (currentIndex + 1) + ' of ' + steps.length + '</div>' +
      '<h2 class="onb-title">' + step.title + '</h2>' +
      renderActionList(step.actions) +
      '<div class="onb-detected hidden" role="status"></div>' +
      '<div class="onb-actions">' +
      '<button type="button" class="onb-btn onb-btn-skip">Skip tutorial</button>' +
      '<span class="onb-actions-spacer"></span>' +
      '<button type="button" class="onb-btn onb-btn-back"' + (currentIndex === 0 ? ' disabled' : '') + '>Back</button>' +
      '<button type="button" class="onb-btn onb-btn-next">' +
      (currentIndex === steps.length - 1 ? 'Finish' : 'Next') +
      '</button>' +
      '</div>';

    cardEl.querySelector('.onb-btn-back').addEventListener('click', () => goTo(currentIndex - 1));
    cardEl.querySelector('.onb-btn-next').addEventListener('click', () => {
      if (currentIndex === steps.length - 1) {
        finish(true);
      } else {
        goTo(currentIndex + 1);
      }
    });
    cardEl.querySelector('.onb-btn-skip').addEventListener('click', () => finish(false));

    // Give the tab switch a beat to paint before measuring the spotlight target.
    setTimeout(() => positionSpotlight(step.target), 120);

    stopCheckPolling();
    runCompletionCheck(step);
    if (step.completionCheck) {
      checkTimer = setInterval(() => runCompletionCheck(step), CHECK_POLL_MS);
    }
  };

  const goTo = (index) => {
    const steps = getSteps();
    if (index < 0 || index >= steps.length) return;
    currentIndex = index;
    saveProgress({ lastStep: index, completed: false, skipped: false });
    renderStep();
  };

  const finish = (completed) => {
    saveProgress(completed ? { completed: true, skipped: false } : { skipped: true, completed: false });
    teardown();
  };

  const teardown = () => {
    stopCheckPolling();
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler);
      keydownHandler = null;
    }
    if (resizeHandler) {
      window.removeEventListener('resize', resizeHandler);
      resizeHandler = null;
    }
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
    cardEl = null;
    spotlightEl = null;
  };

  /**
   * Start (or resume) the onboarding tutorial.
   * @param {boolean} replay  true = manual launch; always starts even if finished
   */
  const startOnboarding = (replay = false) => {
    if (overlayEl) return; // already open

    const progress = loadProgress();
    if (!replay && progress && (progress.completed || progress.skipped)) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'onb-overlay';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.setAttribute('aria-label', 'Setup tutorial');

    const backdrop = document.createElement('div');
    backdrop.className = 'onb-backdrop';

    spotlightEl = document.createElement('div');
    spotlightEl.className = 'onb-spotlight';

    cardEl = document.createElement('div');
    cardEl.className = 'onb-card';

    overlayEl.appendChild(backdrop);
    overlayEl.appendChild(spotlightEl);
    overlayEl.appendChild(cardEl);
    document.body.appendChild(overlayEl);

    // Resume where the user left off (replay restarts from the beginning).
    currentIndex = !replay && progress && Number.isInteger(progress.lastStep)
      ? Math.min(Math.max(progress.lastStep, 0), getSteps().length - 1)
      : 0;

    keydownHandler = (e) => {
      if (e.key === 'Escape') finish(false);
    };
    document.addEventListener('keydown', keydownHandler);

    resizeHandler = () => {
      const step = getSteps()[currentIndex];
      if (step) positionSpotlight(step.target);
    };
    window.addEventListener('resize', resizeHandler);

    renderStep();
  };

  /* ── Auto-launch on first login ─────────────────────────────────────────
     Waits for the app shell to be ready, then launches only when this
     workspace has never seen the tutorial AND has no trading wallet yet. */
  const maybeAutoLaunch = async () => {
    const progress = loadProgress();
    if (progress) {
      // Finished or explicitly skipped: never auto-launch again.
      if (progress.completed || progress.skipped) return;
      // Started but interrupted (e.g. closed the tab): resume where they left off.
      startOnboarding(false);
      return;
    }
    try {
      const data = await API.getTradingWallets();
      const wallets = data.wallets || data.tradingWallets || [];
      if (wallets.length === 0) startOnboarding(false);
    } catch { /* not authenticated or API down — skip quietly */ }
  };

  const waitForAppReady = (timeoutMs = 30000) => {
    const startedAt = Date.now();
    const tick = () => {
      if (document.body.classList.contains('app-ready')) {
        maybeAutoLaunch();
        return;
      }
      if (Date.now() - startedAt < timeoutMs) setTimeout(tick, 500);
    };
    tick();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => waitForAppReady());
  } else {
    waitForAppReady();
  }

  window.startOnboarding = startOnboarding;
})();
