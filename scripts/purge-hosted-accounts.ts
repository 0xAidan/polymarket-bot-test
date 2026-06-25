#!/usr/bin/env tsx
/**
 * Purge all hosted OIDC accounts and tenant-scoped bot data.
 * Use after an auth provider change (e.g. removing Google login) so users re-register cleanly.
 *
 * Platform admin access is NOT stored here — it comes from PLATFORM_ADMIN_EMAILS in .env.
 *
 * Usage:
 *   npm run purge:accounts -- --confirm
 */
import { initDatabase, closeDatabase } from '../src/database.js';
import { purgeAllHostedAccounts } from '../src/authAccountPurge.js';

const main = async (): Promise<void> => {
  const confirmed = process.argv.includes('--confirm');
  if (!confirmed) {
    console.error('Refusing to run without --confirm');
    console.error('This deletes ALL app_users, app_tenants, tracked wallets, bot config, keystores, and tenant JSON files.');
    console.error('Platform admin emails (PLATFORM_ADMIN_EMAILS) are unchanged.');
    process.exit(1);
  }

  await initDatabase();
  try {
    const result = await purgeAllHostedAccounts();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    closeDatabase();
  }
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
