import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const publicDir = join(process.cwd(), 'public');
const rootDir = process.cwd();

test('landing.html includes branding, marquees, and embedded auth panel', () => {
  const html = readFileSync(join(publicDir, 'landing.html'), 'utf8');
  assert.match(html, /landing\.css/);
  assert.match(html, /auth-experience\.css/);
  assert.match(html, /id="get-started"/);
  assert.match(html, /id="authPanelContinue"/);
  assert.match(html, /landing-marquee/);
  assert.match(html, /landing-cta-band-lead/);
  assert.doesNotMatch(html, /Start copying<\/span>\s*<span class="landing-marquee-item">Start copying/);
  assert.match(html, /any wallet address/);
  assert.match(html, /landing-transitions\.js/);
  assert.match(html, /data-landing-action/);
  assert.match(html, /landing-showcase\.js/);
  assert.match(html, /landing-hero-showcase/);
  assert.match(html, /showcaseJungleAgents/);
  assert.match(html, /showcase-radio-dashboard/);
  assert.match(html, /l-preview-trade-new/);
  assert.match(html, /landing-roster-shell/);
  assert.match(html, /landing-motion\.js/);
  assert.match(html, /landing-nav-links/);
  assert.match(html, /id="how-it-works"/);
  assert.doesNotMatch(html, /landing-nav-eyebrow/);
});

test('landing.js parses without syntax errors', () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--check', join(publicDir, 'js', 'landing.js')], { stdio: 'pipe' });
  });
});

test('landing.js sends header auth buttons directly to OIDC handoff', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing.js'), 'utf8');
  assert.match(js, /'nav-login': \(\) => authPanel\.handoffToOidc\('login', \{ immediate: true \}\)/);
  assert.match(js, /'nav-signup': \(\) => authPanel\.handoffToOidc\('signup', \{ immediate: true \}\)/);
  assert.match(js, /landingHeaderAuth/);
  assert.doesNotMatch(js, /goToLandingAuth/);
});

test('landing.html wires header auth buttons to immediate inline handler', () => {
  const html = readFileSync(join(publicDir, 'landing.html'), 'utf8');
  assert.match(html, /onclick="landingHeaderAuth\('login'\)"/);
  assert.match(html, /onclick="landingHeaderAuth\('signup'\)"/);
  assert.match(html, /window\.landingHeaderAuth/);
  assert.match(html, /\/auth\/login\?/);
});

test('landing.js uses document-level click delegation for header auth buttons', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing.js'), 'utf8');
  assert.match(js, /document\.addEventListener\('click'/);
  assert.match(js, /'nav-login'/);
  assert.match(js, /'nav-signup'/);
  assert.doesNotMatch(js, /main\.addEventListener\('click'/);
});

test('landing.js uses composition controllers, parallel session fetch, and view transitions', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing.js'), 'utf8');
  assert.match(js, /createAuthPanelController/);
  assert.match(js, /createRosterPresenter/);
  assert.match(js, /Promise\.all/);
  assert.match(js, /requestIdleCallback/);
  assert.match(js, /landingWithViewTransition/);
});

test('landing-transitions.js exposes view transition helper with reduced-motion guard', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing-transitions.js'), 'utf8');
  assert.match(js, /startViewTransition/);
  assert.match(js, /prefers-reduced-motion/);
});

test('landing.js uses public landing API for roster and showcase', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing.js'), 'utf8');
  assert.match(js, /screen_hint/);
  assert.match(js, /\/auth\/login/);
  assert.match(js, /returnTo/);
  assert.match(js, /\/app/);
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /\/api\/public\/landing-preview/);
  assert.match(js, /\/api\/public\/jungle-agents/);
  assert.match(js, /showcaseJungleAgents/);
  assert.match(js, /createShowcaseAgentsPresenter/);
  assert.match(js, /data-roster-agent-id/);
  assert.match(js, /loadRosterAgentStats/);
});

test('landing-showcase.js loads Jungle Agents preview independently', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing-showcase.js'), 'utf8');
  assert.match(js, /ensureLandingShowcaseAgents/);
  assert.match(js, /renderLandingShowcaseAgents/);
  assert.match(js, /\/api\/public\/landing-preview/);
  assert.match(js, /showcaseJungleAgents/);
});

test('landing-showcase.js drives hero preview autoplay via radio inputs', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing-showcase.js'), 'utf8');
  assert.match(js, /selectShowcaseTab/);
  assert.match(js, /showcase-radio-dashboard/);
  assert.match(js, /SHOWCASE_TABS/);
  assert.match(js, /prefers-reduced-motion/);
});

test('landing-motion.js expands marquee tracks to fill the viewport', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing-motion.js'), 'utf8');
  assert.match(js, /minTrackWidth/);
  assert.match(js, /cloneNode\(true\)/);
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /initRosterCursorScroll/);
  assert.match(js, /DRIFT_SPEED/);
  assert.match(js, /driftDirection/);
  assert.match(js, /^\(\(\) => \{/m);
});

test('landing scripts avoid duplicate global prefersReducedMotion declarations', () => {
  const transitionJs = readFileSync(join(publicDir, 'js', 'landing-transitions.js'), 'utf8');
  const motionJs = readFileSync(join(publicDir, 'js', 'landing-motion.js'), 'utf8');
  const showcaseJs = readFileSync(join(publicDir, 'js', 'landing-showcase.js'), 'utf8');
  assert.match(transitionJs, /^const prefersReducedMotion/m);
  assert.doesNotMatch(motionJs, /^const prefersReducedMotion/m);
  assert.doesNotMatch(showcaseJs, /^const prefersReducedMotion/m);
  assert.match(motionJs, /^\(\(\) => \{/m);
  assert.match(showcaseJs, /^\(\(\) => \{/m);
});

test('auth-bootstrap redirects unauthenticated users to /login not /auth/login', () => {
  const js = readFileSync(join(publicDir, 'js', 'auth-bootstrap.js'), 'utf8');
  assert.match(js, /\/login\?returnTo=/);
  assert.doesNotMatch(js, /window\.location\.href = `\/auth\/login/);
});

test('api.js 401 handler routes to /login with /app returnTo', () => {
  const js = readFileSync(join(publicDir, 'js', 'api.js'), 'utf8');
  assert.match(js, /\/login\?returnTo=\$\{returnTo\}/);
  assert.match(js, /encodeURIComponent\('\/app'\)/);
});

test('server.ts login route redirects to Auth0 login', () => {
  const server = readFileSync(join(rootDir, 'src', 'server.ts'), 'utf8');
  assert.match(server, /app\.get\('\/login'/);
  assert.match(server, /redirectToOidcAuth/);
  assert.match(server, /\/auth\/login\?\$\{params\.toString\(\)\}/);
  assert.doesNotMatch(server, /redirectToLandingAuth/);
});

test('server.ts login redirect does not force get-started scroll', () => {
  const server = readFileSync(join(rootDir, 'src', 'server.ts'), 'utf8');
  assert.match(server, /app\.get\('\/login'/);
  assert.doesNotMatch(server, /params\.set\('section', 'get-started'\)/);
});

test('landing.js only auto-scrolls when section=get-started is present', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing.js'), 'utf8');
  assert.match(js, /get\('section'\) === 'get-started'/);
  assert.doesNotMatch(js, /params\.has\('returnTo'\)/);
});

test('server.ts serves landing at / and dashboard at /app', () => {
  const server = readFileSync(join(rootDir, 'src', 'server.ts'), 'utf8');
  assert.match(server, /landing\.html/);
  assert.match(server, /app\.get\('\/app'/);
  assert.match(server, /app\.get\('\/login'/);
  assert.match(server, /createLandingPublicRouter/);
});

test('server.ts skips static index for landing and app routes', () => {
  const server = readFileSync(join(rootDir, 'src', 'server.ts'), 'utf8');
  assert.match(server, /index: false/);
  assert.match(server, /urlPath === '\/'/);
});

test('landing.css compacts get-started section into a centered shell', () => {
  const css = readFileSync(join(publicDir, 'landing.css'), 'utf8');
  assert.match(css, /\.landing-get-started-grid/);
  assert.match(css, /width:\s*min\(960px,\s*100%\)/);
  assert.match(css, /\.landing-get-started-panel/);
});

test('landing.css uses shared shell inset for wide-screen layout', () => {
  const css = readFileSync(join(publicDir, 'landing.css'), 'utf8');
  assert.match(css, /--landing-shell-max/);
  assert.match(css, /--landing-shell-inset/);
  assert.match(css, /\.landing-nav\.auth-shell-nav/);
  assert.match(css, /\.landing-nav-links/);
  assert.doesNotMatch(css, /max-width:\s*1320px/);
  assert.doesNotMatch(css, /max-width:\s*1200px/);
});

test('auth-experience.css defines shared auth shell primitives', () => {
  const css = readFileSync(join(publicDir, 'shared', 'auth-experience.css'), 'utf8');
  assert.match(css, /\.auth-shell-panel/);
  assert.match(css, /\.auth-handoff-overlay/);
});

test('index.html loads auth-experience.css for unified auth gate styling', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /auth-experience\.css/);
});

test('index.html runs auth bootstrap before heavy dashboard scripts', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const authBootstrapIdx = html.indexOf('auth-bootstrap.js');
  const appShellIdx = html.indexOf('id="appShell"');
  const appJsIdx = html.indexOf('app.js');
  assert.ok(authBootstrapIdx > 0);
  assert.ok(appShellIdx > authBootstrapIdx, 'auth bootstrap should load before app shell markup finishes parsing');
  assert.ok(appJsIdx > authBootstrapIdx, 'auth bootstrap should load before app.js');
  assert.match(html, /Checking your Ditto session/);
});

test('auth-bootstrap uses fetch timeouts and non-blocking capabilities load', () => {
  const js = readFileSync(join(publicDir, 'js', 'auth-bootstrap.js'), 'utf8');
  assert.match(js, /fetchWithTimeout/);
  assert.match(js, /location\.replace/);
  assert.match(js, /void loadCapabilities\(\)/);
});

test('landing and dashboard show beta risk disclaimer', () => {
  const landingHtml = readFileSync(join(publicDir, 'landing.html'), 'utf8');
  const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const brandCss = readFileSync(join(publicDir, 'shared', 'jungle-brand.css'), 'utf8');

  assert.match(landingHtml, /ditto-beta-notice/);
  assert.match(indexHtml, /ditto-beta-notice/);
  assert.match(landingHtml, /fresh wallet/i);
  assert.match(indexHtml, /not your main funds/i);
  assert.match(brandCss, /\.ditto-beta-notice/);
});
