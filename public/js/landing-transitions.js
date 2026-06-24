/**
 * Ditto landing — CSS View Transition API helpers (vanilla equivalent of React ViewTransition).
 */

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Run a DOM update inside a view transition when supported.
 * Skips animation when the user prefers reduced motion.
 */
const withViewTransition = (update) => {
  if (prefersReducedMotion() || typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  document.startViewTransition(update);
};

window.landingWithViewTransition = withViewTransition;
