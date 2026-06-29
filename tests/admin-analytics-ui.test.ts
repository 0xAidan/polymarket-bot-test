import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const adminDir = join(process.cwd(), 'public', 'admin');

test('admin panel includes Analytics nav and section', () => {
  const html = readFileSync(join(adminDir, 'index.html'), 'utf8');
  const adminJs = readFileSync(join(adminDir, 'admin.js'), 'utf8');
  const analyticsJs = readFileSync(join(adminDir, 'admin-analytics.js'), 'utf8');

  assert.match(html, /data-admin-nav="analytics"/);
  assert.doesNotMatch(html, /data-admin-nav="tenants"/);
  assert.match(html, /id="adminAnalytics"/);
  assert.match(html, /admin-analytics\.js/);
  assert.match(html, /uplot\.min\.js/);
  assert.match(adminJs, /showAdminAnalytics/);
  assert.match(analyticsJs, /getAdminAnalyticsOverview/);
});
