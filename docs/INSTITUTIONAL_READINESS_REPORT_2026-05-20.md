# Institutional Staging Readiness — 2026-05-20

**URL:** https://staging.ditto.jungle.win  
**Server:** Hetzner `/opt/polymarket-bot-staging` (port 3005)  
**Report time (UTC):** 2026-05-20 ~04:35

## Executive summary

| Area | Status | Notes |
|------|--------|-------|
| A. Staging site | **YELLOW** | HTTPS 200, Ditto UI live, OIDC configured; Discovery v3 scores at `/discovery-v3/`; Olympics admin in Diagnostics (login required) |
| B. Data & scoring | **YELLOW** | Activity lag ~11h; gap dedup done; full `04→05→06→verify` **running in tmux** (snapshots were empty after interrupted 05) |
| C. Repo & deploy | **YELLOW** | Deployed from `feature/improve-discovery-scoring` + Ditto `public/` overlay; **not yet merged to `main`** (no `gh` auth on server) |
| D. Ops | **GREEN** | Both systemd units configured; discovery worker stopped during DuckDB writes; no stray gap tmux |

**Overall: YELLOW** — Owner can log in and demo UI + Discovery v3 leaderboard tonight; validator **18/20** pending pipeline completion.

---

## A. Staging site checklist

| Check | Status | Evidence |
|-------|--------|----------|
| HTTPS 200 | ✅ | `curl -I https://staging.ditto.jungle.win` → HTTP/2 200 |
| Institutional UI (not Win95) | ✅ | `public/index.html` title "Ditto - Jungle Copy Trading", `jungle-brand.css` |
| OIDC | ✅ | `.env`: `AUTH_MODE=oidc`, `AUTH0_BASE_URL=https://staging.ditto.jungle.win` |
| Discovery v3 scores in UI | ✅ | `/discovery-v3/` + API `GET /api/discovery/v3/tier/alpha?limit=2` returns wallets with `brierScore`, pillars |
| Olympics admin (9 agents) | ✅ | Diagnostics → **Agent Olympics Admin**; API `GET/PUT /api/olympics/agents` (auth required) |
| `/health` | ✅ | `curl http://127.0.0.1:3005/health` → `{"status":"ok"}` |
| systemd | ✅ | `polymarket-app-staging` active; worker stopped during pipeline (intentional) |

### Login steps (owner)

1. Open https://staging.ditto.jungle.win  
2. Click through Auth0 login (Google/email per tenant config).  
3. **Discovery v3:** Discovery tab → **Open Discovery v3** button, or go directly to https://staging.ditto.jungle.win/discovery-v3/  
4. **Olympics:** Settings area → **Diagnostics** tab → **Agent Olympics Admin** → edit names, leave wallets blank until verified → **Save Roster**.

### Auth0 callbacks to confirm in dashboard

- Allowed Callback URLs: `https://staging.ditto.jungle.win/auth/callback`  
- Allowed Logout URLs: `https://staging.ditto.jungle.win`  
- Allowed Web Origins: `https://staging.ditto.jungle.win`

---

## B. Data & scoring

| Metric | Value |
|--------|-------|
| DuckDB activity rows | ~1.02B (pre-dedup); gap window rows 3.4M → **2.33M** after dedup |
| Activity `max_ts` | 2026-05-19 17:14 UTC (~**11h lag**) |
| Feature snapshots | **0** at 04:33 UTC (interrupted 05 after 04 `DELETE`; **04 re-run in progress**) |
| SQLite `discovery_wallet_scores_v3` | 1500 rows; 1500 with `brier_score`; **76** with `composite_score` (pre-rebuild) |
| Last `verify:pnl:full` | **10/20** (pre-dedup; outlier gap notionals + duplicates) |
| Last `06_validate` | Not re-run after dedup yet |

**In progress (tmux `overnight`):** `run_pipeline_after_gap.sh` → `04_emit_snapshots` → `05_score_and_publish` → `06_validate` → `verify:pnl:full` → build → restart.

**Gap dedup:** `scripts/backfill/dedup_gap_activity.ts` removed ~1.07M duplicate gap rows and rows with `usd_notional > $250k` (API garbage sizes).

---

## C. Repo & deploy

- **Branch on server:** `feature/improve-discovery-scoring` with Ditto UI files from `origin/feature/ditto-jungle-preview` (`public/`).  
- **Added tonight:** `src/api/olympicsRoutes.ts`, `scripts/backfill/dedup_gap_activity.ts`, Olympics admin UI, Discovery v3 link.  
- **Merge to `main`:** Not completed on server (no GitHub CLI login). Recommend PR from `feature/improve-discovery-scoring` after pipeline GREEN.

**Deploy command used:** `bash scripts/deploy-staging.sh`

---

## D. Ops

- **Disk:** `/mnt/HC_Volume_105468668` ~73% used (~78G free)  
- **Logs:** `/tmp/overnight_pipeline.log`, `/tmp/pipeline_after_gap.log`  
- **Gap tmux:** None (`gapapi*` stopped)  
- **After pipeline:** `sudo systemctl start polymarket-discovery-worker-staging`

---

## Merges / branches (tonight)

| Action | Detail |
|--------|--------|
| Intended integration | `feature/improve-discovery-scoring` + Ditto UI + gap scripts |
| Not merged | `feature/ditto-jungle-preview` full merge (conflicts in `copyTrader`, `package.json`) — UI via selective `public/` checkout instead |
| Remote gap branch | `feature/staging-gap-fill-fast-path` **not found** on origin (scripts kept locally untracked) |

---

## Owner-only follow-ups

1. Confirm Auth0 callback URLs (above).  
2. Wire verified wallet addresses into Olympics admin when ready (never invent).  
3. Review PR / merge to `main` when validators ≥ 18/20.  
4. If `04` fails overnight, check `/tmp/pipeline_after_gap.log` and disk space.

---

## How to re-check in the morning

```bash
tmux attach -t overnight   # or: tail -f /tmp/pipeline_after_gap.log
curl -sf http://127.0.0.1:3005/health
curl -s "http://127.0.0.1:3005/api/discovery/v3/tier/alpha?limit=1" | head -c 400
sudo systemctl is-active polymarket-app-staging polymarket-discovery-worker-staging
```

Look for `SUMMARY: 18/20` or higher in the log after `verify:pnl:full`.
