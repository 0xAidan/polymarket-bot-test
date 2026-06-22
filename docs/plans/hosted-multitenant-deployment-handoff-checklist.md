# Hosted Multi-Tenant Deployment Handoff Checklist

Use this checklist to deploy hosted multi-tenant mode with evidence-first verification.

## 1) Preconditions (Must Be True)

- Target commit is selected and recorded.
- Deployment environment has approved DNS/domain and TLS plan.
- Operators have SSH and sudo access to deployment host.
- Rollback path is documented (previous commit + data/env backup strategy).

## 2) Repository Truth Gates

Validate from source before touching infrastructure:

```bash
git log --oneline -n 20
npm run build
npm run lint
npm test
```

Hosted-mode code invariants to verify:

- `src/hostedMode.ts` defines hosted mode as OIDC + SQLite.
- `src/config.ts` enforces:
  - `STORAGE_BACKEND=sqlite`
  - server `PRIVATE_KEY` forbidden in hosted mode
  - production `DATA_DIR` absolute path requirement

## 3) Server Runtime Setup

Minimum server requirements:

- Node/npm installed
- git installed
- service manager available (`systemd` expected by repo deploy scripts)
- reverse proxy and TLS configured for target domain

Evidence:

- command outputs for runtime versions and service availability

## 4) Environment Configuration Checklist

Required hosted-mode env posture:

- `AUTH_MODE=oidc`
- `STORAGE_BACKEND=sqlite`
- `AUTH_SESSION_SECRET` set
- Auth0 OIDC vars set:
  - `AUTH0_ISSUER_BASE_URL`
  - `AUTH0_BASE_URL`
  - `AUTH0_CLIENT_ID`
  - `AUTH0_CLIENT_SECRET`
- `DATA_DIR` set to server-owned absolute path
- `PRIVATE_KEY` absent from server env

Optional hardening:

- `REQUIRE_API_SECRET=true` when operating in legacy mode paths
- explicit `CORS_ALLOWED_ORIGINS` where required

Evidence:

- redacted env excerpt showing required keys and hosted-safe posture

## 5) Deploy Procedure (Template)

Use repo deployment scripts as baseline and adapt to environment-specific paths/services:

- `scripts/deploy-staging.sh`
- `scripts/deploy-production.sh`
- `scripts/deploy-staging-v2.sh`
- `scripts/deploy-production-v2.sh`

Before restarting services, capture:

```bash
git rev-parse HEAD
```

After restart, capture:

- service status output
- health endpoint output (`/health`)

## 6) Mandatory Post-Deploy Verification

### 6.1 Connectivity gate

Run from target host:

```bash
npm run validate:egress
```

### 6.2 Auth and tenant gate

Verify:

- OIDC login succeeds
- user session resolves tenant context
- tenant switch behavior works only for authorized memberships

### 6.3 Hosted-mode safety gate

Verify startup does not fail hosted-mode validation and no server-level private key is used.

### 6.4 Discovery/worker gate

If discovery worker is part of release:

- verify worker service is running
- verify discovery status endpoints respond

## 7) Staging-to-Production Promotion Gate

Promote only if all are true:

- staging ran the exact candidate commit
- staging smoke checks passed
- no critical log errors observed
- release commit verified with:

```bash
./scripts/verify-release-commit.sh <expected-commit-sha>
```

## 8) Evidence Pack (Required for Signoff)

Attach:

- deployed commit SHA
- build/lint/test outputs
- egress validation output
- service status output
- `/health` output from deployed host/domain
- tenant/auth verification evidence
- rollback reference (previous commit + backup location)

## 9) Unverified-by-Repository Items (Operator Must Confirm Per Environment)

These are environment-specific and not guaranteed by app code alone:

- availability/behavior of `/health/ready` behind proxy/infrastructure
- exact systemd service names on target host
- exact deployment path layout on target host
- DNS/TLS propagation timing

Record these explicitly during each rollout.
