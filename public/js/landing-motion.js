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
  const shell = document.querySelector('[data-landing-roster-shell]');
  const roster = document.getElementById('landingRoster');
  if (!shell || !roster) return;

  if (prefersReducedMotion() || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    return;
  }

  const MAX_SPEED = 5.5;
  const DEAD_ZONE = 0.14;
  let scrollSpeed = 0;
  let frameId = 0;
  let isActive = false;

  const clampScroll = () => {
    const maxScroll = roster.scrollWidth - roster.clientWidth;
    if (maxScroll <= 0) {
      scrollSpeed = 0;
      return;
    }
    roster.scrollLeft = Math.max(0, Math.min(maxScroll, roster.scrollLeft));
  };

  const tick = () => {
    if (isActive && scrollSpeed !== 0) {
      roster.scrollLeft += scrollSpeed;
      clampScroll();
    }
    frameId = window.requestAnimationFrame(tick);
  };

  const updateSpeedFromPointer = (clientX) => {
    const rect = shell.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const center = 0.5;

    if (ratio <= center - DEAD_ZONE) {
      const t = (center - DEAD_ZONE - ratio) / (center - DEAD_ZONE);
      scrollSpeed = -MAX_SPEED * Math.min(1, Math.max(0, t));
      return;
    }

    if (ratio >= center + DEAD_ZONE) {
      const t = (ratio - center - DEAD_ZONE) / (center - DEAD_ZONE);
      scrollSpeed = MAX_SPEED * Math.min(1, Math.max(0, t));
      return;
    }

    scrollSpeed = 0;
  };

  const handlePointerMove = (event) => {
    if (!isActive) return;
    updateSpeedFromPointer(event.clientX);
  };

  shell.addEventListener('pointerenter', (event) => {
    isActive = true;
    updateSpeedFromPointer(event.clientX);
    if (!frameId) {
      frameId = window.requestAnimationFrame(tick);
    }
  });

  shell.addEventListener('pointerleave', () => {
    isActive = false;
    scrollSpeed = 0;
  });

  shell.addEventListener('pointermove', handlePointerMove, { passive: true });

  window.addEventListener('beforeunload', () => {
    if (frameId) window.cancelAnimationFrame(frameId);
  }, { once: true });
};

document.addEventListener('DOMContentLoaded', () => {
  duplicateMarqueeTracks();
  observeReveals();
  initNavScroll();
  initRosterCursorScroll();
});
