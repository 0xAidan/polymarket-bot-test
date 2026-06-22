# Agents Knowledge (Repository Source-of-Truth)

Audience: maintainers and contributors who need a fast, accurate orientation to the current repo.

This document is intentionally grounded in repository evidence (code/config/scripts/CI).

## 1) Project Identity

- Package: `polymarket-copytrade-bot`
- Runtime: Node + TypeScript (ESM)
- Core purpose: copy-trade execution + discovery services + dashboard/API operations

Primary evidence:

- `package.json`
- `src/index.ts`
- `src/server.ts`

## 2) Runtime Entry Points

- App runtime: `src/index.ts`
- Discovery worker runtime: `src/discovery/discoveryWorker.ts`
- Local dual-process launcher: `start.cjs`

Key command mappings:

- `npm run dev` -> `node start.cjs`
- `npm run start:app` -> `tsx src/index.ts`
- `npm run start:discovery` -> `tsx src/discovery/discoveryWorker.ts`
- `npm run start:prod:app` -> `node dist/index.js`
- `npm run start:prod:discovery` -> `node dist/discovery/discoveryWorker.js`

## 3) Authentication and Multi-Tenant Model

Files:

- `src/config.ts`
- `src/server.ts`
- `src/hostedMode.ts`

Auth modes:

- legacy (`API_SECRET` bearer)
- oidc (Auth0 session)

Hosted mode detection:

- `AUTH_MODE=oidc` + `STORAGE_BACKEND=sqlite`

Hosted mode guardrails enforced in config validation:

- no server-level `PRIVATE_KEY`
- absolute `DATA_DIR` in production hosted mode

## 4) Core APIs

Mounted in `src/server.ts`:

- `/api` -> main router (`src/api/routes.ts`)
- `/api/discovery` -> legacy discovery router
- `/api/discovery/v3` -> v3 router (when enabled)
- `/health` -> app health endpoint

Discovery v3 auth behavior:

- read endpoints are public when mounted
- mutating endpoints are route-gated (`requireAuthForMutations`)

## 5) Discovery v3 Facts

Files:

- `src/discovery/v3/featureFlag.ts`
- `src/discovery/v3/workerIntegration.ts`
- `src/api/discoveryRoutesV3.ts`

Operational facts:

- v3 is off unless `DISCOVERY_V3=true`
- DuckDB path defaults to `./data/discovery_v3.duckdb`
- Goldsky listener is cutover-aware and can be forced by env var
- RPC forward-fill poller is enabled by default when v3 is enabled

## 6) CI Contract

File: `.github/workflows/ci.yml`

Pipeline contract:

1. install (`npm ci --legacy-peer-deps`)
2. build (`npm run build`)
3. lint (`npm run lint`)
4. tests (`npm run test`)
5. extra test (`tests/v3-pnl-formula.test.ts`)

Node version in CI: 22.

## 7) Deploy/Runbook Assets

Key scripts:

- `scripts/deploy-staging.sh`
- `scripts/deploy-production.sh`
- `scripts/deploy-staging-v2.sh`
- `scripts/deploy-production-v2.sh`
- `scripts/verify-release-commit.sh`

Key runbooks:

- `docs/plans/staging-update-handoff.md`
- `docs/plans/hosted-multitenant-deployment-handoff-checklist.md`
- `docs/discovery-v3-operations.md`

## 8) Known Verification Gaps (Repo-Only View)

The following are not provable from app code alone and must be verified per environment:

- whether `/health/ready` is served by infrastructure
- exact production/staging service names on target hosts
- host-specific deployment paths and DNS/TLS behavior

## 9) How to Keep This File Accurate

Before updating, verify:

```bash
git log --oneline -n 20
npm run build
npm run lint
npm test
```

If `npm test` fails with a shell glob expansion issue for `tests/**/*.test.ts`, use:

```bash
node --test --import tsx tests/*.test.ts
```

Then reconcile against:

- `package.json`
- `src/config.ts`
- `src/server.ts`
- `src/index.ts`
- `src/discovery/discoveryWorker.ts`
- `.github/workflows/ci.yml`
