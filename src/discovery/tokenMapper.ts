import { getDatabase } from '../database.js';
import { DiscoveryMarketPoolEntry, DiscoveryTokenMapEntry } from './types.js';

export const buildTokenMapEntries = (
  entries: Array<Pick<DiscoveryMarketPoolEntry, 'conditionId' | 'tokenIds' | 'outcomes' | 'updatedAt'>>,
): DiscoveryTokenMapEntry[] => {
  return entries.flatMap((entry) =>
    entry.tokenIds.map((tokenId, index) => ({
      conditionId: entry.conditionId,
      tokenId,
      outcome: entry.outcomes?.[index],
      updatedAt: entry.updatedAt,
    }))
  );
};

export const upsertTokenMapEntries = (entries: DiscoveryTokenMapEntry[]): void => {
  if (entries.length === 0) return;

  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO discovery_token_map (token_id, condition_id, outcome, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(token_id) DO UPDATE SET
      condition_id = excluded.condition_id,
      outcome = excluded.outcome,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction(() => {
    for (const entry of entries) {
      stmt.run(entry.tokenId, entry.conditionId, entry.outcome ?? null, entry.updatedAt);
    }
  });

  tx();
};

export const getTokenIdsForConditionId = (conditionId: string): string[] => {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT token_id
    FROM discovery_token_map
    WHERE condition_id = ?
    ORDER BY rowid ASC
  `).all(conditionId) as Array<{ token_id: string }>;

  return rows.map((row) => row.token_id);
};

export const getTokenMappingForTokenId = (tokenId: string): DiscoveryTokenMapEntry | null => {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT token_id, condition_id, outcome, updated_at
    FROM discovery_token_map
    WHERE token_id = ?
  `).get(tokenId) as
    | { token_id: string; condition_id: string; outcome?: string | null; updated_at: number }
    | undefined;

  if (!row) return null;

  return {
    conditionId: row.condition_id,
    tokenId: row.token_id,
    outcome: row.outcome ?? undefined,
    updatedAt: row.updated_at,
  };
};
