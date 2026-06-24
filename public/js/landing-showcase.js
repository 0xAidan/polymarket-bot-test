/**
 * Ditto landing — hero dashboard preview tabs + iframe scaling.
 */

const SHOWCASE_TABS = ['dashboard', 'copy-list', 'jungle-agents'];
const CAPTURE_WIDTH = 1100;
const CAPTURE_HEIGHT = 640;

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const fitUiCaptures = () => {
  document.querySelectorAll('.landing-ui-iframe-wrap').forEach((wrap) => {
    const scaleEl = wrap.querySelector('.landing-ui-iframe-scale');
    if (!scaleEl) return;
    const scale = Math.min(1, wrap.clientWidth / CAPTURE_WIDTH);
    scaleEl.style.transform = `scale(${scale})`;
    wrap.style.height = `${CAPTURE_HEIGHT * scale}px`;
  });
};

const setShowcaseTab = (root, tabId) => {
  const tabs = root.querySelectorAll('[data-showcase-tab]');
  const panels = root.querySelectorAll('[data-showcase-panel]');

  const update = () => {
    tabs.forEach((tab) => {
      const isActive = tab.dataset.showcaseTab === tabId;
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.classList.toggle('is-active', isActive);
    });
    panels.forEach((panel) => {
      const isActive = panel.dataset.showcasePanel === tabId;
      panel.classList.toggle('is-active', isActive);
      if (isActive) {
        panel.removeAttribute('hidden');
      } else {
        panel.setAttribute('hidden', '');
      }
    });
    window.requestAnimationFrame(fitUiCaptures);
  };

  if (typeof window.landingWithViewTransition === 'function') {
    window.landingWithViewTransition(update);
  } else {
    update();
  }
};

const initShowcaseAutoplay = (root) => {
  if (prefersReducedMotion()) return undefined;

  let index = 0;
  const intervalId = window.setInterval(() => {
    if (root.matches(':hover') || root.matches(':focus-within')) return;
    index = (index + 1) % SHOWCASE_TABS.length;
    setShowcaseTab(root, SHOWCASE_TABS[index]);
  }, 6000);

  return intervalId;
};

const initLandingShowcase = () => {
  const root = document.querySelector('.landing-hero-showcase');
  if (!root) return;

  fitUiCaptures();
  window.addEventListener('resize', fitUiCaptures, { passive: true });

  let autoplayId = initShowcaseAutoplay(root);

  root.querySelectorAll('[data-showcase-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabId = tab.dataset.showcaseTab;
      if (!tabId) return;
      setShowcaseTab(root, tabId);
    });
  });

  root.addEventListener('mouseenter', () => {
    if (autoplayId) {
      window.clearInterval(autoplayId);
      autoplayId = undefined;
    }
  });

  root.addEventListener('mouseleave', () => {
    if (!autoplayId) {
      autoplayId = initShowcaseAutoplay(root);
    }
  });
};

document.addEventListener('DOMContentLoaded', initLandingShowcase);
