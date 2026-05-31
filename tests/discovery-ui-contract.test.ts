import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('discovery supporting reasons helper renders server-provided reason strings', () => {
  const supportingReasonsMatch = appSource.match(
    /const getDiscoverySupportingReasons = \(wallet\) =>[\s\S]*?slice\(0, 3\)/,
  );

  assert.ok(supportingReasonsMatch, 'Expected supporting-reasons helper in app.js');
  assert.match(supportingReasonsMatch[0], /supportingReasons/);
});

test('discovery search includes supportingReasonChips in filter haystack', () => {
  assert.match(appSource, /wallet\.supportingReasonChips \|\| \[\]/);
});

test('discovery compare and watchlist actions exist with POST handlers', () => {
  const compareMatch = appSource.match(/const runDiscoveryCompare = async \(\) =>[\s\S]*?const addSelectedDiscoveryWalletToWatchlist = async/);
  const watchlistMatch = appSource.match(/const addSelectedDiscoveryWalletToWatchlist = async \(\) =>[\s\S]*?const removeDiscoveryWatchlist = async/);

  assert.ok(compareMatch, 'Expected compare action in app.js');
  assert.ok(watchlistMatch, 'Expected watchlist action in app.js');

  assert.match(compareMatch[0], /\/api\/discovery\/wallets\/compare/);
  assert.match(watchlistMatch[0], /\/api\/discovery\/watchlist/);
});

test('discovery tab exposes inspector and compare surfaces', () => {
  assert.match(appSource, /getElementById\('discoveryInspectorBody'\)/);
  assert.match(appSource, /getElementById\('discoveryCompareBody'\)/);
  assert.match(appSource, /const renderDiscoveryInspector = async \(\) =>/);
});

test('discovery inspector exposes track, compare, watchlist, and deep-view actions', () => {
  const inspectorMatch = appSource.match(/const renderDiscoveryInspector = async \(\) =>[\s\S]*?Loading live positions and signals/);
  assert.ok(inspectorMatch, 'Expected discovery inspector renderer in app.js');
  assert.match(inspectorMatch[0], /buildDiscoveryTrackButton/);
  assert.match(inspectorMatch[0], /addWalletToDiscoveryCompare/);
  assert.match(inspectorMatch[0], /addSelectedDiscoveryWalletToWatchlist/);
  assert.match(inspectorMatch[0], /openWalletDetail\('/);
});

test('watchlist inspect selects wallet for inspector instead of a removed profile surface', () => {
  const watchlistMatch = appSource.match(/const loadDiscoveryWatchlist = async \(\) =>[\s\S]*?const loadDiscoveryAlertsCenter = async/);
  assert.ok(watchlistMatch, 'Expected watchlist loader in app.js');
  assert.match(watchlistMatch[0], /selectDiscoveryWallet\('/);
  assert.doesNotMatch(watchlistMatch[0], /openDiscoveryProfile\('/);
});

test('trackDiscoveredWallet activates tracked wallets through the wallets API', () => {
  const trackMatch = appSource.match(/const trackDiscoveredWallet = async \(address, btn\) =>[\s\S]*?const saveDiscoveryConfig = async/);
  assert.ok(trackMatch, 'Expected trackDiscoveredWallet in app.js');
  assert.match(trackMatch[0], /fetch\('\/api\/wallets'/);
  assert.match(trackMatch[0], /\/api\/discovery\/wallets\/\$\{address\}\/track/);
});

test('Ditto execution panel filters recent discovery-linked executions by source', () => {
  const panelMatch = appSource.match(/const loadDiscoveryDittoExecutionPanel = async \(\) =>[\s\S]*?const loadDiscoveryMethodology = async/);
  assert.ok(panelMatch, 'Expected Ditto execution panel loader in app.js');
  assert.match(panelMatch[0], /trade\.source/);
  assert.match(panelMatch[0], /discovery/);
});

test('signal cards only render dismiss buttons for dismissible signals', () => {
  const signalsMatch = appSource.match(/const loadDiscoverySignals = async \(\) =>[\s\S]*?const dismissSignal = async/);
  assert.ok(signalsMatch, 'Expected discovery signals loader in app.js');
  assert.match(signalsMatch[0], /s\.canDismiss/);
});

test('discovery-core shares trust normalization without duplicating readApiResponse in api.js', () => {
  const discoveryCoreSource = readFileSync(new URL('../public/js/discovery-core.js', import.meta.url), 'utf8');
  assert.match(discoveryCoreSource, /normalizeTrustScore/);
  const apiSource = readFileSync(new URL('../public/js/api.js', import.meta.url), 'utf8');
  assert.doesNotMatch(apiSource, /const readApiResponse =/);
});
