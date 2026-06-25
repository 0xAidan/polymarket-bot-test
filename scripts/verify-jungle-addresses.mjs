#!/usr/bin/env node
import fs from 'fs';

const agents = JSON.parse(fs.readFileSync('/opt/polymarket-bot/data/jungle_agents.json', 'utf8'))
  .filter((a) => a.enabled);

const fetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
};

for (const agent of agents) {
  const stored = (agent.polymarketAddress || '').toLowerCase();
  const q = encodeURIComponent(agent.displayName);
  const search = await fetchJson(`https://gamma-api.polymarket.com/public-search?q=${q}&search_profiles=true`);
  const profiles = search?.profiles ?? [];
  const exact = profiles.find((p) => (p.name || '').toLowerCase() === agent.displayName.toLowerCase())
    ?? profiles.find((p) => (p.name || '').toLowerCase().includes(agent.displayName.toLowerCase()))
    ?? profiles[0];
  const proxy = (exact?.proxyWallet || '').toLowerCase();
  const activity = stored ? await fetchJson(`https://data-api.polymarket.com/activity?user=${stored}&limit=1`) : [];
  const value = stored ? await fetchJson(`https://data-api.polymarket.com/value?user=${stored}`) : null;
  const proxyActivity = proxy && proxy !== stored ? await fetchJson(`https://data-api.polymarket.com/activity?user=${proxy}&limit=1`) : [];
  const proxyValue = proxy && proxy !== stored ? await fetchJson(`https://data-api.polymarket.com/value?user=${proxy}`) : null;
  console.log(JSON.stringify({
    name: agent.displayName,
    stored,
    gammaName: exact?.name ?? null,
    gammaProxy: proxy || null,
    match: Boolean(stored && proxy && stored === proxy),
    storedActivity: Array.isArray(activity) ? activity.length : null,
    storedValue: value,
    proxyActivity: Array.isArray(proxyActivity) ? proxyActivity.length : null,
    proxyValue,
  }));
}
