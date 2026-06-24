/**
 * Ditto landing — hero dashboard preview tabs + live mock blink.
 */

const SHOWCASE_TABS = ['dashboard', 'copy-list', 'jungle-agents'];

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const setShowcaseTab = (root, tabId) => {
  const tabs = root.querySelectorAll('[data-showcase-tab]');
  const panels = root.querySelectorAll('[data-showcase-panel]');

  tabs.forEach((tab) => {
    const isActive = tab.dataset.showcaseTab === tabId;
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.classList.toggle('is-active', isActive);
    tab.tabIndex = isActive ? 0 : -1;
  });

  panels.forEach((panel) => {
    const isActive = panel.dataset.showcasePanel === tabId;
    panel.classList.toggle('is-active', isActive);
    panel.toggleAttribute('hidden', !isActive);
  });
};

const initLandingShowcase = () => {
  const root = document.querySelector('.landing-hero-showcase');
  if (!root) return;

  let activeIndex = 0;
  let autoplayId;

  const selectTab = (tabId) => {
    const nextIndex = SHOWCASE_TABS.indexOf(tabId);
    if (nextIndex < 0) return;
    activeIndex = nextIndex;
    setShowcaseTab(root, tabId);
  };

  const startAutoplay = () => {
    if (prefersReducedMotion() || autoplayId) return;

    autoplayId = window.setInterval(() => {
      if (root.matches(':hover') || root.matches(':focus-within')) return;
      activeIndex = (activeIndex + 1) % SHOWCASE_TABS.length;
      setShowcaseTab(root, SHOWCASE_TABS[activeIndex]);
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
      selectTab(tabId);
    });
  });

  const tablist = root.querySelector('[role="tablist"]');
  if (tablist) {
    tablist.addEventListener('keydown', (event) => {
      const tabs = [...root.querySelectorAll('[data-showcase-tab]')];
      const currentIndex = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
      if (currentIndex < 0) return;

      let nextIndex = currentIndex;
      if (event.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (event.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = tabs.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      const nextTab = tabs[nextIndex];
      const tabId = nextTab?.dataset.showcaseTab;
      if (!tabId) return;
      selectTab(tabId);
      nextTab.focus();
    });
  }

  root.addEventListener('mouseenter', stopAutoplay);
  root.addEventListener('mouseleave', startAutoplay);

  setShowcaseTab(root, SHOWCASE_TABS[activeIndex]);
  startAutoplay();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLandingShowcase);
} else {
  initLandingShowcase();
}
