/**
 * Ditto landing — hero showcase autoplay (tabs work via CSS radio inputs).
 */

const SHOWCASE_TABS = ['dashboard', 'copy-list', 'jungle-agents'];

const RADIO_BY_TAB = {
  dashboard: 'showcase-radio-dashboard',
  'copy-list': 'showcase-radio-copy-list',
  'jungle-agents': 'showcase-radio-jungle-agents',
};

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const selectShowcaseTab = (tabId) => {
  const radioId = RADIO_BY_TAB[tabId];
  if (!radioId) return false;
  const radio = document.getElementById(radioId);
  if (!(radio instanceof HTMLInputElement) || radio.type !== 'radio') return false;
  radio.checked = true;
  return true;
};

const initLandingShowcase = () => {
  const root = document.querySelector('.landing-hero-showcase');
  if (!root) return;

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
    });
  });

  root.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.classList.contains('landing-showcase-radio')) return;
    const tabId = SHOWCASE_TABS.find((id) => RADIO_BY_TAB[id] === target.id);
    if (!tabId) return;
    const nextIndex = SHOWCASE_TABS.indexOf(tabId);
    if (nextIndex >= 0) activeIndex = nextIndex;
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
