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
      target: '.win-tabs',
      title: 'Welcome to Ditto',
      body: "This walkthrough shows the core areas that matter for day-to-day use: setup, wallet management, discovery, and system controls."
    },
    {
      tab: 'dashboard',
      target: '.app-hero',
      title: 'Home',
      body: 'The home screen is your command center. Use the setup guide, quick actions, and recent activity here first.'
    },
    {
      tab: 'dashboard',
      target: '#setupProgressChecklist',
      title: 'Setup Progress',
      body: 'This checklist tells new users exactly what is still missing before Ditto is fully ready.'
    },
    {
      tab: 'dashboard',
      target: '.wallet-info-bar',
      title: 'Live Status',
      body: 'Your wallet summary, key metrics, and recent copied trades all live in this top section.'
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
      target: '#tab-trading-wallets',
      title: 'Trading Wallets',
      body: 'Your trading wallets are the wallets Ditto uses to place copied trades. For first-time users, this is the most important setup page.'
    },
    {
      tab: 'trading-wallets',
      target: '#copyAssignmentsList',
      title: 'Copy Assignments',
      body: 'Map tracked to trading wallet (dropdowns + Assign). Per-wallet Settings (gear): auto-redeem, auto-merge.'
    },
    {
      tab: 'discovery',
      target: '#tab-discovery',
      title: 'Discovery',
      body: 'Discovery helps you find promising wallets to track next. It is useful, but it should not get in the way of basic setup.'
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
      body: "Use the Start button when your setup is complete. Re-open the setup guide or this walkthrough any time from the Guide menu."
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
