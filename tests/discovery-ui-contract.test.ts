import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

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
