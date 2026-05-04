import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('main discovery UI uses v3 endpoints for primary discovery data', () => {
  const appJs = readFileSync('public/js/app.js', 'utf8');
  const requiredV3Endpoints = [
    '/api/discovery/v3/wallets',
    '/api/discovery/v3/wallets/compare',
    '/api/discovery/v3/watchlist',
    '/api/discovery/v3/alerts',
    '/api/discovery/v3/methodology',
    '/api/discovery/v3/track',
  ];
  for (const endpoint of requiredV3Endpoints) {
    assert.ok(appJs.includes(endpoint), `Expected main discovery UI to call ${endpoint}`);
  }

  const forbiddenLegacyEndpoints = [
    '/api/discovery/wallets?',
    '/api/discovery/wallets/compare',
    '/api/discovery/watchlist?',
    '/api/discovery/alerts?',
    '/api/discovery/methodology',
  ];
  for (const endpoint of forbiddenLegacyEndpoints) {
    assert.equal(appJs.includes(endpoint), false, `Expected main discovery UI to stop using ${endpoint}`);
  }
});
