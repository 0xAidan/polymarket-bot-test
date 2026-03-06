import Database from 'better-sqlite3';
import path from 'path';
import { promises as fs } from 'fs';
import { config } from '../config.js';
import { runDiscoveryMigrations } from './discoveryMigrations.js';

let discoveryDb: Database.Database | null = null;
let currentDiscoveryDbPath: string | null = null;

const discoveryDbPath = (): string => path.join(config.dataDir, 'discovery.db');

export async function initDiscoveryDatabase(): Promise<Database.Database> {
  const targetPath = discoveryDbPath();

  if (discoveryDb && currentDiscoveryDbPath === targetPath) return discoveryDb;
  if (discoveryDb) {
    discoveryDb.close();
    discoveryDb = null;
  }

  await fs.mkdir(config.dataDir, { recursive: true });

  discoveryDb = new Database(targetPath);
  currentDiscoveryDbPath = targetPath;

  discoveryDb.pragma('journal_mode = WAL');
  discoveryDb.pragma('synchronous = NORMAL');
  discoveryDb.pragma('foreign_keys = ON');

  runDiscoveryMigrations(discoveryDb);

  return discoveryDb;
}

export function getDiscoveryDatabase(): Database.Database {
  if (!discoveryDb) {
    throw new Error('Discovery database not initialized. Call initDiscoveryDatabase() first.');
  }

  return discoveryDb;
}

export function closeDiscoveryDatabase(): void {
  if (!discoveryDb) return;

  discoveryDb.close();
  discoveryDb = null;
  currentDiscoveryDbPath = null;
}
