import { getDiscoveryDatabase } from './discoveryDatabase.js';

export interface SourceCheckpoint {
  sourceName: string;
  cursor: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: number;
}

export const upsertSourceCheckpoint = (
  sourceName: string,
  cursor: string | null,
  metadata: Record<string, unknown> | null = null,
): void => {
  const db = getDiscoveryDatabase();
  db.prepare(`
    INSERT INTO discovery_source_checkpoints (source_name, cursor, metadata, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source_name) DO UPDATE SET
      cursor = excluded.cursor,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `).run(
    sourceName,
    cursor,
    metadata ? JSON.stringify(metadata) : null,
    Math.floor(Date.now() / 1000),
  );
};

export const getSourceCheckpoint = (sourceName: string): SourceCheckpoint | null => {
  const db = getDiscoveryDatabase();
  const row = db.prepare(
    'SELECT source_name, cursor, metadata, updated_at FROM discovery_source_checkpoints WHERE source_name = ?'
  ).get(sourceName) as {
    source_name: string;
    cursor: string | null;
    metadata: string | null;
    updated_at: number;
  } | undefined;

  if (!row) return null;

  return {
    sourceName: row.source_name,
    cursor: row.cursor,
    metadata: row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null,
    updatedAt: row.updated_at,
  };
};
