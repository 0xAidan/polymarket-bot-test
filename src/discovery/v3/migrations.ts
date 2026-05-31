import type Database from 'better-sqlite3';
import { runV3SqliteMigrations } from './schema.js';
import { isDiscoveryV3Enabled } from './featureFlag.js';

let applied = false;

export function applyV3SqliteMigrationsIfEnabled(db: Database.Database): void {
  if (!isDiscoveryV3Enabled()) return;
  if (applied) return;
  runV3SqliteMigrations(db);
  applied = true;
}

export function _resetV3MigrationAppliedForTests(): void {
  applied = false;
}
