# Disk budget and ENOSPC runbook

## Targets

- Production root filesystem should stay **≥20% free**.
- `/health` reports `disk.status`: `ok`, `degraded`, or `critical`.
- Admin saves return HTTP **507** with `DISK_FULL` when the disk guard blocks writes.

## What consumes space

| Path | Notes |
|------|--------|
| `data/copytrade.db` + `-wal` / `-shm` | SQLite WAL can grow under write load; checkpoint on pressure |
| `data/*.tmp` | Orphan atomic-write temps; cleaned at startup |
| `/var/log/journal` | Cap with `journalctl --vacuum-size=200M` and systemd drop-in |
| `data.backup-*` | Safe to delete after verifying current `data/` is healthy |
| Discovery worker | Stop/disable when `DISCOVERY_ENABLED=false` |

## systemd journal cap (recommended)

Create `/etc/systemd/journald.conf.d/ditto.conf`:

```ini
[Journal]
SystemMaxUse=200M
```

Then: `sudo systemctl restart systemd-journald`

## Emergency cleanup (production)

```bash
df -h /
sudo systemctl stop polymarket-discovery-worker.service
sudo journalctl --vacuum-size=200M
rm -rf /opt/polymarket-bot/data.backup-*
sudo systemctl restart polymarket-app.service
df -h /
```

**Never** run `VACUUM` on SQLite while the disk is full — free space first, stop the app, then vacuum if needed.

## Monitoring

```bash
curl -s https://ditto.jungle.win/health | jq .
```

Watch `disk.usedPercent` and `disk.status`. At **≥90%** the dashboard shows an admin warning banner.

## Code hooks

- `src/diskGuard.ts` — preflight before JSON writes; disk metrics for `/health`
- `src/diskMaintenance.ts` — automated cleanup (stale backups, retention, WAL, VACUUM)
- `scripts/disk-maintenance.sh` — hourly systemd/cron maintenance script
- `src/jungleAgentsStore.ts` — single-save bulk updates
- `src/index.ts` + `src/discovery/discoveryWorker.ts` — startup + scheduled maintenance

## Automated prevention (deploy once)

```bash
# Journal size cap
sudo cp deploy/systemd/journald-ditto.conf /etc/systemd/journald.conf.d/ditto.conf
sudo systemctl restart systemd-journald

# Hourly maintenance timer
sudo cp deploy/systemd/polymarket-disk-maintenance.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now polymarket-disk-maintenance.timer
```

After deploy, the app also runs maintenance every 15 minutes (`DISK_MAINTENANCE_INTERVAL_MS`).

## Staging discovery worker

Ensure staging `DATA_DIR` points at the attached volume (`/mnt/HC_Volume_*/polymarket-staging-data`), then restart:

```bash
sudo systemctl restart polymarket-discovery-worker-staging.service
```

Stale `data.bak-on-root` on `/opt/polymarket-bot-staging` is safe to delete once the worker is stopped.
