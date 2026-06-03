# Polymarket Copytrade Bot

Production-focused TypeScript service for:

- Copy trading selected Polymarket wallets.
- Managing copy-trade safety controls and wallet assignments.
- Running discovery pipelines (legacy discovery and Discovery v3).
- Operating in single-tenant or hosted multi-tenant mode.

This document is a source-of-truth operational guide based on current repository code, scripts, and recent commits.

## Safety First

- This software can execute real-money trades.
- Test with small sizes before any real rollout.
- Never commit `.env`, private keys, keystore files, or database files.
- Keep `npm test`, `npm run lint`, and `npm run build` green before shipping.

## Runtime Baseline

- **Recommended local Node.js:** 22.x (matches CI in `.github/workflows/ci.yml`).
- **Container base image:** Node 20 (`Dockerfile`).
- **Package manager:** npm.
- **Language/runtime:** TypeScript + ESM (`"type": "module"`).

## Quick Start (Local Development)

```bash
npm install
npm run setup
npm run dev
```

Then open:

- App UI: `http://localhost:3001`
- Health check: `http://localhost:3001/health`

What `npm run dev` does:

- Starts the app watcher (`src/index.ts`).
- Starts the discovery worker watcher (`src/discovery/discoveryWorker.ts`).
- Prompts for setup only if `.env` is missing.

## High-Level Architecture

Primary runtime components:

- `src/index.ts`: app bootstrap, setup guard, runtime mode dispatch.
- `src/server.ts`: Express server, auth gates, API route mounts, static UI serving.
- `src/copyTrader.ts`: copy-trade orchestration and trade safety decisions.
- `src/tradeExecutor.ts` + `src/clobClient*.ts`: order construction/submission.
- `src/discovery/discoveryWorker.ts`: discovery worker runtime.
- `src/discovery/v3/*`: Discovery v3 ingest, scoring, worker integration.
- `src/storage.ts` + `src/database.ts`: JSON/SQLite persistence surfaces.

Related docs:

- `CODEBASE_GUIDE.md` (maintainer architecture and operations)
- `docs/discovery-v3-operations.md` (Discovery v3 runbook)

## Authentication Modes

Configured in `src/config.ts` and enforced in `src/server.ts`.

### Legacy mode

- `AUTH_MODE=legacy` (or default when OIDC vars are absent).
- Uses bearer token auth via `API_SECRET` for protected `/api` routes.
- If `REQUIRE_API_SECRET=true` and `API_SECRET` is missing, startup fails closed.

### OIDC mode

- `AUTH_MODE=oidc`.
- Requires:
  - `AUTH_SESSION_SECRET`
  - `AUTH0_ISSUER_BASE_URL`
  - `AUTH0_BASE_URL`
  - `AUTH0_CLIENT_ID`
  - `AUTH0_CLIENT_SECRET`
- Used for hosted/multi-tenant deployments.

## Hosted Multi-Tenant Mode

Hosted mode is detected by code as:

- `AUTH_MODE=oidc` **and** `STORAGE_BACKEND=sqlite`

In hosted mode:

- Server-level `PRIVATE_KEY` is forbidden by validation.
- Tenant wallets are expected through encrypted keystore flows.

See:

- `src/hostedMode.ts`
- `src/config.ts`

## Commands (Source: `package.json`)

### Core

- `npm run setup`: interactive `.env` generator.
- `npm run dev`: app + discovery worker (watch mode).
- `npm run dev:app`: alias to `node start.cjs` (same dual-process runner).
- `npm run dev:discovery`: discovery worker watch only.
- `npm run build`: TypeScript compile to `dist/`.
- `npm run start`: same as `dev` (`node start.cjs`).
- `npm run lint`: ESLint for `src/**/*.ts`.
- `npm test`: Node test runner with `tsx`.

### Runtime-specific

- `npm run start:app`: run app once via `tsx src/index.ts`.
- `npm run start:discovery`: run discovery worker once via `tsx src/discovery/discoveryWorker.ts`.
- `npm run start:prod:app`: run built app (`node dist/index.js`).
- `npm run start:prod:discovery`: run built worker (`node dist/discovery/discoveryWorker.js`).

### Verification / Ops helpers

- `npm run validate:egress`
- `npm run verify:pnl`
- `npm run verify:pnl:smoke`
- `npm run verify:pnl:full`
- `npm run verify:pnl:dry-run`
- `npm run verify:promotion-gate`
- `npm run verify:staging-display`
- `npm run verify:soak`

## Environment Configuration

Use:

```bash
cp ENV_EXAMPLE.txt .env
```

Then edit `.env` values.

Important notes from current code/config:

- `POLYMARKET_BUILDER_CODE` is optional for order attribution in V2.
- Legacy builder HMAC credentials are still used for relayer flows.
- `MONITORING_INTERVAL_MS` defaults to `5000` in code if unset.
- `STORAGE_BACKEND` defaults to `json` if unset.

For complete variable reference, use `ENV_EXAMPLE.txt` and `src/config.ts`.

## API Surfaces

Mounted in `src/server.ts`:

- `/api/*` primary application API (`src/api/routes.ts`).
- `/api/discovery/*` legacy discovery API (`src/api/discoveryRoutes.ts`).
- `/api/discovery/v3/*` Discovery v3 API (`src/api/discoveryRoutesV3.ts`).
- `/api/olympics/*` olympics routes.
- `/health` health endpoint.

Auth behavior:

- Discovery v3 read endpoints are mounted publicly when v3 is enabled.
- Discovery v3 mutating endpoints require auth middleware at route level.

## Discovery v3 Operational Notes

- Feature-flagged by `DISCOVERY_V3=true`.
- Worker bootstrap is in `src/discovery/discoveryWorker.ts` via `startDiscoveryV3Worker`.
- Goldsky listener is disabled by default after V2 cutover unless explicitly enabled.
- RPC log forward-fill is enabled by default when v3 is enabled.

Use `docs/discovery-v3-operations.md` for runbook details.

## CI and Quality Gate

Current CI workflow (`.github/workflows/ci.yml`) runs:

- `npm ci --legacy-peer-deps`
- `npm run build`
- `npm run lint`
- `npm run test`
- `node --test --import tsx tests/v3-pnl-formula.test.ts`

Before opening a PR, run the same checks locally.
If your shell environment does not expand `tests/**/*.test.ts` for `npm test`, run:

```bash
node --test --import tsx tests/*.test.ts
```

## Deployment Scripts

Repository deployment helpers live in `scripts/`:

- `deploy-staging.sh`, `deploy-production.sh`
- `deploy-staging-v2.sh`, `deploy-production-v2.sh`
- `verify-release-commit.sh`

Review script assumptions (paths, service names, target host) before running on any server.

## Troubleshooting

- **App not starting with config errors:** inspect `src/config.ts` validation requirements.
- **Auth failures:** verify mode (`AUTH_MODE`) and matching secret/provider variables.
- **No trades copied:** check tracked wallets are active and bot status is started.
- **Discovery v3 endpoints return 404:** ensure `DISCOVERY_V3=true`.
- **Hosted mode startup fails with PRIVATE_KEY present:** remove `PRIVATE_KEY` from server env in hosted setup.
- **`npm test` says it cannot find `tests/**/*.test.ts`:** run `node --test --import tsx tests/*.test.ts` in the same repo checkout.

## Contribution Workflow

1. Create a feature/fix/docs branch.
2. Make focused changes.
3. Run build/lint/tests.
4. Open PR with verification evidence.
5. Merge only after CI and review pass.

If you need a deeper systems map, open `CODEBASE_GUIDE.md`.
