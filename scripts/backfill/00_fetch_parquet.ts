/**
 * Phase 1.5 step 0: download markets.parquet (121 MB) locally.
 *
 * For users.parquet (51.5 GB) we refuse to download if <70GB free and emit
 * manual instructions. The actual ingest can always fall back to httpfs via
 * `02_load_events.ts --source-url <HF URL>`.
 */
import { createWriteStream, existsSync, statSync, mkdirSync } from 'fs';
import { statfsSync } from 'fs';
import { dirname, join } from 'path';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';

const HF_BASE = 'https://huggingface.co/datasets/SII-WANGZJ/Polymarket_data/resolve/main';
const DATA_DIR = './data';
const USERS_PARQUET_MIN_FREE_GB = 70;

function bytesFree(path: string): number {
  try {
    const stats: any = (statfsSync as any)(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return Infinity;
  }
}

async function downloadWithProgress(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Fetch ${url} failed: ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? '0');
  mkdirSync(dirname(dest), { recursive: true });
  const file = createWriteStream(dest);
  const reader = (res.body as any).getReader();
  let received = 0;
  const hash = createHash('sha256');
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    hash.update(value);
    file.write(value);
    if (total > 0 && received % (8 * 1024 * 1024) < value.length) {
      const pct = ((received / total) * 100).toFixed(1);
      process.stdout.write(`\r  ${dest}: ${pct}%`);
    }
  }
  await new Promise<void>((res2, rej) => file.end((err: any) => (err ? rej(err) : res2())));
  process.stdout.write(`\n  sha256: ${hash.digest('hex')}\n`);
}

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });

  const marketsPath = join(DATA_DIR, 'markets.parquet');
  if (!existsSync(marketsPath)) {
    console.log(`[00] downloading markets.parquet → ${marketsPath}`);
    await downloadWithProgress(`${HF_BASE}/markets.parquet`, marketsPath);
  } else {
    console.log(`[00] markets.parquet already present (${statSync(marketsPath).size} bytes)`);
  }

  const usersPath = join(DATA_DIR, 'users.parquet');
  const freeBytes = bytesFree(DATA_DIR);
  const freeGB = freeBytes / 1e9;
  if (!existsSync(usersPath)) {
    if (freeGB < USERS_PARQUET_MIN_FREE_GB) {
      console.error(
        `[00] users.parquet not downloaded: need ≥${USERS_PARQUET_MIN_FREE_GB}GB free, only ${freeGB.toFixed(1)}GB available.\n` +
          `[00] options:\n` +
          `     1. Free up disk and re-run\n` +
          `     2. Run 02_load_events.ts with --source-url ${HF_BASE}/users.parquet (httpfs, slow)\n` +
          `     3. Download on a larger machine: wget ${HF_BASE}/users.parquet -O ${usersPath}`
      );
      process.exit(2);
    }
    console.log(`[00] downloading users.parquet → ${usersPath} (≈51.5 GB)`);
    await downloadWithProgress(`${HF_BASE}/users.parquet`, usersPath);
  } else {
    console.log(`[00] users.parquet already present (${statSync(usersPath).size} bytes)`);
  }

  console.log('[00] done.');
}

main().catch((err) => {
  console.error('[00] failed:', err);
  process.exit(1);
});
