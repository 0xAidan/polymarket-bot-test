# Codebase Guide

Maintainer-focused reference for the current repository state.

This guide is intentionally evidence-driven and aligned to:

- current source code under `src/`
- scripts under `scripts/`
- runtime configuration in `ENV_EXAMPLE.txt` and `src/config.ts`
- CI workflow in `.github/workflows/ci.yml`
- recent commits on `main`

## 1) Repository Layout

Top-level directories of operational importance:

- `src/` — application and worker TypeScript source.
- `public/` — static dashboard/admin frontend assets.
- `scripts/` — deployment, validation, and backfill/verification tooling.
- `docs/` — runbooks, plans, research notes.
- `tests/` — Node test suites.
- `deploy/` — reverse proxy/systemd deployment assets.

Important top-level files:

- `package.json` — command surface and dependency truth.
- `ENV_EXAMPLE.txt` — environment variable template.
- `start.cjs` / `setup.cjs` — local runtime launcher and setup helper.
- `Dockerfile` — containerized build/run baseline.

## 2) Runtime Topology

### Application runtime

- Entry: `src/index.ts`
- Server wiring: `src/server.ts`
- Main API router: `src/api/routes.ts`
- Auth and tenant context are resolved before protected API handlers.

### Discovery worker runtime

- Entry: `src/discovery/discoveryWorker.ts`
- Legacy discovery cycle runs continuously when discovery config is enabled.
- Discovery v3 worker bootstrap is additive and flag-gated.

### Process model in local development

`npm run dev` (`node start.cjs`) starts both watchers:

- app watcher: `npx tsx watch src/index.ts`
- worker watcher: `npx tsx watch src/discovery/discoveryWorker.ts`

## 3) Authentication and Tenant Model

Source files:

- `src/config.ts`
- `src/server.ts`
- `src/hostedMode.ts`
- `src/authStore.ts`
- `src/tenantContext.ts`

Modes:

- **legacy** — bearer token style (`API_SECRET`) for API protection.
- **oidc** — Auth0 OIDC session auth using `express-openid-connect`.

Hosted multi-tenant mode is code-defined as:

- `AUTH_MODE=oidc` and `STORAGE_BACKEND=sqlite`.

Hosted mode invariants enforced in config validation:

- server `PRIVATE_KEY` must be absent.
- production `DATA_DIR` must be absolute.

## 4) Core Trading Pipeline (Current)

Key files:

- `src/walletMonitor.ts`
- `src/copyTrader.ts`
- `src/tradeExecutor.ts`
- `src/clobClient.ts`
- `src/clobClientFactory.ts`
- `src/walletManager.ts`

Operational flow:

1. Wallet monitor detects external trade activity.
2. Copy trader applies guards/filters/sizing rules.
3. Trade executor submits orders through CLOB client stack.
4. Trade and performance state persist through storage/database surfaces.

Recent commit emphasis (2026-06-01):

- hosted copy-assignment fallback routing
- hosted trading-wallet balance fixes
- hosted CLOB auth and wallet setup adjustments

These changes indicate active behavior in hosted routing/balance/auth paths; treat older docs that predate these commits as potentially stale.

## 5) Discovery Surfaces

### Legacy discovery API

- Router: `src/api/discoveryRoutes.ts`
- Mounted at `/api/discovery`

### Discovery v3 API

- Router: `src/api/discoveryRoutesV3.ts`
- Mounted at `/api/discovery/v3` when `DISCOVERY_V3=true`
- Read routes are public by mount strategy in `src/server.ts`
- Mutating routes use `requireAuthForMutations`

### Discovery v3 worker integration

- Flag helpers: `src/discovery/v3/featureFlag.ts`
- Bootstrap: `src/discovery/v3/workerIntegration.ts`
- Long-running loops:
  - optional Goldsky listener
  - optional RPC log poller
  - refresh/scoring loop

## 6) Storage and Data Backends

Files:

- `src/storage.ts`
- `src/database.ts`

Backends:

- `json` backend (default): file-based state under `DATA_DIR`
- `sqlite` backend: `copytrade.db` under `DATA_DIR`

Discovery v3 compute/read model split:

- DuckDB sidecar for heavy analytics/backfill
- SQLite for hot read model endpoints

## 7) Command Reference (Verified from `package.json`)

Core:

- `npm run setup`
- `npm run dev`
- `npm run dev:app`
- `npm run dev:discovery`
- `npm run build`
- `npm run lint`
- `npm run test`

Runtime one-shot:

- `npm run start:app`
- `npm run start:discovery`
- `npm run start:prod:app`
- `npm run start:prod:discovery`

Ops/validation:

- `npm run validate:egress`
- `npm run verify:pnl*`
- `npm run verify:promotion-gate`
- `npm run verify:staging-display`
- `npm run verify:soak`

## 8) CI Truth

Current CI file: `.github/workflows/ci.yml`

Pipeline:

1. Node 22 setup
2. `npm ci --legacy-peer-deps`
3. `npm run build`
4. `npm run lint`
5. `npm run test`
6. `node --test --import tsx tests/v3-pnl-formula.test.ts`

## 9) Deployment Assets

Script surface:

- `scripts/deploy-staging.sh`
- `scripts/deploy-production.sh`
- `scripts/deploy-staging-v2.sh`
- `scripts/deploy-production-v2.sh`
- `scripts/verify-release-commit.sh`

Infrastructure assets:

- `deploy/Caddyfile`
- `deploy/Caddyfile.staging.example`
- `deploy/systemd/*`

Always inspect script assumptions before use (paths, service names, hostnames, privileges).

## 10) Documentation Integrity Notes

When updating docs:

- prefer `src/` + `package.json` + `scripts/` + recent commits over older markdown prose
- avoid copying historical assumptions (IPs, branch names, one-off rollout context) into evergreen docs
- mark unverified operational assumptions explicitly when they cannot be proven from repository code alone

## 11) Suggested Reading Order for New Maintainers

1. `README.md`
2. `src/index.ts`
3. `src/server.ts`
4. `src/config.ts`
5. `src/copyTrader.ts`
6. `src/api/routes.ts`
7. `docs/discovery-v3-operations.md`
8. `scripts/` deployment and verification scripts
