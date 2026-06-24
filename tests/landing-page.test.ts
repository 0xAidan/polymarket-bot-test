import assert from 'node:assert/strict';
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
  assert.match(html, /any Polymarket wallet address/);
  assert.match(html, /landing-motion\.js/);
});

test('landing.js uses /login handoff and OIDC screen_hint for signup', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing.js'), 'utf8');
  assert.match(js, /screen_hint/);
  assert.match(js, /\/auth\/login/);
  assert.match(js, /returnTo/);
  assert.match(js, /\/app/);
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /landing-preview/);
});

test('landing-motion.js respects reduced motion for marquees', () => {
  const js = readFileSync(join(publicDir, 'js', 'landing-motion.js'), 'utf8');
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /IntersectionObserver/);
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

test('auth-experience.css defines shared auth shell primitives', () => {
  const css = readFileSync(join(publicDir, 'shared', 'auth-experience.css'), 'utf8');
  assert.match(css, /\.auth-shell-panel/);
  assert.match(css, /\.auth-handoff-overlay/);
});

test('index.html loads auth-experience.css for unified auth gate styling', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /auth-experience\.css/);
});
