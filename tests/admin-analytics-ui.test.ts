import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const adminDir = join(process.cwd(), 'public', 'admin');
const jsDir = join(process.cwd(), 'public', 'js');

test('admin panel includes Analytics nav and lazy-loaded analytics bundle', () => {
  const html = readFileSync(join(adminDir, 'index.html'), 'utf8');
  const adminJs = readFileSync(join(jsDir, 'roster-editor.js'), 'utf8');
  const analyticsJs = readFileSync(join(jsDir, 'roster-analytics.js'), 'utf8');

  assert.match(html, /data-admin-nav="analytics"/);
  assert.doesNotMatch(html, /data-admin-nav="tenants"/);
  assert.match(html, /id="adminAnalytics"/);
  assert.match(adminJs, /roster-analytics\.js/);
  assert.match(adminJs, /showAdminAnalytics/);
  assert.match(analyticsJs, /getAdminAnalyticsOverview/);
});
