import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('discovery supporting reasons include server-provided supporting chips', () => {
  const supportingReasonsMatch = appSource.match(
    /const getDiscoverySupportingReasons = \(wallet\) =>[\s\S]*?slice\(0, 3\)/,
  );

  assert.ok(supportingReasonsMatch, 'Expected supporting-reasons helper in app.js');
  assert.match(supportingReasonsMatch[0], /supportingReasonChips/);
});

test('discovery compare and watchlist writes use API.post instead of raw fetch', () => {
  const compareMatch = appSource.match(/const runDiscoveryCompare = async \(\) =>[\s\S]*?const addSelectedDiscoveryWalletToWatchlist = async/);
  const watchlistMatch = appSource.match(/const addSelectedDiscoveryWalletToWatchlist = async \(\) =>[\s\S]*?const removeDiscoveryWatchlist = async/);

  assert.ok(compareMatch, 'Expected compare action in app.js');
  assert.ok(watchlistMatch, 'Expected watchlist action in app.js');

  assert.match(compareMatch[0], /API\.post\('\/discovery\/wallets\/compare'/);
  assert.doesNotMatch(compareMatch[0], /fetch\('\/api\/discovery\/wallets\/compare'/);

  assert.match(watchlistMatch[0], /API\.post\('\/discovery\/watchlist'/);
  assert.doesNotMatch(watchlistMatch[0], /fetch\('\/api\/discovery\/watchlist'/);
});

test('safari UI exposes dedicated surface navigation for home, leaderboard, and profile', () => {
  assert.match(htmlSource, /id="discoverySurfaceHome"/);
  assert.match(htmlSource, /id="discoverySurfaceLeaderboard"/);
  assert.match(htmlSource, /id="discoverySurfaceProfile"/);
  assert.match(appSource, /const setDiscoverySurface = \(mode\) =>/);
});

test('wallet actions can open the dedicated Safari profile surface', () => {
  assert.match(appSource, /const openDiscoveryProfile = \(address\) =>/);
  assert.match(appSource, /openDiscoveryProfile\('/);
});

test('watchlist inspect uses the dedicated Safari profile surface', () => {
  const watchlistMatch = appSource.match(/const loadDiscoveryWatchlist = async \(\) =>[\s\S]*?const loadDiscoveryAlertsCenter = async/);
  assert.ok(watchlistMatch, 'Expected watchlist loader in app.js');
  assert.match(watchlistMatch[0], /openDiscoveryProfile\('/);
});

test('trackDiscoveredWallet uses shared API helpers instead of raw fetch', () => {
  const trackMatch = appSource.match(/const trackDiscoveredWallet = async \(address, btn\) =>[\s\S]*?const saveDiscoveryConfig = async/);
  assert.ok(trackMatch, 'Expected trackDiscoveredWallet in app.js');
  assert.match(trackMatch[0], /API\.post\('\/discovery\/wallets\/' \+ encodeURIComponent\(address\) \+ '\/track'/);
  assert.doesNotMatch(trackMatch[0], /fetch\('\/api\/wallets'/);
  assert.doesNotMatch(trackMatch[0], /API\.patch\('\/wallets\/' \+ encodeURIComponent\(address\) \+ '\/toggle'/);
});

test('discovery advanced controls expose read mode and migration status', () => {
  assert.match(htmlSource, /id="discoveryReadMode"/);
  assert.match(htmlSource, /id="discoveryMigrationStatus"/);
  assert.match(appSource, /const loadDiscoveryMigrationStatus = async \(\) =>/);
  assert.match(appSource, /readMode: readModeEl\?\.value \|\| 'v2-with-v1-fallback'/);
});

test('Ditto execution panel derives discovery-linked executions from wallet tags, not nonexistent source fields', () => {
  const panelMatch = appSource.match(/const loadDiscoveryDittoExecutionPanel = async \(\) =>[\s\S]*?const loadDiscoveryMethodology = async/);
  assert.ok(panelMatch, 'Expected Ditto execution panel loader in app.js');
  assert.match(panelMatch[0], /walletTags/);
  assert.doesNotMatch(panelMatch[0], /trade\.source/);
});

test('alerts center only renders dismiss buttons for dismissible alerts', () => {
  const alertsMatch = appSource.match(/const loadDiscoveryAlertsCenter = async \(\) =>[\s\S]*?const loadDiscoveryAllocationStates = async/);
  assert.ok(alertsMatch, 'Expected alerts center loader in app.js');
  assert.match(alertsMatch[0], /alert\.canDismiss !== false/);
});

test('hydrated Safari profile keeps Safari actions instead of falling back to deep-view modal actions', () => {
  const inspectorMatch = appSource.match(/const renderDiscoveryInspector = async \(\) =>[\s\S]*?window\.setDiscoveryLayout/);
  assert.ok(inspectorMatch, 'Expected discovery inspector renderer in app.js');
  assert.doesNotMatch(inspectorMatch[0], /openWalletDetail\('/);
  assert.match(inspectorMatch[0], /openDiscoveryProfile\('/);
});
