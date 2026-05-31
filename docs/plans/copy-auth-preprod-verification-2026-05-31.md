# Copy/Auth Pre-Production Verification (2026-05-31)

This document records Stage 3/4 execution status for the Copy-Trading + Hosted Auth remediation program.

## Automated Gate Results

### 1) Build gate

- Command: `npm run build`
- Result: `PASS`

### 2) Lint gate

- Command: `npm run lint`
- Result: `PASS (warnings only)`
- Blocking errors: `0`

### 3) Full test gate

- Command: `npm test`
- Result: `FAIL`
- Summary: `382 tests`, `373 pass`, `9 fail`
- Remaining failing tests are Discovery-focused and out-of-scope for this copy/auth remediation track:
  - `scoreComposite`
  - `safari UI exposes dedicated surface navigation for home, leaderboard, and profile`
  - `discovery advanced controls expose read mode and migration status`
  - `eligibility: observation span just under -> rejected`
  - `eligibility: distinct markets just under -> rejected`
  - `eligibility: trade count just under -> rejected`
  - `eligibility: closed positions just under -> rejected`
  - `eligibility: dormant wallet (31+ days idle) rejected`
  - `scoreTiers rejects ineligible wallets and produces tier rankings`

### 4) Targeted copy/auth safety tests

- Command:
  - `node --test --import tsx tests/secureKeyManager.test.ts tests/walletManager.test.ts tests/copyAuthSafetyPolicies.test.ts`
- Result: `PASS`
- Coverage from this pass:
  - hosted tenant-context enforcement/fallback behavior
  - hosted wallet manager/secure key manager behavior
  - stop-loss valuation fail-safe on missing `curPrice`

## Manual Two-Tenant Hosted Validation

Checklist references:

- `docs/plans/tenant-isolation-verification-checklist.md`
- `docs/plans/hosted-multitenant-manual-checklist.md`

Status: `PENDING MANUAL EXECUTION`

Required sign-off checks still to run on staging:

1. Tenant A/B cannot access each other’s wallet/trade data.
2. Hosted debug/platform routes return expected `403`.
3. End-to-end teammate flow:
   - login
   - add tracked wallet
   - add trading wallet
   - unlock/hosted wallet readiness
   - assign copy wallet
   - start bot
4. Optional small-value live trade smoke test.

## Production Cutover Checklist (Prepared, Not Executed)

Per plan constraints, production changes require explicit sign-off after verification gates.

### Pre-cutover backup

- [ ] Backup `/opt/polymarket-bot`
- [ ] Backup production `.env`
- [ ] Backup production data directory/database

### Deploy readiness

- [ ] Confirm final parity branch/commit SHA
- [ ] Confirm Auth0 production callback/logout URLs for `ditto.jungle.win`
- [ ] Confirm runtime env parity (copy/auth required vars only)

### Cutover execution

- [ ] Deploy approved parity `main` build to production path
- [ ] Restart production service
- [ ] Validate `/health` and `/health/ready`
- [ ] Validate OIDC login and tenant scoping
- [ ] Validate copy-trading dry run / controlled smoke

### Rollback drill

- [ ] Document rollback command sequence
- [ ] Confirm rollback restores code + env + data backups
- [ ] Confirm rollback health checks

## Current Go/No-Go

- Current status: `NO-GO` (full `npm test` still failing due out-of-scope Discovery tests + manual hosted checklist pending).
- Next required step: run manual two-tenant hosted checklist and decide whether to:
  1) temporarily gate release on copy/auth-focused test suite only, or
  2) separately stabilize Discovery test failures before production promotion.

