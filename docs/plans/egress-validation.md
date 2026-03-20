# Egress validation (Polymarket + Polygon)

Before you trust the bot on a **new VPS** (or after firewall changes), run:

```bash
npm run validate:egress
```

or:

```bash
node scripts/validate-polymarket-egress.mjs
```

## What it checks

1. **Geoblock** — `GET https://polymarket.com/api/geoblock` (see [Polymarket geoblock docs](https://docs.polymarket.com/api-reference/geoblock)). If `blocked` is `true`, trading from that host IP is not allowed; the script exits with failure.
2. **CLOB** — `GET {POLYMARKET_CLOB_API_URL}/time` (default `https://clob.polymarket.com/time`).
3. **Gamma** — `GET {POLYMARKET_GAMMA_API_URL}/markets?limit=1`.
4. **Data API** — `GET {POLYMARKET_DATA_API_URL}/trades?limit=1`.
5. **Polygon RPC** — `eth_blockNumber` JSON-RPC to `POLYGON_RPC_URL` (default `https://polygon-rpc.com`).

Optional env vars match the project’s `.env` / [ENV_EXAMPLE.txt](../../ENV_EXAMPLE.txt). You can raise timeouts with `EGRESS_TIMEOUT_MS` (default `20000`).

## Exit codes

| Code | Meaning |
|------|------------------------|
| `0` | All checks passed |
| `1` | At least one check failed |

Use this on the **target VPS** (or any host in an allowed region) to gate deployment. **Do not** wire it into GitHub Actions by default: hosted runners often sit in regions where `https://polymarket.com/api/geoblock` returns `blocked: true`, which would fail the job even when your EU server is fine.

## Troubleshooting

- **Geoblock FAIL from home:** Your home ISP may be in a restricted country. Re-run from the EU VPS after **0.1** provisioning; that is the result that matters for production.
- **Any other FAIL:** Check outbound HTTPS (port 443), DNS, and firewall rules.
