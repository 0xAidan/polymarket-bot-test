# AGENTS.md

This repo is a TypeScript/Node (ESM) Polymarket copy-trading bot ("Ditto"). For
architecture, commands, and env reference, see `README.md`, `CODEBASE_GUIDE.md`,
`package.json` scripts, and `ENV_EXAMPLE.txt`. Deep project knowledge lives in
`.cursor/rules/agent-knowledge.mdc`.

## Cursor Cloud specific instructions

Dependencies are already installed by the startup update script (`npm ci
--legacy-peer-deps`). Node 22 is required (matches CI). Native modules
(`better-sqlite3`, `duckdb`) compile during install and load fine here.

### Running locally (simplest dev config)
- A `.env` is required and is gitignored — it is NOT created for you. The
  interactive wizard (`npm run setup` / `node start.cjs` first run) cannot run
  unattended; create `.env` directly instead (copy `ENV_EXAMPLE.txt` and edit).
- Simplest local boot: `AUTH_MODE=legacy`, `STORAGE_BACKEND=json`, a throwaway
  unfunded `PRIVATE_KEY`, `POLYMARKET_SIGNATURE_TYPE=0`. Copy trading only
  executes on an explicit user action (enable copying) with active wallets, so an
  unfunded key is safe for dev/demo.
- `npm run dev` (via `start.cjs`) runs BOTH the app (`:3001`) and the discovery
  worker (`:3002`). `/health` and the dashboard (`/app`) confirm it is up.

### Non-obvious gotchas (these will bite you)
- **Legacy auth: `API_SECRET` must be set.** An empty `API_SECRET` does NOT mean
  "open API" — every `/api/*` route is blocked with `403 "Platform admin
  required"` because `createAdminAnalyticsRouter` mounts a blanket
  `requirePlatformAdmin` at `/api`. Set `API_SECRET` and send `Authorization:
  Bearer <API_SECRET>`. In the UI, open `http://localhost:3001/app` (the landing
  page login buttons target an OIDC route that does not exist in legacy mode) and
  enter the token in the "Technical fallback" modal.
- **Polygon RPC:** the default `https://polygon-rpc.com` returns HTTP 403
  ("tenant disabled") in this environment and floods logs with "JsonRpcProvider
  failed to detect network". Use `POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com`.
- **Tests corrupt `./data`:** the suite writes to the real `./data` dir and
  concurrent writes can corrupt `data/bot_config.json`. After running tests,
  `npm run dev` may crash at boot with `SyntaxError: Unexpected non-whitespace
  character after JSON`. Fix by deleting the untracked test artifacts:
  `rm -f data/bot_config.json data/copytrade.db*` (only `data/jungle_agents.json`
  is tracked; the app regenerates the rest).

### Testing
- `npm run lint` (0 errors, warnings only) and `npm run build` pass cleanly.
- `npm test` hangs at the end: `tests/jungleAgents.test.ts` makes live Polymarket
  network calls and leaves an open handle. Bound it with a per-test timeout:
  `node --test --test-timeout=45000 --import tsx tests/*.test.ts`. ~487/491 pass;
  the few failures are pre-existing (frontend content-assertion drift in
  `discovery-ui-contract` / `frontend-script-load`, plus the network-dependent
  `jungleAgents` file) and are unrelated to environment setup.
