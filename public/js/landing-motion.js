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

document.addEventListener('DOMContentLoaded', () => {
  duplicateMarqueeTracks();
  observeReveals();
  initNavScroll();
});
