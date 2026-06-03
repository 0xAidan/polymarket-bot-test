# Roadmap (Maintainer-Facing)

Last validated against repository source and recent `main` commits: 2026-06-03.

This roadmap is implementation-focused, not an idea backlog.

## 1) Current Reality Snapshot

Recent commits on `main` (latest first) show active focus on hosted correctness:

- hosted auto-routing of copy execution to sole credentialed trading wallet
- hosted balance-history correctness
- hosted CLOB auth and trading-wallet setup fixes
- signature mapping and relayer tx-mode alignment
- ethers v6 migration and related balance fixes

Implication: near-term work should prioritize hosted operational reliability and documentation correctness over speculative feature expansion.

## 2) Active Priority Tracks

### Track A — Hosted correctness hardening

Objective:

- keep hosted tenant routing/auth/balance paths deterministic and test-covered

Evidence sources:

- `src/copyTrader.ts`
- `src/walletManager.ts`
- `src/api/routes.ts`
- latest hosted-related commits on `main`

Definition of done:

- behavior covered by tests where practical
- no regressions in build/lint/test
- docs aligned to current behavior

### Track B — Discovery v3 operational stability

Objective:

- keep v3 ingest/refresh/read-model behavior observable and reproducible

Evidence sources:

- `src/discovery/v3/*`
- `scripts/backfill/*`
- `docs/discovery-v3-operations.md`

Definition of done:

- promotion gate and soak checks are usable and documented
- runbooks are free of unverifiable assumptions

### Track C — Deployment runbook reliability

Objective:

- make staging/production handoff deterministic for operators

Evidence sources:

- `scripts/deploy-*.sh`
- `scripts/verify-release-commit.sh`
- `docs/plans/staging-update-handoff.md`
- `docs/plans/hosted-multitenant-deployment-handoff-checklist.md`

Definition of done:

- commands are copy-paste safe for intended environment
- ambiguity around environment-specific readiness checks is explicitly documented

## 3) Explicitly De-Prioritized Here

This roadmap intentionally does not claim active commitment to:

- broad new product feature ideation
- long-horizon speculative roadmap bets
- external competitor-derived ideas

Those can live in separate ideation docs, but this file stays tied to codebase reality and release operations.

## 4) Working Cadence Recommendation

For each release cycle:

1. Review last 10–20 commits on `main`.
2. Identify doc drift in runbooks and onboarding docs.
3. Verify commands/scripts still match code paths.
4. Ship doc + ops corrections in focused PRs.

## 5) Verification Checklist for Any Roadmap Update

Before editing this file, validate:

- `git log --oneline -n 20`
- `package.json` scripts
- `.github/workflows/ci.yml`
- `src/server.ts` route/auth behavior
- `src/config.ts` runtime validation rules

If a roadmap statement cannot be tied to repository evidence, mark it as unverified or remove it.
