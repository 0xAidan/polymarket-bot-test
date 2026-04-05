# Tenant Isolation Verification Checklist

Use this checklist before promoting hosted multi-tenant builds.

This checklist is a **release gate** for hosted deployments. Do not promote or restart production on a new release candidate until every item below has evidence attached to the deployment notes.

## Goal

Prove that two different tenants cannot read each other's wallet data, balances, positions, or diagnostics.

## Preconditions

- `AUTH_MODE=oidc`
- `STORAGE_BACKEND=sqlite`
- `PRIVATE_KEY` is not set in server `.env`
- Hosted app is running
- Two users exist in different tenants:
  - Tenant A user
  - Tenant B user

## Test Data Setup

1. Log in as Tenant A user.
2. Add tracked wallet `0xA...` in Tenant A.
3. Confirm Tenant A wallet list contains `0xA...`.
4. Log out.
5. Log in as Tenant B user.
6. Add tracked wallet `0xB...` in Tenant B.
7. Confirm Tenant B wallet list contains `0xB...`.
8. Confirm Tenant B wallet list does not contain `0xA...`.

## API Isolation Checks

Run each call as Tenant B (with Tenant B auth and tenant header).

1. `GET /api/wallets/:address/balance` using Tenant A wallet address:
   - Expected: `404` with `Wallet not found in this profile`.
2. `GET /api/wallets/:address/positions` using Tenant A wallet address:
   - Expected: `404`.
3. `GET /api/wallets/:address/stats` using Tenant A wallet address:
   - Expected: `404`.
4. `GET /api/wallets/:address/trades` using Tenant A wallet address:
   - Expected: `404`.

Repeat in reverse (Tenant A requesting Tenant B wallet) and expect the same failures.

## Hosted Debug Surface Checks

For each tenant user:

1. `GET /api/test/clob-connectivity`
   - Expected: `403` with hosted-mode disabled message.
2. `GET /api/test/balance/:address`
   - Expected: `403`.
3. `GET /api/platforms`
   - Expected: `403`.
4. `GET /api/platforms/:platform/balance`
   - Expected: `403`.
5. `GET /api/platforms/:platform/positions/:identifier`
   - Expected: `403`.

## UI Isolation Checks

1. Open Tenant A dashboard and capture tracked-wallet balances.
2. Open Tenant B dashboard and capture tracked-wallet balances.
3. Confirm:
   - Tenant A sees only Tenant A wallets.
   - Tenant B sees only Tenant B wallets.
   - No identical value artifacts caused by shared proxy/funder fallback.

## Runtime Guardrail Checks

Review logs while running the checks:

- There should be no successful hosted usage of global CLOB client.
- There should be no hosted proxy resolution using env funder fallback.
- Any blocked cross-profile access should be logged as warning.

## Evidence To Capture

Save these artifacts with the release notes or deployment handoff:

- screenshots of Tenant A and Tenant B dashboards
- raw API responses for blocked cross-tenant route checks
- log excerpts showing blocked fallback attempts only
- exact deployed commit SHA / PR link used for the verification run

## Pass Criteria

All conditions must be true:

- Cross-tenant wallet address routes return `404`.
- Hosted debug/platform routes return `403`.
- UI wallet lists and balances stay tenant-specific.
- Logs show blocked fallback attempts only, not successful global fallbacks.
- Evidence artifacts are attached to the release candidate notes.

If any check fails, do not promote to production.
