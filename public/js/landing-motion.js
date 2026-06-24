/**
 * Ditto landing — scroll reveals, marquee duplication, reduced-motion guard.
 */
(() => {
  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const duplicateMarqueeTracks = () => {
    if (prefersReducedMotion()) return;

    document.querySelectorAll('.landing-marquee').forEach((marquee) => {
      const track = marquee.querySelector('.landing-marquee-track');
      if (!track) return;

      marquee.querySelectorAll('.landing-marquee-track').forEach((node, index) => {
        if (index > 0) node.remove();
      });

      const minTrackWidth = Math.max(window.innerWidth * 1.25, 960);
      let guard = 0;
      while (track.scrollWidth < minTrackWidth && guard < 12) {
        Array.from(track.children).forEach((child) => {
          track.appendChild(child.cloneNode(true));
        });
        guard += 1;
      }

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
    if (!shell || !roster || roster.dataset.rosterScrollReady === 'true') return;

    if (prefersReducedMotion()) return;

    // Match landing marquee pace (~40s per track width at ~30px/s).
    const DRIFT_SPEED = 0.45;
    let driftDirection = 1;
    let isVisible = false;
    let frameId = 0;

    const getMaxScroll = () => Math.max(0, roster.scrollWidth - roster.clientWidth);

    const tick = () => {
      const maxScroll = getMaxScroll();

      if (isVisible && maxScroll > 2) {
        roster.scrollLeft = Math.min(
          maxScroll,
          Math.max(0, roster.scrollLeft + DRIFT_SPEED * driftDirection),
        );

        if (roster.scrollLeft <= 0) {
          driftDirection = 1;
        } else if (roster.scrollLeft >= maxScroll - 1) {
          driftDirection = -1;
        }
      }

      frameId = window.requestAnimationFrame(tick);
    };

    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
      },
      { threshold: 0.01 },
    );
    visibilityObserver.observe(shell);

    const syncScrollBounds = () => {
      const maxScroll = getMaxScroll();
      if (roster.scrollLeft > maxScroll) {
        roster.scrollLeft = maxScroll;
      }
    };

    const rosterObserver = new MutationObserver(syncScrollBounds);
    rosterObserver.observe(roster, { childList: true, subtree: true });

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(syncScrollBounds);
      resizeObserver.observe(roster);
      window.addEventListener('beforeunload', () => resizeObserver.disconnect(), { once: true });
    }

    roster.dataset.rosterScrollReady = 'true';
    frameId = window.requestAnimationFrame(tick);

    window.addEventListener('beforeunload', () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      visibilityObserver.disconnect();
      rosterObserver.disconnect();
    }, { once: true });
  };

  const boot = () => {
    duplicateMarqueeTracks();
    observeReveals();
    initNavScroll();
    initRosterCursorScroll();
  };

  window.initLandingRosterScroll = initRosterCursorScroll;

  document.addEventListener('landing-roster-updated', initRosterCursorScroll);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
