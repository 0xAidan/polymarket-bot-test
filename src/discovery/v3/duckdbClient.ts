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

export function openDuckDB(path: string): DuckDBClient {
  const duckdb = loadDuckDB();
  const db = new duckdb.Database(path);
  const conn = db.connect();

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
