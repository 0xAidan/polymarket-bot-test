import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// The `duckdb` npm package ships as CommonJS; load via createRequire to stay
// compatible with this project's NodeNext ESM setup.
type DuckDBModule = {
  Database: new (path: string) => DuckDBDatabase;
};

interface DuckDBDatabase {
  connect(): DuckDBConnection;
  close(cb: (err: Error | null) => void): void;
  /** Finishes background tasks after opening a file-backed DB (node-duckdb). */
  wait(cb: (err: Error | null) => void): void;
}

interface DuckDBConnection {
  all(sql: string, cb: (err: Error | null, rows: any[]) => void): void;
  all(sql: string, ...args: any[]): void;
  run(sql: string, cb: (err: Error | null) => void): void;
  run(sql: string, ...args: any[]): void;
  exec(sql: string, cb: (err: Error | null) => void): void;
}

export interface DuckDBClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

function loadDuckDB(): DuckDBModule {
  return require('duckdb') as DuckDBModule;
}

const execOnConn = (conn: DuckDBConnection, sql: string): Promise<void> =>
  new Promise((resolve, reject) => {
    conn.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

const waitDatabaseReady = (db: DuckDBDatabase): Promise<void> =>
  new Promise((resolve, reject) => {
    db.wait((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

function isLikelyExclusiveLockError(message: string): boolean {
  return (
    message.includes('never established') ||
    message.includes('has been closed already') ||
    message.includes('Could not set lock') ||
    message.includes('conflicting lock')
  );
}

async function verifyWritableConnection(conn: DuckDBConnection, dbPath: string): Promise<void> {
  try {
    await execOnConn(conn, 'SELECT 1');
  } catch (err) {
    const message = (err as Error).message;
    if (isLikelyExclusiveLockError(message)) {
      throw new Error(
        `DuckDB could not open "${dbPath}" for writing — another process almost certainly ` +
          `already has this file open (DuckDB allows only one writer at a time). ` +
          `On the server run: sudo lsof "${dbPath}"  OR  sudo fuser -v "${dbPath}" ` +
          `Stop any other \`node\` using that path (e.g. 05_score_and_publish, verify scripts, ` +
          `or a stray shell), then restart this service. Original error: ${message}`
      );
    }
    throw err;
  }
}

/**
 * Apply DuckDB runtime settings from environment variables. Must complete
 * before any other `exec` / `all` on the same connection so we do not overlap
 * with migrations (node-duckdb is sensitive to concurrent work on one handle).
 *
 * Supported env vars:
 *   DUCKDB_MEMORY_LIMIT_GB   — cap DuckDB's memory (default: let DuckDB pick)
 *   DUCKDB_THREADS           — cap parallelism (default: all cores)
 *   DUCKDB_TEMP_DIR          — where to spill when memory_limit is exceeded
 *                              (default: DuckDB's own tmp, often too small)
 *   DUCKDB_MAX_TEMP_DIR_GB   — cap on spill directory size. DuckDB defaults
 *                              this to 90% of FREE disk at spill time, which
 *                              breaks when the volume is already crowded.
 *                              Set explicitly for large sort/GROUP BY runs.
 *
 * Setting temp_directory is essential: without it, a GROUP BY or ROW_NUMBER
 * on a larger-than-memory dataset will OOM instead of spilling to disk.
 */
async function applyRuntimeSettings(conn: DuckDBConnection): Promise<void> {
  const memGb = process.env.DUCKDB_MEMORY_LIMIT_GB;
  const threads = process.env.DUCKDB_THREADS;
  const tempDir = process.env.DUCKDB_TEMP_DIR;

  const tryRun = async (label: string, sql: string): Promise<void> => {
    try {
      await execOnConn(conn, sql);
    } catch (err) {
      console.warn(`[duckdb] ${label} failed:`, (err as Error).message);
    }
  };

  if (memGb && Number(memGb) > 0) {
    await tryRun('memory_limit', `SET memory_limit = '${Number(memGb)}GB'`);
  }
  if (threads && Number(threads) > 0) {
    await tryRun('threads', `SET threads = ${Number(threads)}`);
  }
  if (tempDir) {
    const escaped = tempDir.replace(/'/g, "''");
    await tryRun('temp_directory', `SET temp_directory = '${escaped}'`);
  }
  const maxTempGb = process.env.DUCKDB_MAX_TEMP_DIR_GB;
  if (maxTempGb && Number(maxTempGb) > 0) {
    await tryRun(
      'max_temp_directory_size',
      `SET max_temp_directory_size = '${Number(maxTempGb)}GB'`
    );
  }
  await tryRun('preserve_insertion_order', 'SET preserve_insertion_order = false');
}

export async function openDuckDB(path: string): Promise<DuckDBClient> {
  const duckdb = loadDuckDB();
  const db = new duckdb.Database(path);
  await waitDatabaseReady(db);
  const conn = db.connect();
  await verifyWritableConnection(conn, path);
  await applyRuntimeSettings(conn);

  return {
    query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return new Promise((resolve, reject) => {
        const callback = (err: Error | null, rows: any[]) => {
          if (err) reject(err);
          else resolve((rows ?? []) as T[]);
        };
        if (params.length > 0) {
          (conn.all as any)(sql, ...params, callback);
        } else {
          conn.all(sql, callback);
        }
      });
    },
    exec(sql: string): Promise<void> {
      return new Promise((resolve, reject) => {
        conn.exec(sql, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        db.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
