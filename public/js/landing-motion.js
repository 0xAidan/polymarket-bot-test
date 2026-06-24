/**
 * Ditto landing — scroll reveals, marquee duplication, reduced-motion guard.
 */

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const duplicateMarqueeTracks = () => {
  if (prefersReducedMotion()) return;

  document.querySelectorAll('.landing-marquee').forEach((marquee) => {
    const track = marquee.querySelector('.landing-marquee-track');
    if (!track || marquee.querySelectorAll('.landing-marquee-track').length > 1) return;
    const clone = track.cloneNode(true);
    clone.setAttribute('aria-hidden', 'true');
    marquee.appendChild(clone);
  });
};

const observeReveals = () => {
  const targets = document.querySelectorAll('.landing-reveal, .landing-step, .landing-feature');
  if (!targets.length) return;

  const reveal = (el) => {
    el.classList.add('is-visible');
  };

  if (prefersReducedMotion()) {
    targets.forEach(reveal);
    return;
  }

  targets.forEach((el) => {
    const rect = el.getBoundingClientRect();
    const inViewport = rect.top < window.innerHeight * 0.92 && rect.bottom > 0;
    if (inViewport) {
      reveal(el);
    }
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          reveal(entry.target);
          observer.unobserve(entry.target);
        }
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );

  targets.forEach((el) => {
    if (!el.classList.contains('is-visible')) {
      observer.observe(el);
    }
  });
};

const initNavScroll = () => {
  const nav = document.querySelector('.landing-nav');
  if (!nav) return;

  const handleScroll = () => {
    nav.classList.toggle('is-scrolled', window.scrollY > 8);
  };

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();
};

const initRosterCursorScroll = () => {
  const roster = document.getElementById('landingRoster');
  if (!roster || roster.dataset.rosterScrollReady === 'true') return;

  const reduceMotion = prefersReducedMotion();
  const MAX_SPEED = 10;
  const IDLE_SPEED = reduceMotion ? 0 : 1.8;
  const EDGE_DEADZONE = 0.06;

  let pointerRatio = null;
  let driftDirection = 1;
  let isVisible = false;
  let frameId = 0;

  const getMaxScroll = () => Math.max(0, roster.scrollWidth - roster.clientWidth);

  const speedFromRatio = (ratio) => {
    const centered = (ratio - 0.5) * 2;
    if (Math.abs(centered) <= EDGE_DEADZONE) return 0;
    const magnitude = (Math.abs(centered) - EDGE_DEADZONE) / (1 - EDGE_DEADZONE);
    return Math.sign(centered) * magnitude * MAX_SPEED;
  };

  const tick = () => {
    const maxScroll = getMaxScroll();

    if (isVisible && maxScroll > 2) {
      let speed = 0;
      if (pointerRatio !== null) {
        speed = speedFromRatio(pointerRatio);
      } else if (IDLE_SPEED > 0) {
        speed = IDLE_SPEED * driftDirection;
      }

      if (speed !== 0) {
        roster.scrollLeft = Math.min(maxScroll, Math.max(0, roster.scrollLeft + speed));

        if (roster.scrollLeft <= 0) {
          driftDirection = 1;
        } else if (roster.scrollLeft >= maxScroll - 1) {
          driftDirection = -1;
        }
      }
    }

    frameId = window.requestAnimationFrame(tick);
  };

  const updatePointerRatio = (clientX) => {
    const rect = roster.getBoundingClientRect();
    if (rect.width <= 0) return;
    pointerRatio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  roster.addEventListener('pointerenter', (event) => {
    roster.setPointerCapture?.(event.pointerId);
    updatePointerRatio(event.clientX);
  });

  roster.addEventListener('pointerleave', (event) => {
    roster.releasePointerCapture?.(event.pointerId);
    pointerRatio = null;
  });

  roster.addEventListener('pointermove', (event) => {
    updatePointerRatio(event.clientX);
  }, { passive: true });

  const visibilityObserver = new IntersectionObserver(
    ([entry]) => {
      isVisible = entry.isIntersecting;
    },
    { threshold: 0.08 },
  );
  visibilityObserver.observe(roster);

  const rosterObserver = new MutationObserver(() => {
    const maxScroll = getMaxScroll();
    if (roster.scrollLeft > maxScroll) {
      roster.scrollLeft = maxScroll;
    }
  });
  rosterObserver.observe(roster, { childList: true, subtree: true });

  roster.dataset.rosterScrollReady = 'true';
  frameId = window.requestAnimationFrame(tick);

  window.addEventListener('beforeunload', () => {
    if (frameId) window.cancelAnimationFrame(frameId);
    visibilityObserver.disconnect();
    rosterObserver.disconnect();
  }, { once: true });
};

window.initLandingRosterScroll = initRosterCursorScroll;

document.addEventListener('DOMContentLoaded', () => {
  duplicateMarqueeTracks();
  observeReveals();
  initNavScroll();
  initRosterCursorScroll();
});

document.addEventListener('landing-roster-updated', () => {
  initRosterCursorScroll();
});
