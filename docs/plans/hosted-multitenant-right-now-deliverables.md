# Hosted Multitenant Right-Now Deliverables

This document implements the attached "Hosted Multitenant Right-Now Plan" without editing the plan file itself.

Sources used:
- [Deployment handoff checklist](/Users/aidannugent/websites/polymarket-bot-test/docs/plans/hosted-multitenant-deployment-handoff-checklist.md)
- [Execution plan](/Users/aidannugent/websites/polymarket-bot-test/docs/plans/hosted-multitenant-execution-plan.md)
- [Enterprise implementation plan](/Users/aidannugent/websites/polymarket-bot-test/docs/plans/hosted-multitenant-enterprise-implementation-plan.md)
- [Hosted rollout transcript](a74eaa5d-7d8a-40f6-86a5-22bb2a199f3b)

---

## 1) Claim-vs-Verified Matrix (Checklist mapped)

Status labels:
- `Verified in current branch` = present in `/Users/aidannugent/websites/polymarket-bot-test` now
- `Exists in another worktree/branch` = found in `/Users/aidannugent/.config/superpowers/worktrees/polymarket-bot-test/feature-hosted-multitenant`
- `Not started / no current evidence` = no technical proof located yet

| Checklist item | Current status | Evidence |
| --- | --- | --- |
| 1.1 Server confirmed | Not started / no current evidence | No Hetzner screenshot artifact committed |
| 1.2 SSH access established | Not started / no current evidence | No SSH proof artifact committed |
| 1.3 Network security baseline | Not started / no current evidence | No firewall proof artifact committed |
| 2.1 DNS record created | Not started / no current evidence | No DNS proof artifact committed |
| 2.2 TLS reachability prepared | Not started / no current evidence | No cert/reachability proof artifact committed |
| 3.1 Runtime dependencies installed | Exists in another worktree/branch | `feature-hosted-multitenant` has deploy scaffolding (`deploy/`, production scripts) |
| 3.2 Directory layout created | Exists in another worktree/branch | Worktree contains deployment scripts using `/opt/polymarket/app` and `/var/lib/polymarket/data` conventions |
| 3.3 Repo deployed to server | Not started / no current evidence | No live VPS build/install evidence in repo |
| 4.1 Server environment configured | Not started / no current evidence | No server startup logs/proof committed |
| 4.2 Secret ownership + rotation defined | Not started / no current evidence | SOP not yet present in docs |
| 5.1 Systemd services installed/enabled | Exists in another worktree/branch | Worktree has `deploy/` assets and service configuration edits |
| 5.2 Reverse proxy + HTTPS live | Exists in another worktree/branch | Worktree includes reverse proxy assets; no live cert proof yet |
| 5.3 Backup policy active | Exists in another worktree/branch | Worktree includes `scripts/backup-data.sh` |
| 5.4 Restore drill completed | Not started / no current evidence | No restore validation artifact located |
| 6.1 Egress validation gate | Verified in current branch | `scripts/validate-polymarket-egress.mjs` exists on current branch |
| 6.2 Fallback provider if egress fails | Not started / no current evidence | Process documented in plans; no fallback run proof |
| 7.1 Finish remaining multitenant implementation | Exists in another worktree/branch | Worktree shows large multitenant set (`src/tenantContext.ts`, tenant-aware DB/storage/runtime edits, `src/clobRateLimiter.ts`) |
| 7.2 OIDC/Auth0 integration | Not started / no current evidence | Current branch has no OIDC/Auth0 implementation; worktree tenant context exists but no full Auth0 flow evidence |
| 7.3 Admin controls and monitoring UI | Not started / no current evidence | No committed admin multitenant UI/monitoring completion proof found |

### Critical reconciliation finding

The transcripted implementation work appears to live in an isolated worktree with many uncommitted changes and is **not** present in `main` yet. Also, `feature/hosted-multitenant` currently points to `main` HEAD in this repository, so branch name alone is not carrying those changes.

---

## 2) 48-Hour Owner Action Board

### Aidan (Hetzner owner) - next 24h

1. Confirm server facts in Hetzner: region/size/public IPv4.
2. Confirm SSH access path from approved machine.
3. Attach firewall allowing inbound `22`, `80`, `443` only.

Required evidence to collect:
- Hetzner server overview screenshot (region/spec/IP).
- Terminal proof of successful SSH login.
- Firewall screenshot/export showing attached rule set.

### Tech Team (DNS owner) - next 24h

1. Create A record for production host to `46.62.231.173`.
2. Verify resolver output (`dig`/`nslookup`) from public network.
3. Confirm `80`/`443` reachable for certificate issuance.

Required evidence to collect:
- DNS panel screenshot.
- Resolver output snippet.
- Reachability or cert issuance logs.

### Deploy Operator - next 24-48h

1. Reconcile and stage deploy assets from the multitenant worktree into an integration branch.
2. Install runtime deps and create directory layout on VPS.
3. Deploy app, run build, install/enable services, and configure reverse proxy.
4. Run `npm run validate:egress` from VPS and archive output.
5. Configure backups and execute one restore drill.

Required evidence to collect:
- Runtime version outputs (`node -v`, `npm -v`, `git --version`, proxy version).
- `ls -ld` output for app/data dirs.
- Build output from deploy run.
- `systemctl status` and `systemctl is-enabled`.
- TLS certificate proof.
- Backup job logs and restore validation output.

### Engineering - next 24-48h

1. Merge/rebase isolated multitenant worktree changes into a reviewable PR branch.
2. Run full verification (`npm run build`, `npm test`) on merged branch.
3. Close remaining Phase 3b+ gaps before Auth0/UI phases.
4. Prepare Auth0/OIDC integration branch once credentials and callback domains are fixed.

Required evidence to collect:
- PR link(s).
- Test/build outputs.
- Diff list grouped by execution plan phase.

---

## 3) Repo Work That Can Proceed Right Now (No Hetzner/DNS/Auth0 needed)

Execution order stays aligned to the execution plan.

### Step A - Reconcile and land already-built work

1. Create a branch from current `main`.
2. Port changes from `/Users/aidannugent/.config/superpowers/worktrees/polymarket-bot-test/feature-hosted-multitenant`.
3. Validate locally with `npm run build` and `npm test`.
4. Open PR with phase-labeled commit breakdown.

Why first:
- This converts "exists in another worktree" into "verified in mainline branch."

### Step B - Close remaining code phases not blocked by external credentials

1. Phase 0a/1/2/3 cleanup gaps after merge conflict resolution.
2. Phase 3b hardening completion:
   - global limiter validation,
   - fairness behavior checks,
   - idempotency/duplicate handling validation,
   - heartbeat verification/documentation,
   - sqlite contention checks.
3. API contract hardening for later UI/admin phases.

### Step C - Pre-auth admin/monitoring backend shape

1. Finalize admin-safe backend endpoints for system health/trade visibility.
2. Keep all auth-provider-specific behavior behind clear interfaces so Auth0 wiring is fast once credentials arrive.

---

## 4) Go/No-Go Evidence Pack Template (Pre-assembled)

Use this checklist template per deployment run.

### A) Build and test

- Commit/PR:
- `npm run build` output:
- `npm test` output:

### B) Networking and TLS

- DNS resolution proof (`dig`/`nslookup`):
- HTTPS certificate proof:
- Reverse proxy config reference:

### C) Service health

- App service `systemctl status`:
- Discovery worker `systemctl status`:
- Reboot persistence validation:

### D) Egress gate

- VPS `npm run validate:egress` full output:
- Pass/fail result:
- If fail, fallback provider rerun output:

### E) Tenant safety and runtime behavior

- Tenant isolation regression test results:
- Multitenant concurrent trade execution verification results:
- Admin/monitoring visibility checks:

### F) Data durability

- Backup timer/service logs:
- Sample backup archive listing:
- Restore drill command + app startup validation:

### G) Rollback readiness

- Rollback steps documented:
- Rollback test result:

---

## 5) Decision Checkpoints (Must be explicit)

| Checkpoint | Decision owner | Required decision | Current state |
| --- | --- | --- | --- |
| Branch reconciliation path | Engineering + Aidan | Confirm how isolated worktree changes are merged into a normal PR branch | Open |
| Auth0 configuration inputs | Aidan + Engineering + Tech Team | Finalize Auth0 domain, client IDs, callback/logout URLs, token claim strategy for `tenantId` | Open |
| Production hostname mapping | Tech Team + Deploy Operator | Confirm final production hostnames and DNS records for TLS issuance | Open |
| Live environment target | Aidan + Deploy Operator | Confirm first live target (Hetzner region/IP) and fallback provider criteria | Partially known (Hetzner IP known) |

---

## 6) Immediate Next Command-Level Sequence

1. Reconcile worktree into integration branch and open PR.
2. Verify build/tests on that branch.
3. Start infra owner evidence collection in parallel (Hetzner + DNS).
4. Once DNS and SSH are confirmed, execute VPS runtime/deploy steps.
5. Collect Phase 8 evidence pack and run go/no-go review.
