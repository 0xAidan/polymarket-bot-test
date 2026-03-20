#!/usr/bin/env node
/**
 * Validates outbound connectivity from this host to Polymarket and Polygon.
 * Run on a new VPS before deploying the bot: `node scripts/validate-polymarket-egress.mjs`
 *
 * Exit 0 = all required checks passed.
 * Exit 1 = one or more checks failed (see printed lines).
 *
 * Env (optional, defaults match src/config.ts / ENV_EXAMPLE.txt):
 *   POLYMARKET_CLOB_API_URL, POLYMARKET_DATA_API_URL, POLYMARKET_GAMMA_API_URL, POLYGON_RPC_URL
 *   EGRESS_TIMEOUT_MS (default 20000)
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2].replace(/\s+#.*$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v) process.env[m[1]] = v;
  }
}

const timeoutMs = Number(process.env.EGRESS_TIMEOUT_MS) || 20000;

const stripSlash = (u) => (typeof u === 'string' ? u.replace(/\/+$/, '') : u);

const defaults = {
  POLYMARKET_CLOB_API_URL: 'https://clob.polymarket.com',
  POLYMARKET_DATA_API_URL: 'https://data-api.polymarket.com',
  POLYMARKET_GAMMA_API_URL: 'https://gamma-api.polymarket.com',
  POLYGON_RPC_URL: 'https://polygon-rpc.com',
};

const clob = stripSlash(process.env.POLYMARKET_CLOB_API_URL || defaults.POLYMARKET_CLOB_API_URL);
const data = stripSlash(process.env.POLYMARKET_DATA_API_URL || defaults.POLYMARKET_DATA_API_URL);
const gamma = stripSlash(process.env.POLYMARKET_GAMMA_API_URL || defaults.POLYMARKET_GAMMA_API_URL);
const rpc = stripSlash(process.env.POLYGON_RPC_URL || defaults.POLYGON_RPC_URL);

function withTimeout(signal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

async function getText(url, init = {}) {
  const { signal, done } = withTimeout(init.signal);
  try {
    const res = await fetch(url, { ...init, signal });
    return res;
  } finally {
    done();
  }
}

let allOk = true;

// 1) Geoblock — https://docs.polymarket.com/api-reference/geoblock
{
  const res = await getText('https://polymarket.com/api/geoblock');
  if (!res.ok) {
    console.log(`FAIL  geoblock  HTTP ${res.status} https://polymarket.com/api/geoblock`);
    allOk = false;
  } else {
    try {
      const j = await res.json();
      const blocked = j.blocked === true;
      const ip = j.ip ?? '?';
      const country = j.country ?? '?';
      if (blocked) {
        console.log(`FAIL  geoblock  IP ${ip} (${country}) — Polymarket reports this IP as blocked for trading`);
        allOk = false;
      } else {
        console.log(`PASS  geoblock  IP ${ip} (${country}) — not blocked`);
      }
    } catch (e) {
      console.log(`FAIL  geoblock  could not parse JSON (${e.message})`);
      allOk = false;
    }
  }
}

// 2) CLOB time
{
  const res = await getText(`${clob}/time`);
  if (res.ok) {
    console.log(`PASS  CLOB time  HTTP ${res.status}`);
  } else {
    console.log(`FAIL  CLOB time  HTTP ${res.status} ${clob}/time`);
    allOk = false;
  }
}

// 3) Gamma
{
  const res = await getText(`${gamma}/markets?limit=1`);
  if (res.ok) {
    console.log(`PASS  Gamma markets  HTTP ${res.status}`);
  } else {
    console.log(`FAIL  Gamma markets  HTTP ${res.status} ${gamma}/markets?limit=1`);
    allOk = false;
  }
}

// 4) Data API
{
  const res = await getText(`${data}/trades?limit=1`);
  if (res.ok) {
    console.log(`PASS  Data API trades  HTTP ${res.status}`);
  } else {
    console.log(`FAIL  Data API trades  HTTP ${res.status} ${data}/trades?limit=1`);
    allOk = false;
  }
}

// 5) Polygon JSON-RPC
{
  const { signal, done } = withTimeout();
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1,
      }),
      signal,
    });
    const j = await res.json().catch(() => null);
    const hex = j && j.result;
    if (res.ok && hex && typeof hex === 'string' && hex.startsWith('0x')) {
      console.log(`PASS  Polygon RPC  HTTP ${res.status}  latest block ${hex}`);
    } else {
      console.log(`FAIL  Polygon RPC  HTTP ${res.status} ${rpc}`);
      allOk = false;
    }
  } catch (e) {
    console.log(`FAIL  Polygon RPC  (${e.message}) ${rpc}`);
    allOk = false;
  } finally {
    done();
  }
}

if (allOk) {
  console.log('\nAll egress checks passed.');
  process.exit(0);
}
console.log('\nOne or more egress checks failed. Fix network/firewall/region before deploying the bot.');
process.exit(1);
