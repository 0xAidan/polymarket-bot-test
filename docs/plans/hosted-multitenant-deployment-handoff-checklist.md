# Hosted Multi-Tenant Deployment Handoff Checklist

Use this as the single execution sheet for launching the hosted multi-tenant system.

- Primary architecture source: `docs/plans/hosted-multitenant-enterprise-implementation-plan.md`
- Primary execution source: `docs/plans/hosted-multitenant-execution-plan.md`
- This file: owner-assigned rollout checklist with required proof.

---

## Owners

- **Aidan (Hetzner Owner)**: server provisioning, access, firewall, infra approvals
- **Tech Team (Domain/DNS Owner)**: DNS/domain setup and routing
- **Engineering (Repo/Implementation Owner)**: code implementation, tests, release artifacts
- **Deploy Operator (Aidan or delegated engineer)**: server setup, service install, go-live commands

---

## Current Snapshot

- Hetzner target selected: **Helsinki / CCX13 / 8GB RAM / 80GB disk**
- Current server IPv4: **46.62.231.173**
- In-repo status:
  - Dome removal: complete
  - Core multi-tenant isolation: in progress
  - OIDC/admin/monitoring phases: pending

---

## Phase 1 - Infrastructure and Access

### 1.1 Server Confirmed
- **Owner:** Aidan
- **Action:** Confirm server exists with target spec and static public IP.
- **Acceptance Criteria:** Server visible in Hetzner with expected plan and IP.
- **Evidence Required:** Screenshot of Hetzner server overview showing region/spec/IP.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 1.2 SSH Access Established
- **Owner:** Aidan
- **Action:** Ensure key-based SSH works for root or deploy user.
- **Acceptance Criteria:** Successful shell login from approved workstation.
- **Evidence Required:** Terminal output showing successful `ssh <user>@46.62.231.173`.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 1.3 Network Security Baseline
- **Owner:** Aidan
- **Action:** Attach Hetzner firewall with inbound ports **22, 80, 443** only.
- **Acceptance Criteria:** Public app port (for Node internals) is not exposed.
- **Evidence Required:** Screenshot/export of firewall rules and attachment to server.
- **Status:** [ ] Not started [ ] In progress [ ] Done

---

## Phase 2 - Domain and TLS Routing

### 2.1 DNS Record Created
- **Owner:** Tech Team
- **Action:** Point production host (`@` or subdomain) A record to `46.62.231.173`.
- **Acceptance Criteria:** Public resolution returns server IP.
- **Evidence Required:** DNS panel screenshot + `dig`/`nslookup` output.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 2.2 TLS Reachability Prepared
- **Owner:** Tech Team + Deploy Operator
- **Action:** Ensure ports 80/443 are reachable for certificate issuance.
- **Acceptance Criteria:** ACME challenge can complete once Caddy/nginx is up.
- **Evidence Required:** Reachability check output or successful cert issuance logs.
- **Status:** [ ] Not started [ ] In progress [ ] Done

---

## Phase 3 - Server Runtime Installation

### 3.1 Runtime Dependencies Installed
- **Owner:** Deploy Operator
- **Action:** Install Node, npm, git, Caddy (or nginx), sqlite tools, systemd units support.
- **Acceptance Criteria:** Commands available and versions validated.
- **Evidence Required:** Command output for `node -v`, `npm -v`, `git --version`, `caddy version`.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 3.2 Directory Layout Created
- **Owner:** Deploy Operator
- **Action:** Create app and data directories.
  - App: `/opt/polymarket/app`
  - Data: `/var/lib/polymarket/data`
- **Acceptance Criteria:** Directories exist with correct ownership and write permissions.
- **Evidence Required:** `ls -ld /opt/polymarket/app /var/lib/polymarket/data`.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 3.3 Repo Deployed to Server
- **Owner:** Deploy Operator
- **Action:** Clone/update repo in app directory, install deps, build.
- **Acceptance Criteria:** Build succeeds without errors.
- **Evidence Required:** Output of dependency install and `npm run build`.
- **Status:** [ ] Not started [ ] In progress [ ] Done

---

## Phase 4 - Environment and Secrets

### 4.1 Server Environment Configured
- **Owner:** Deploy Operator + Engineering
- **Action:** Create production `.env` with server-level vars (PORT, `DATA_DIR`, OIDC vars, CORS allowlist, API URLs, and required runtime config).
- **Acceptance Criteria:** App starts with env loaded and no missing required vars.
- **Evidence Required:** Startup logs showing successful config validation (without exposing secrets) plus a redacted `.env` excerpt proving `DATA_DIR` points to the hosted path instead of repo-relative storage.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 4.2 Secret Ownership and Rotation Defined
- **Owner:** Aidan
- **Action:** Document who can set/rotate sensitive values (wallet credentials, API credentials, OIDC secret).
- **Acceptance Criteria:** Named owners and rotation procedure recorded.
- **Evidence Required:** Short written SOP in team docs.
- **Status:** [ ] Not started [ ] In progress [ ] Done

---

## Phase 5 - Services, Backups, and Health

### 5.1 Systemd Services Installed and Enabled
- **Owner:** Deploy Operator
- **Action:** Install and enable app + discovery worker services.
- **Acceptance Criteria:** Services auto-start on boot and remain healthy.
- **Evidence Required:** `systemctl status` and `systemctl is-enabled` outputs.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 5.2 Reverse Proxy and HTTPS Live
- **Owner:** Deploy Operator
- **Action:** Configure Caddy/nginx reverse proxy from HTTPS to app service.
- **Acceptance Criteria:** Domain serves app over valid HTTPS certificate.
- **Evidence Required:** Browser proof + TLS check output/certificate details.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 5.3 Backup Policy Active
- **Owner:** Deploy Operator
- **Action:** Configure scheduled backups for data directory and verify retention.
- **Acceptance Criteria:** Backup job runs successfully and creates recoverable artifacts.
- **Evidence Required:** Timer/service logs + sample backup archive listing.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 5.4 Restore Drill Completed
- **Owner:** Deploy Operator + Engineering
- **Action:** Perform one test restore to a non-production location.
- **Acceptance Criteria:** Restored data can be read and app starts against restored snapshot.
- **Evidence Required:** Restore command log + validation output.
- **Status:** [ ] Not started [ ] In progress [ ] Done

---

## Phase 6 - Mandatory Technical Gates

### 6.1 Egress Validation Gate
- **Owner:** Deploy Operator
- **Action:** Run `npm run validate:egress` from the VPS.
- **Acceptance Criteria:** Validation passes for required Polymarket connectivity checks.
- **Evidence Required:** Full command output saved to deployment notes.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 6.2 Provider Fallback if Egress Fails
- **Owner:** Aidan + Deploy Operator
- **Action:** If gate fails, reprovision in alternate approved provider/region and rerun gate.
- **Acceptance Criteria:** Final production target has a passing egress result.
- **Evidence Required:** Failure output + new environment pass output.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 6.3 Tenant Isolation Verification Gate
- **Owner:** Engineering + Deploy Operator
- **Action:** Run the full checklist in `docs/plans/tenant-isolation-verification-checklist.md` against the exact release candidate build and hosted environment.
- **Acceptance Criteria:** Every API, UI, and runtime guardrail check passes for two different tenants with different wallet data.
- **Evidence Required:** Saved request/response proof, screenshots for both tenants, and log excerpts showing blocked fallback attempts only.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 6.4 Staging Preview Gate
- **Owner:** Engineering + Deploy Operator
- **Action:** Update `staging.ditto.jungle.win` using `docs/plans/staging-update-handoff.md`, then run a browser review on the staged release candidate before promoting anything to production.
- **Acceptance Criteria:** Staging serves the release candidate branch, `/health` and `/health/ready` return successfully, Auth0 login works, and production services remain untouched.
- **Evidence Required:** `git rev-parse HEAD`, service status output for `polymarket-app-staging.service`, `curl https://staging.ditto.jungle.win/health`, `curl https://staging.ditto.jungle.win/health/ready`, and review screenshots.
- **Status:** [ ] Not started [ ] In progress [ ] Done

---

## Phase 7 - Application Completion (Repo Side)

### 7.1 Finish Remaining Multi-Tenant Implementation
- **Owner:** Engineering
- **Action:** Complete pending repo tasks from execution plan phases still open.
- **Acceptance Criteria:** Plan task scope implemented with tests/build passing.
- **Evidence Required:** PR(s), test output, and build output.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 7.2 OIDC/Auth0 Integration
- **Owner:** Engineering + Aidan (credentials) + Tech Team (callback domains)
- **Action:** Wire Auth0/OIDC backend and frontend login flow with tenant scoping.
- **Acceptance Criteria:** Login works end-to-end on production domain.
- **Evidence Required:** Successful login test + config verification checklist.
- **Status:** [ ] Not started [ ] In progress [ ] Done

### 7.3 Admin Controls and Monitoring UI
- **Owner:** Engineering
- **Action:** Deliver admin functions (tenant controls) and monitoring views (trade/system health) from plan.
- **Acceptance Criteria:** Admin can manage tenant state and observe operational health in dashboard.
- **Evidence Required:** UI screenshots + API verification output.
- **Status:** [ ] Not started [ ] In progress [ ] Done

---

## Phase 8 - Go/No-Go Checklist

- **Owner:** All
- **Rule:** Do not declare production ready unless all boxes below are true.

- [ ] DNS resolves correctly to production IP
- [ ] HTTPS valid on production domain
- [ ] App service healthy and persistent across reboot
- [ ] Discovery worker healthy and persistent across reboot
- [ ] Egress validation passes on production VPS
- [ ] Multi-tenant isolation tests pass in current release
- [ ] `docs/plans/tenant-isolation-verification-checklist.md` passed on the release candidate build
- [ ] Staging preview gate passed on the exact release candidate before production promotion
- [ ] Hosted `DATA_DIR` points at a server-owned path, not a repo-relative folder
- [ ] Auth login works and maps to tenant context correctly
- [ ] Admin panel can view/manage required controls
- [ ] Trade detection/execution visibility is available in monitoring UI
- [ ] Backups run automatically and restore drill has passed
- [ ] Rollback steps documented and tested

**Evidence Pack Required for Go-Live Approval**
- Link to deployed commit/PR
- Test/build outputs
- Egress validation output
- Tenant isolation checklist evidence pack
- Service status outputs
- TLS proof
- Backup + restore proof

---

## Immediate Next Actions (From Today)

1. **Aidan:** confirm server OS and SSH method works.
2. **Tech Team:** create DNS A record to `46.62.231.173`.
3. **Deploy Operator:** complete runtime install and service bring-up once DNS is in place.
4. **Engineering:** continue repo implementation (OIDC/admin/monitoring phases) and ship PRs.

