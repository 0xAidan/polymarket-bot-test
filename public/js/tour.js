/**
 * CopyTrade95 walkthrough tour — overlay-only, no data replacement.
 * Entry: Help → Start walkthrough. Requires switchTab from app.js.
 */
(function () {
  'use strict';

  const TOUR_ENABLED = true;

  const STEPS = [
    {
      tab: 'dashboard',
      target: '.win-tabs',
      title: 'Welcome to CopyTrade95',
      body: "Intro; we'll walk through each tab and point out key and easy-to-miss features."
    },
    {
      tab: 'dashboard',
      target: '.wallet-info-bar',
      title: 'Dashboard — overview',
      body: 'Wallet and balance at top; metrics; trade history — click a row for full details.'
    },
    {
      tab: 'dashboard',
      target: '[data-tour="ladder-exits"]',
      title: 'Ladder Exits (take-profit)',
      body: 'Sell positions in steps as price rises. + New Ladder; Paper Mode ? explains safe testing.'
    },
    {
      tab: 'wallets',
      target: '#tab-wallets',
      title: 'Tracked Wallets',
      body: 'Add addresses to copy from. Configure per wallet (size, filters). Mirror to copy positions.'
    },
    {
      tab: 'trading-wallets',
      target: '#unlockSection',
      title: 'Trading Wallets',
      body: 'Your trading wallets hold USDC. Create password or unlock; add wallet + Builder API credentials.'
    },
    {
      tab: 'trading-wallets',
      target: '#copyAssignmentsList',
      title: 'Copy Assignments',
      body: 'Map tracked to trading wallet (dropdowns + Assign). Per-wallet Settings (gear): auto-redeem, auto-merge.'
    },
    {
      tab: 'platforms',
      target: '#platformStatusGrid',
      title: 'Platforms',
      body: 'Poly and Kalshi status/balances. Kalshi API optional. Entity Wallet Mapping for cross-platform.'
    },
    {
      tab: 'cross-platform',
      target: '#executorMetrics',
      title: 'Cross-Platform',
      body: 'Arb and hedges across platforms. Paper Mode ?. Executor Configuration at bottom.'
    },
    {
      tab: 'settings',
      target: '#tab-settings',
      title: 'Settings',
      body: 'Stop-Loss, scan frequency. Proxy Wallet for balance display.'
    },
    {
      tab: 'diagnostics',
      target: '#tab-diagnostics',
      title: 'Diagnostics',
      body: 'CLOB test, Failed Trades Analysis, System Issues Log.'
    },
    {
      tab: 'dashboard',
      target: '.win-statusbar',
      title: "You're all set",
      body: "Taskbar: Start/Stop bot. Status bar: POLY/KALSHI, mode. Re-open from Help → Start walkthrough."
    }
  ];

  let overlayEl = null;
  let spotlightEl = null;
  let cardEl = null;
  let backBtn = null;
  let nextBtn = null;
  let currentIndex = 0;
  let handleKeydown = null;
  let handleResize = null;

  function positionSpotlight(selector) {
    if (!spotlightEl) return;
    const el = document.querySelector(selector);
    if (!el) {
      spotlightEl.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    spotlightEl.style.display = 'block';
    spotlightEl.style.position = 'fixed';
    spotlightEl.style.left = rect.left + 'px';
    spotlightEl.style.top = rect.top + 'px';
    spotlightEl.style.width = rect.width + 'px';
    spotlightEl.style.height = rect.height + 'px';
  }

  function updateCard(step) {
    if (!cardEl) return;
    const titleEl = cardEl.querySelector('.tour-card-title');
    const bodyEl = cardEl.querySelector('.tour-card-description');
    if (titleEl) titleEl.textContent = step.title;
    if (bodyEl) bodyEl.textContent = step.body;
  }

  function updateButtons() {
    if (!backBtn || !nextBtn) return;
    const step = STEPS[currentIndex];
    backBtn.disabled = currentIndex === 0;
    const isLast = currentIndex === STEPS.length - 1;
    nextBtn.textContent = isLast ? 'Finish' : 'Next';
  }

  function goToStep(index) {
    if (index < 0 || index >= STEPS.length) return;
    currentIndex = index;
    const step = STEPS[currentIndex];

    if (typeof switchTab === 'function') {
      switchTab(step.tab);
    }

    positionSpotlight(step.target);
    updateCard(step);
    updateButtons();
  }

  function endTour() {
    if (handleKeydown) {
      document.removeEventListener('keydown', handleKeydown);
      handleKeydown = null;
    }
    if (handleResize) {
      window.removeEventListener('resize', handleResize);
      handleResize = null;
    }
    if (overlayEl && overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    overlayEl = null;
    spotlightEl = null;
    cardEl = null;
    backBtn = null;
    nextBtn = null;
  }

  function startTour() {
    if (!TOUR_ENABLED) return;

    const overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Walkthrough tour');

    const backdrop = document.createElement('div');
    backdrop.className = 'tour-backdrop';

    const spotlight = document.createElement('div');
    spotlight.className = 'tour-spotlight';

    const card = document.createElement('div');
    card.className = 'tour-card';
    card.innerHTML =
      '<div class="tour-card-title"></div>' +
      '<div class="tour-card-description"></div>' +
      '<div class="tour-card-actions">' +
      '<button type="button" class="tour-btn tour-btn-back" aria-label="Previous step">Back</button>' +
      '<button type="button" class="tour-btn tour-btn-next" aria-label="Next step">Next</button>' +
      '<button type="button" class="tour-btn tour-btn-skip" aria-label="Skip tour">Skip</button>' +
      '</div>';

    overlay.appendChild(backdrop);
    overlay.appendChild(spotlight);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    overlayEl = overlay;
    spotlightEl = spotlight;
    cardEl = card;
    backBtn = card.querySelector('.tour-btn-back');
    nextBtn = card.querySelector('.tour-btn-next');
    const skipBtn = card.querySelector('.tour-btn-skip');

    currentIndex = 0;
    goToStep(0);

    const handleBack = () => {
      if (currentIndex > 0) goToStep(currentIndex - 1);
    };

    const handleNext = () => {
      if (currentIndex === STEPS.length - 1) {
        endTour();
      } else {
        goToStep(currentIndex + 1);
      }
    };

    backBtn.addEventListener('click', handleBack);
    nextBtn.addEventListener('click', handleNext);
    skipBtn.addEventListener('click', endTour);

    handleKeydown = (e) => {
      if (e.key === 'Escape') endTour();
    };
    document.addEventListener('keydown', handleKeydown);

    handleResize = () => {
      if (currentIndex >= 0 && currentIndex < STEPS.length) {
        positionSpotlight(STEPS[currentIndex].target);
      }
    };
    window.addEventListener('resize', handleResize);
  }

  window.startTour = startTour;
})();
