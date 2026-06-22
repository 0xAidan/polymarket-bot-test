/**
 * Ditto walkthrough tour — overlay-only, no data replacement.
 * Entry: Help → Start walkthrough. Requires switchTab from app.js.
 */
(function () {
  'use strict';

  const TOUR_ENABLED = true;

  const STEPS = [
    {
      tab: 'dashboard',
      target: '.jw-tabs',
      title: 'Ditto at a glance',
      body: 'This tour covers setup, wallets, discovery, and controls — the parts you’ll use every day.'
    },
    {
      tab: 'dashboard',
      target: '.j-dash-top-aside',
      title: 'Home',
      body: 'Setup progress, your trading wallet balance, and quick actions — all in one compact bar.'
    },
    {
      tab: 'dashboard',
      target: '#setupProgressChecklist',
      title: 'Setup Progress',
      body: 'This checklist shows what’s still missing before Ditto is ready to run.'
    },
    {
      tab: 'dashboard',
      target: '.j-dash-wallet-card',
      title: 'Trading wallet',
      body: 'Your live balance and wallet address appear here once you connect a trading wallet.'
    },
    {
      tab: 'dashboard',
      target: '.j-trade-panel',
      title: 'Trade History',
      body: 'Recent copy attempts from wallets on your copy list. Click any row for full trade details.'
    },
    {
      tab: 'dashboard',
      target: '[data-tour="ladder-exits"]',
      title: 'Ladder Exits (take-profit)',
      body: 'Sell positions in steps as price rises. + New Ladder; Paper Mode ? explains safe testing.',
      adminOnly: true,
    },
    {
      tab: 'wallets',
      target: '#tab-wallets',
      title: 'Copy List',
      body: 'Wallets you copy on Polymarket. Click Copy on a Jungle Agent or add an address — setup opens automatically.'
    },
    {
      tab: 'trading-wallets',
      target: '#tab-trading-wallets',
      title: 'My Wallets',
      body: 'Your wallets execute copied trades. Add builder credentials here first.'
    },
    {
      tab: 'trading-wallets',
      target: '#copyAssignmentsList',
      title: 'Copy Assignments',
      body: 'Map each copy source to the trading wallet that executes its trades. Per-wallet Settings (gear): auto-redeem, auto-merge.'
    },
    {
      tab: 'discovery',
      target: '#tab-discovery',
      title: 'Discovery',
      body: 'Discovery helps you find promising wallets to copy next. It is useful, but it should not get in the way of basic setup.',
      adminOnly: true,
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
      target: '.jw-statusbar',
      title: "You're all set",
      body: "Use Start Copying when your setup is complete. Re-open the setup guide or tour any time from the top bar."
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

  const getTourSteps = () => {
    const isAdmin = !!window.__isPlatformAdmin;
    return STEPS.filter((step) => !step.adminOnly || isAdmin);
  };

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
    const steps = getTourSteps();
    const step = steps[currentIndex];
    backBtn.disabled = currentIndex === 0;
    const isLast = currentIndex === steps.length - 1;
    nextBtn.textContent = isLast ? 'Finish' : 'Next';
  }

  function goToStep(index) {
    const steps = getTourSteps();
    if (index < 0 || index >= steps.length) return;
    currentIndex = index;
    const step = steps[currentIndex];

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
      const steps = getTourSteps();
      if (currentIndex === steps.length - 1) {
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
      const steps = getTourSteps();
      if (currentIndex >= 0 && currentIndex < steps.length) {
        positionSpotlight(steps[currentIndex].target);
      }
    };
    window.addEventListener('resize', handleResize);
  }

  window.startTour = startTour;
})();
