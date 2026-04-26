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

/**
 * Apply DuckDB runtime settings from environment variables. Safe to call
 * synchronously via the CJS `run` method; pragmas are fire-and-forget and
 * will be fully applied before the first real query resolves.
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
function applyRuntimeSettings(conn: DuckDBConnection): void {
  const memGb = process.env.DUCKDB_MEMORY_LIMIT_GB;
  const threads = process.env.DUCKDB_THREADS;
  const tempDir = process.env.DUCKDB_TEMP_DIR;

  if (memGb && Number(memGb) > 0) {
    conn.run(`SET memory_limit = '${Number(memGb)}GB'`, (err) => {
      if (err) console.warn('[duckdb] memory_limit pragma failed:', err.message);
    });
  }
  if (threads && Number(threads) > 0) {
    conn.run(`SET threads = ${Number(threads)}`, (err) => {
      if (err) console.warn('[duckdb] threads pragma failed:', err.message);
    });
  }
  if (tempDir) {
    // Escape single quotes in the path to be safe.
    const escaped = tempDir.replace(/'/g, "''");
    conn.run(`SET temp_directory = '${escaped}'`, (err) => {
      if (err) console.warn('[duckdb] temp_directory pragma failed:', err.message);
    });
  }
  // max_temp_directory_size defaults to 90% of FREE disk at spill time.
  // If the volume is already crowded (e.g. source parquet + staging DB share
  // the same disk), DuckDB computes a tiny cap (~7 GB in our runs) and the
  // next sort hits OOM immediately. Pin the cap explicitly.
  const maxTempGb = process.env.DUCKDB_MAX_TEMP_DIR_GB;
  if (maxTempGb && Number(maxTempGb) > 0) {
    conn.run(`SET max_temp_directory_size = '${Number(maxTempGb)}GB'`, (err) => {
      if (err) console.warn('[duckdb] max_temp_directory_size pragma failed:', err.message);
    });
  }
  // preserve_insertion_order=false lets DuckDB stream INSERT ... SELECT
  // without buffering the whole result set — critical for 48GB ingests.
  conn.run('SET preserve_insertion_order = false', (err) => {
    if (err) console.warn('[duckdb] preserve_insertion_order pragma failed:', err.message);
  });
}

export function openDuckDB(path: string): DuckDBClient {
  const duckdb = loadDuckDB();
  const db = new duckdb.Database(path);
  const conn = db.connect();
  applyRuntimeSettings(conn);

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