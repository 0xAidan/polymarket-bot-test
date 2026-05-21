/**
 * Fast path: refresh realized_pnl in SQLite from Polymarket position APIs only.
 * Does not touch DuckDB — safe while 04_emit_snapshots is running.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fetchReferenceLifetimePnlUsd } from '../../src/discovery/v3/dataApiValidator.js';
import { runV3SqliteMigrations } from '../../src/discovery/v3/schema.js';

function getSqlitePath(): string {
  const dataDir = process.env.DATA_DIR || './data';
  return join(dataDir, 'copytrade.db');
}

const concurrency = Number(process.env.PUBLISH_ENRICH_CONCURRENCY ?? 6);
const delayMs = Number(process.env.PNL_FETCH_DELAY_MS ?? 120);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const sqlitePath = getSqlitePath();
  mkdirSync(dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  try {
    db.pragma('journal_mode = WAL');
    runV3SqliteMigrations(db);
    const rows = db
      .prepare('SELECT DISTINCT proxy_wallet FROM discovery_wallet_scores_v3')
      .all() as { proxy_wallet: string }[];
    console.log(`[05b] refreshing profile PnL for ${rows.length} wallets…`);
    const upd = db.prepare(
      'UPDATE discovery_wallet_scores_v3 SET realized_pnl = ? WHERE proxy_wallet = ?'
    );
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < rows.length; i += concurrency) {
      const batch = rows.slice(i, i + concurrency);
      const pnls = await Promise.all(
        batch.map((r) => fetchReferenceLifetimePnlUsd(r.proxy_wallet))
      );
      for (let j = 0; j < batch.length; j++) {
        const pnl = pnls[j];
        if (pnl == null) {
          fail++;
          continue;
        }
        upd.run(pnl, batch[j].proxy_wallet);
        ok++;
      }
      if (delayMs > 0) await sleep(delayMs);
      if ((i + concurrency) % 100 === 0 || i + concurrency >= rows.length) {
        console.log(`[05b] progress ${Math.min(i + concurrency, rows.length)}/${rows.length}`);
      }
    }
    console.log(`[05b] done: updated=${ok} failed=${fail}`);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
